/**
 * LLM leaf summarizer for `dsh-compaction-lcm`.
 *
 * Where `dsh-compaction-lcm` runs a deterministic compiler (zero model
 * calls, verbatim excerpts), this backend asks the model for a real summary —
 * the LCM paper's "recursive context compression" leaf step. The summary is
 * NOT the only copy: every shadowed node stays in the append-only session log,
 * and the checkpoint carries `seq N` pointers so `lcm_expand` can restore the
 * exact original tokens.
 *
 * The prompt is deliberately structured to minimise loss:
 *   - it states the budget, so the model knows how hard to compress
 *   - it demands a fixed section skeleton (decisions / state / open threads /
 *     verbatim anchors) instead of free-form prose
 *   - it requires verbatim retention of identifiers the agent will need later
 *     (paths, commands, error strings, ids) — the single largest source of
 *     post-compaction failure in summarisation backends
 *
 * @module dsh-compaction-lcm/summarize
 */
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";

/** Section skeleton the summary must follow. */
export const SUMMARY_SKELETON = [
  "## 目标与约束",
  "## 已完成",
  "## 关键事实（逐字保留）",
  "## 未决问题",
  "## 下一步"
];

/** Verbatim-anchor instruction: the anti-loss clause. */
const ANCHOR_RULE =
  "关键事实一节必须逐字保留后续还可能用到的标识符：文件路径、命令、URL、错误串、ID、函数/变量名、数值阈值。不要改写、不要翻译、不要概括这些字符串。";

/**
 * Build the compaction instruction appended as the final user message.
 * @param budgetTokens - token ceiling for the produced summary.
 * @param shadowedTokens - tokens being replaced (for the compression target).
 * @param priorDepth - depth of the highest absorbed checkpoint (0 = none).
 * @returns the instruction text.
 */
export function buildInstruction(budgetTokens, shadowedTokens, priorDepth) {
  const ratio = shadowedTokens > 0 ? (shadowedTokens / Math.max(1, budgetTokens)).toFixed(1) : "?";
  return [
    "You are condensing an earlier span of THIS conversation so the agent can keep working.",
    "",
    `The span you are given is ${shadowedTokens} tokens. Produce at most ${budgetTokens} tokens (about ${ratio}:1).`,
    "The full original text is preserved in the append-only log and remains retrievable by the agent, so you may compress hard — but anything the agent will need *verbatim* must survive here.",
    "",
    "Write exactly these sections, in this order:",
    ...SUMMARY_SKELETON.map((h) => `  ${h}`),
    "",
    ANCHOR_RULE,
    "",
    "Rules:",
    "- Do not address the user. Do not say what you are doing. Output the sections only.",
    "- Do not invent facts. If something is uncertain, write it as uncertain.",
    "- Do not restate tool output that was pure noise (progress bars, repeated listings); keep its conclusion.",
    priorDepth > 0
      ? `- This span already absorbed a depth-${priorDepth} checkpoint. Fold its content into your sections; do not add a section for it.`
      : "- This span contains no prior checkpoint.",
    "",
    "Format the result as plain Markdown. Do not wrap it in a code fence."
  ].join("\n");
}

/**
 * Render one shadowed node for the summarizer input. Reuses the session's own
 * message projection so the summarizer sees exactly what the model saw.
 * @param session - session owning the events.
 * @param seq - surface seq of the node.
 * @returns the derived message, or null.
 */
function nodeMessage(session, seq) {
  const event = session.eventAt(seq);
  if (event === undefined) return null;
  return session.deriveEventMessage(event);
}

/**
 * Run one leaf summarization through `ctx.llm.stream()`.
 *
 * The conversation prefix (system head + the shadowed messages) is replayed
 * verbatim so the provider's warm prefix cache is reused, matching
 * `dsh-compaction-basic`. Only the final instruction message is new.
 *
 * @param ctx - context providing the LLM service.
 * @param config - resolved engine configuration.
 * @param prepared - priced selection snapshot from `region.prepareCompaction`.
 * @param agent - supplies the routed model and session.
 * @param budgetTokens - summary token ceiling.
 * @param signal - cancellation forwarded to the adapter.
 * @returns summary blocks plus provenance and usage.
 */
export async function summarizeLeaf(ctx, config, prepared, agent, budgetTokens, signal) {
  signal?.throwIfAborted();
  const { session } = prepared;

  const regionMessages = [];
  for (const seq of prepared.shadowedSeqs) {
    const message = nodeMessage(session, seq);
    if (message !== null) regionMessages.push(message);
  }
  if (regionMessages.length === 0) throw new Error("lcm: selected span produced no model-visible messages");

  const header = session.requestHeader();
  const headSeq = session.surface.nodes[0];
  const headEvent = headSeq === undefined ? undefined : session.eventAt(headSeq);
  const system = headEvent === undefined ? null : session.deriveEventMessage(headEvent);

  const configured =
    config.summarizationProvider.length > 0
      ? { provider: config.summarizationProvider, model: config.summarizationModel }
      : undefined;
  const latest = header?.config;
  const agentTarget =
    agent.options?.provider !== undefined &&
    agent.options.provider.length > 0 &&
    agent.options.model !== undefined &&
    agent.options.model.length > 0
      ? { provider: agent.options.provider, model: agent.options.model }
      : undefined;
  const target = configured ?? latest ?? agentTarget;
  if (target === undefined) {
    throw new Error(
      "lcm: no provider/model available for summarization — set summarizationProvider+summarizationModel, route one request first, or set both AgentOptions fields"
    );
  }

  const priorDepth = maxAbsorbedDepth(session, prepared.shadowedSeqs);
  const instruction = createUserMessage({
    content: [
      {
        type: "text",
        text: buildInstruction(budgetTokens, prepared.shadowedTokenCount, priorDepth)
      }
    ]
  });

  const messages = system === null ? [...regionMessages, instruction] : [system, ...regionMessages, instruction];
  const assembler = new BlockAssembler();
  const options = {
    provider: target.provider,
    model: target.model,
    messages,
    ...(header?.tools === undefined ? {} : { tools: [...header.tools] }),
    maxTokens: budgetTokens,
    sessionId: session.id,
    purpose: "compaction",
    ...(signal === undefined ? {} : { signal })
  };
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
  const finish = assembler.finish;
  if (finish.kind === "error" || finish.kind === "aborted") throw finish.failure;
  if (finish.kind === "max-tokens") {
    const truncated = new Error("lcm: summary truncated at the token cap (incomplete checkpoint)");
    truncated.code = "MAX_TOKENS";
    throw truncated;
  }

  const raw = assembler.blocks();
  const text = raw
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (text.length === 0) throw new Error("lcm: summarization produced no text content");

  return {
    summary: [{ type: "text", text }],
    rawOutput: raw,
    provider: options.provider,
    model: options.model,
    maxTokens: budgetTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage })
  };
}

/**
 * Highest depth among checkpoint nodes inside one shadowed span.
 * @param session - session owning the events.
 * @param shadowedSeqs - seqs being replaced.
 * @returns depth of the deepest absorbed checkpoint, 0 when none.
 */
export function maxAbsorbedDepth(session, shadowedSeqs) {
  const { nodeBySeq } = deriveDag(session);
  let depth = 0;
  for (const seq of shadowedSeqs) {
    const node = nodeBySeq.get(seq);
    if (node !== undefined && node.depth > depth) depth = node.depth;
  }
  return depth;
}

/**
 * Derive the summary DAG from the durable log.
 *
 * A checkpoint node is a surface `user/message` whose source is a compact
 * checkpoint. Its children are the checkpoint nodes among the `shadowedSeqs`
 * recorded on the owning `compaction/summary` event. Depth is 1 for a leaf
 * checkpoint (absorbed only raw messages) and 1+max(child depth) otherwise.
 *
 * Derivation is pure: no side store, no migration, rebuildable after any
 * restart. `appendPluginRecord` is deliberately unused — it is limited to
 * `packages/experimental/` and its records are best-effort across migrations.
 *
 * @param session - session supplying the log.
 * @returns checkpoint nodes keyed by their surface seq, plus depth statistics.
 */
export function deriveDag(session) {
  const nodeBySeq = new Map();
  const summaries = [];
  for (const event of session.events ?? []) {
    if (event.type === "compaction/summary") summaries.push(event);
  }
  // A compaction/summary is immediately followed by its replacement message.
  const seqToShadowed = new Map();
  for (const summary of summaries) {
    const shadowed = summary.data?.shadowedSeqs ?? [];
    for (const seq of shadowed) seqToShadowed.set(seq, shadowed);
    // The replacement node is the next surface user/message after the summary.
    const next = session.events[summary.seq + 1];
    if (next !== undefined && next.type === "user/message" && isCheckpoint(next.data?.source)) {
      nodeBySeq.set(next.seq, {
        seq: next.seq,
        compactionId: summary.data?.compactionId,
        children: shadowed,
        shadowedTokenCount: summary.data?.shadowedTokenCount ?? 0,
        depth: 1
      });
    }
  }
  // Resolve depth by walking children upward; cycle-safe via the visit set.
  const resolveDepth = (seq, visiting) => {
    const node = nodeBySeq.get(seq);
    if (node === undefined) return 0;
    if (node.depth > 1) return node.depth;
    if (visiting.has(seq)) return 1;
    visiting.add(seq);
    let depth = 1;
    for (const child of node.children) {
      const childNode = nodeBySeq.get(child);
      if (childNode === undefined) continue;
      depth = Math.max(depth, resolveDepth(child, visiting) + 1);
    }
    visiting.delete(seq);
    node.depth = depth;
    return depth;
  };
  for (const seq of nodeBySeq.keys()) resolveDepth(seq, new Set());
  let maxDepth = 0;
  for (const node of nodeBySeq.values()) if (node.depth > maxDepth) maxDepth = node.depth;
  return { nodeBySeq, maxDepth, checkpoints: nodeBySeq.size };
}

/** Whether one message source marks a compaction checkpoint. */
function isCheckpoint(source) {
  return source !== undefined && source !== null && source.kind === "compact-checkpoint";
}
