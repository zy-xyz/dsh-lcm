// SNAPSHOT of src/summarize.js at commit accfa79 (git HEAD before the ACON loop).
// Import paths rewritten for bench/snapshots/. Immutable input to bench/acon-loop.mjs.
/**
 * LLM leaf summarizer for `dsh-lcm`.
 *
 * This is the replacement step `dsh-lcm` uses: a model-written
 * summary, descended from `dsh-compaction-instant`'s deterministic compiler
 * (zero model calls, verbatim excerpts) — the LCM paper's "recursive context compression" leaf step. The summary is
 * NOT the only copy: every shadowed node stays in the append-only session log,
 * and the checkpoint carries `seq N` pointers so `lcm_expand` can restore the
 * exact original tokens.
 *
 * The prompt is deliberately structured to minimise loss:
 *   - it states a TARGET length (never a request cap — no `maxTokens` is sent,
 *     because a summary-sized completion budget is spent entirely on hidden
 *     reasoning by reasoning-first backends), so the model knows how hard to
 *     compress without risking a truncated answer
 *   - it demands a fixed section skeleton (decisions / state / open threads /
 *     verbatim anchors) instead of free-form prose
 *   - it requires verbatim retention of identifiers the agent will need later
 *     (paths, commands, error strings, ids) — the single largest source of
 *     post-compaction failure in summarisation backends
 *
 * @module dsh-lcm/summarize
 */
import { BlockAssembler, LlmError, createUserMessage } from "@deepseek-ai/dsh-llm";
import { resolveTargetPolicy } from "../../src/config.js";
import { resolveEventAt, sessionEvents } from "../../src/events.js";
import { renderEventBody } from "../../src/compiler.js";
import { engineDebug } from "../../src/debug.js";

/**
 * Section skeleton the summary must follow.
 *
 * The anchor list is FIRST on purpose. A summary is often truncated to fit a
 * budget, and truncation cuts from the tail: when the anchors were last, a
 * budgeted summary kept the narrative and lost exactly the part that carries
 * fidelity (measured: 0/14 anchors at a 516-token ceiling, versus 2/14 for the
 * built-in backend). Anchors first inverts that: truncation now costs prose,
 * which is the cheap thing to lose.
 */
export const SUMMARY_SKELETON = [
  "## 逐字锚点",
  "## 目标与约束",
  "## 已完成",
  "## 未决问题",
  "## 下一步"
];

/**
 * Verbatim-anchor instruction: the anti-loss clause.
 *
 * The anchor section is an explicit ENUMERATION, not a prose instruction to
 * "remember the important strings". Asking a model to keep identifiers while
 * writing flowing bullets loses roughly half of them in practice; asking it to
 * emit a flat one-per-line list of everything it saw does not. Measured on a
 * real 9k-token span: the prose rule retained 40% of the auto-extracted
 * anchors, the enumerated rule retains materially more at the same budget.
 */
const ANCHOR_RULE = [
  "第一节「逐字锚点」不是散文，是一张清单：把这整段里出现过的所有文件路径、命令、URL、错误串、ID/uuid、函数或变量名、数值阈值，**每行一条，原样抄写**。",
  "不要合并同类项，不要翻译，不要改大小写，不要加解释，不要按重要性筛选 —— 只要出现过就列出来。",
  // Measured on 20 LongMemEval questions: with the old wording ("prefer long, cut
  // the later sections first") the anchor list reached 91% and 99.7% of one
  // checkpoint, and in the 99.7% case the other four sections were ABSENT. Those
  // four sections are what a resuming agent reads to know where it is, so the
  // instruction now protects them and asks for grouping instead of dropping.
  "后面四节**必须都有内容**：它们是接手的人读懂状态的地方，一节都不许省。",
  "如果锚点太多，**合并重复**（同一个路径反复出现只写一次），而不是删小节、也不是删掉锚点。"
].join("");

/**
 * Build the compaction instruction appended as the final user message.
 * @param budgetTokens - target length for the produced summary (a hint, not a cap:
 *   the request carries no `maxTokens`, so the provider's own default applies).
 * @param shadowedTokens - tokens being replaced (for the compression target).
 * @param priorDepth - depth of the highest absorbed checkpoint (0 = none).
 * @returns the instruction text.
 */
export function buildInstruction(budgetTokens, shadowedTokens, priorDepth) {
  const ratio = shadowedTokens > 0 ? (shadowedTokens / Math.max(1, budgetTokens)).toFixed(1) : "?";
  return [
    "You are condensing an earlier span of THIS conversation so the agent can keep working.",
    "",
    `The span you are given is ${shadowedTokens} tokens. Aim for roughly ${budgetTokens} tokens (about ${ratio}:1) — that is a target, not a hard limit, so do not cut a section short to hit it.`,
    "The full original text is preserved in the append-only log and remains retrievable by the agent, so you may compress hard — but anything the agent will need *verbatim* must survive here.",
    "",
    "Write exactly these sections, in this order:",
    ...SUMMARY_SKELETON.map((h) => `  ${h}`),
    "",
    ANCHOR_RULE,
    "",
    "顺序是硬性的：先写「逐字锚点」整张清单，再写后面四个叙述性小节。后面四节各自最多几句话 —— 它们的职责是让人读懂状态，「逐字锚点」才负责不丢东西。如果预算紧张，先砍叙述，不要砍清单。",
    "",
    "Rules:",
    // Without this the model calls a tool and returns NO text: the request
    // forwards the conversation own tool definitions (for prefix-cache reuse),
    // so a tool call is a legal completion and an inviting one. Measured on a
    // real engine: three consecutive attempts finished tool-calls with
    // reasoning + tool-call blocks and zero text, and the compaction failed.
    // basic states this rule explicitly; dropping it was the regression.
    "- Output only the checkpoint text. Do not call any tool, and do not take any other action.",
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
 * Convert one terminal `finish.failure` into the error this backend throws.
 *
 * `finish.failure` is `@deepseek-ai/dsh-llm`'s provider-neutral FAILURE SNAPSHOT:
 * a frozen plain object `{ message, code, ... }`, not an `Error` (see
 * `normalizeLlmFailure`). Throwing it as-is meant every downstream
 * `instanceof LlmError` routing check silently failed — most visibly the
 * `compaction/summary-error` listener in `dsh-compaction-image-offload`, which
 * matches on `error instanceof LlmError && error.code === IMAGE_OFFLOAD_REQUIRED_CODE`
 * and therefore never fired, turning a recoverable image-heavy region into a
 * hard compaction failure. `dsh-compaction-basic` re-wraps the same snapshot in
 * `LlmError`; this does the same and keeps the snapshot as `cause`.
 *
 * An actual `Error` is passed through untouched: it is already an `Error`, and
 * rebuilding it would discard its stack.
 *
 * @param failure - the terminal finish reason's failure snapshot.
 * @returns the value to throw.
 */
function summarizationFailure(failure) {
  if (failure instanceof Error) return failure;
  const message = typeof failure?.message === "string" && failure.message.length > 0 ? failure.message : "summarization request failed";
  const code = typeof failure?.code === "string" && failure.code.length > 0 ? failure.code : "UNKNOWN";
  // Spread first so the validated provider facts (`status`, `requestId`,
  // `providerRetryAfterMs`, `offloadImages`) reach `LlmError`, which re-freezes
  // them onto `error.failure`; `cause` then keeps the original snapshot.
  return new LlmError(message, code, { ...failure, cause: failure });
}

/**
 * The deterministic truncation failure: same prompt and same completion ceiling
 * reproduce it exactly, so it is thrown rather than retried.
 *
 * The ceiling here is the PROVIDER's own default — this backend no longer sends
 * `maxTokens` (see `summarizeLeaf`), so a `max-tokens` finish that already
 * carries text means the provider's default cut a real summary in half. That is
 * still deterministic and still an incomplete checkpoint, so it still throws.
 * @returns the error, tagged `MAX_TOKENS`.
 */
function maxTokensTruncation() {
  const error = new Error("lcm: summary truncated at the token cap (incomplete checkpoint)");
  error.code = "MAX_TOKENS";
  return error;
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
 * @param budgetTokens - target summary length named in the instruction. NOT a
 *   request cap: no `maxTokens` is sent, so the provider's own default applies.
 * @param signal - cancellation forwarded to the adapter.
 * @param instructionSuffix - extra text appended after the normal instruction.
 *   Used by exactly one caller path: `compile()`'s length retry, which restates
 *   the upper bound as a hard number after an over-long attempt. Omitted (and
 *   therefore byte-identical to the historical prompt) on every other attempt.
 * @returns summary blocks plus provenance and usage.
 */
export async function summarizeLeaf(ctx, config, prepared, agent, budgetTokens, signal, instructionSuffix) {
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
  // Only a `system/message` is the conversation head. When surface node 0 is any
  // other message (a session whose first node is a user turn), prepending it as
  // the "system" prefix ALSO leaves it inside `regionMessages`, so that message
  // reached the summarizer twice. `dsh-compaction-basic` gates on the event type
  // for the same reason; this is its rule, verbatim.
  const system = headEvent === undefined || headEvent.type !== "system/message" ? null : session.deriveEventMessage(headEvent);

  const latest = header?.config;
  const agentTarget =
    agent.options?.provider !== undefined &&
    agent.options.provider.length > 0 &&
    agent.options.model !== undefined &&
    agent.options.model.length > 0
      ? { provider: agent.options.provider, model: agent.options.model }
      : undefined;
  // Per-route policy: `summarizationProvider`/`summarizationModel` are POLICY
  // fields, so an exact-route `modelPolicies` row may point the summarizer at a
  // different model than the top-level default. Reading them off `config`
  // directly ignored that override entirely (a route configured to summarize
  // with its own model silently summarized with the global one). Resolve the
  // routed target first, then take the pair from its merged policy, exactly as
  // `dsh-compaction-basic`'s `summarize()` does.
  const conversationTarget =
    latest !== undefined && latest.provider.length > 0 && latest.model.length > 0
      ? { provider: latest.provider, model: latest.model }
      : agentTarget;
  const policy =
    conversationTarget === undefined || !Array.isArray(config.modelPolicies)
      ? config
      : resolveTargetPolicy(config, conversationTarget);
  const configured =
    policy.summarizationProvider.length > 0
      ? { provider: policy.summarizationProvider, model: policy.summarizationModel }
      : undefined;
  const target = configured ?? latest ?? agentTarget;
  if (target === undefined) {
    throw new Error(
      "lcm: no provider/model available for summarization — set summarizationProvider+summarizationModel, route one request first, or set both AgentOptions fields"
    );
  }

  const priorDepth = maxAbsorbedDepth(session, prepared.shadowedSeqs);
  // The instruction names a TARGET size, not a ceiling: the request carries no
  // `maxTokens` (see below), so nothing truncates the answer at this number.
  // It still earns its place — a model told "roughly 2400 tokens" writes a
  // 2400-token summary instead of a 400-token stub or a 40k-token transcript.
  const instructionText = buildInstruction(budgetTokens, prepared.shadowedTokenCount, priorDepth);
  const instruction = createUserMessage({
    content: [
      {
        type: "text",
        // The suffix goes LAST, after "Format the result as plain Markdown":
        // recency is where a correction lands hardest, and the over-long retry
        // is the only caller that passes one.
        text: typeof instructionSuffix === "string" && instructionSuffix.length > 0 ? `${instructionText}\n\n${instructionSuffix}` : instructionText
      }
    ]
  });
  const messages = system === null ? [...regionMessages, instruction] : [system, ...regionMessages, instruction];

  // No `maxTokens` is sent. Two measured reasons:
  //
  //   1. Reasoning-first backends bill hidden reasoning against the same
  //      completion budget, so a summary-sized cap is spent entirely on
  //      thinking and the response finishes `max-tokens` with ZERO text — a
  //      compression that fails for a reason the caller cannot fix.
  //   2. Model output lengths are not predictable enough to cap usefully: the
  //      anchor list alone varies by an order of magnitude across spans, so any
  //      fixed number is either a truncation or dead weight.
  //
  // Letting the provider apply its own default ceiling is the honest option:
  // the shrink guarantee in `region.compactSurfaceRegion` is what bounds this
  // transaction, and it is a post-hoc check that cannot be gamed by a cap.
  // `toolHistory` is what makes the replayed prefix a genuine prefix of the last
  // routed request: the adapter diffs the tool projection against it and sends only
  // the delta, so a request that omits it re-declares every tool and invalidates
  // the provider's warm prefix cache — the one reason this call replays the
  // conversation at all. `dsh-compaction-basic` passes the same field.
  //
  // Included only when the session actually exposes the projection: it always
  // exists on a real `Session`, and a session-shaped value without it (the
  // fixtures) simply sends the declaration set, which is correct for a session
  // that has no tool history to diff against.
  const options = {
    provider: target.provider,
    model: target.model,
    messages,
    ...(typeof session.toolHistory === "function" ? { toolHistory: session.toolHistory() } : {}),
    ...(header?.tools === undefined ? {} : { tools: [...header.tools] }),
    sessionId: session.id,
    purpose: "compaction",
    ...(signal === undefined ? {} : { signal })
  };

  // Retry policy. Two failures look alike on the wire (a finish chunk and
  // nothing usable) but mean different things:
  //
  //   empty — no text AND a clean finish: a sampling accident. Retried on the
  //           SAME prompt and route, because changing either would make the one
  //           reproducible failure unreproducible.
  //   max-tokens — the provider's OWN default ceiling cut the completion. WITH
  //           text that is deterministic truncation: an incomplete checkpoint,
  //           and a retry truncates identically at full price. WITHOUT text it
  //           is the empty case wearing the truncation finish reason, so it
  //           falls through to the empty-response retry below — which is the
  //           right handling, because there is no budget left to escalate.
  const emptyRetries = config.emptySummaryRetries;
  let attempts = 0;
  let raw;
  let produced = "";
  let usage;
  let finishKind;
  for (;;) {
    attempts += 1;
    signal?.throwIfAborted();
    const assembler = new BlockAssembler();
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
    const finish = assembler.finish;
    if (finish.kind === "error" || finish.kind === "aborted") throw summarizationFailure(finish.failure);
    finishKind = finish.kind;
    raw = assembler.blocks();
    produced = raw
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (finish.kind === "max-tokens" && produced.length > 0) throw maxTokensTruncation();
    if (produced.length > 0) {
      usage = assembler.usage;
      if (attempts > 1) engineDebug(config, `summarize empty-response retry succeeded attempt=${attempts}/${emptyRetries + 1} finish=${finish.kind}`);
      break;
    }
    engineDebug(
      config,
      `summarize empty-response attempt=${attempts}/${emptyRetries + 1} finish=${finish.kind} blocks=${raw
        .map((block) => block.type)
        .join(",") || "none"} target=${budgetTokens}`
    );
    if (attempts > emptyRetries) throw new Error("lcm: summarization produced no text content");
  }
  // Pointers are attributed here, after the model call and before the
  // checkpoint is wrapped: the summarizer input stays the verbatim span (the
  // prefix-cache constraint above), and an anchor that the span never contained
  // keeps no pointer at all.
  const text = config.anchorPointers === false
    ? produced
    : attributeAnchorPointers(produced, session, prepared.shadowedSeqs);

  return {
    summary: [{ type: "text", text }],
    rawOutput: raw,
    provider: options.provider,
    model: options.model,
    // No `maxTokens` is reported: none was sent, so recording one would claim a
    // cap the request never carried. `targetTokens` is what the instruction
    // asked the model to aim for, and what provenance should show instead.
    targetTokens: budgetTokens,
    finish: finishKind,
    ...(usage === undefined ? {} : { usage })
  };
}

/**
 * Section heading that opens the verbatim-anchor list.
 *
 * Matched loosely (any heading level, the exact phrase) because a model that
 * renames the heading still produced an anchor list, and dropping pointers for
 * the whole summary over one character would be the wrong trade.
 */
const ANCHOR_HEADING_RE = /^#{1,6}\s*逐字锚点/u;

/** A line that already carries a pointer the model copied out of a child checkpoint. */
const EXISTING_POINTER_RE = /\((?:seqs?\s+[\d,\s-]+)\)\s*$/u;

/** Bullet or ordered-list marker in front of one anchor. */
const BULLET_RE = /^(?:[-*+]|\d+[.)])\s+/u;

/** Any markdown heading, used to find the end of the anchor section. */
const HEADING_RE = /^#{1,6}\s/u;

/**
 * Render one event exactly as lexical search renders it, so a pointer found
 * here is a pointer lcm_search would have found too: same projection, same
 * bytes. Case folding happens once, inside the index.
 * @param session - session-shaped value.
 * @param seq - surface seq of the event.
 * @returns the rendered body, or undefined when the event is absent.
 */
function spanBody(session, seq) {
  const event = resolveEventAt(session, seq);
  if (event === undefined) return undefined;
  // Same renderer search uses, so an attributed pointer names the event that
  // lcm_search would have found for the same anchor.
  return renderEventBody(session, event).body;
}

/**
 * Build a one-pass, case-folded index over the shadowed span.
 *
 * Every event is rendered once and concatenated into a single haystack whose
 * per-event start offsets are recorded. One anchor then costs one indexOf over
 * the span plus one binary search, instead of one scan per anchor.
 *
 * Folding is applied per body before its offset is taken, so a body whose case
 * folding changes its length still leaves every later offset correct.
 * @param session - session-shaped value.
 * @param shadowedSeqs - seqs of the span being replaced.
 * @returns the haystack plus a first-occurrence lookup.
 */
function buildSpanIndex(session, shadowedSeqs) {
  const parts = [];
  const starts = [];
  const seqs = [];
  let cursor = 0;
  for (const seq of shadowedSeqs ?? []) {
    const body = spanBody(session, seq);
    if (body === undefined || body.length === 0) continue;
    const folded = body.toLowerCase();
    starts.push(cursor);
    seqs.push(seq);
    parts.push(folded);
    cursor += folded.length + 1;
  }
  const haystack = parts.join("\n");
  return {
    haystack,
    /**
     * First seq in the span whose rendered body contains the anchor verbatim.
     * @param anchor - literal anchor text.
     * @returns the owning seq, or undefined when the span never contained it.
     */
    lookup(anchor) {
      if (haystack.length === 0) return undefined;
      const at = haystack.indexOf(anchor.toLowerCase());
      if (at < 0) return undefined;
      let low = 0;
      let high = starts.length - 1;
      let found = seqs[0];
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (starts[mid] <= at) {
          found = seqs[mid];
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return found;
    }
  };
}

/**
 * Strip the presentation a model puts around one anchor and return the literal
 * text to attribute. Returns null for lines that carry no anchor.
 * @param line - one line of the summary.
 * @returns the anchor text, or null when the line should be left alone.
 */
function anchorTextOf(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  if (HEADING_RE.test(trimmed)) return null;
  if (EXISTING_POINTER_RE.test(trimmed)) return null;
  let anchor = trimmed.replace(BULLET_RE, "").trim();
  anchor = anchor.replace(/^`+([\s\S]*?)`+$/u, "$1").trim();
  if (anchor.length === 0) return null;
  return anchor;
}

/**
 * Append (seq N) to every verbatim anchor the span actually contained.
 *
 * The model is asked for anchor values, never for pointers: the summarizer
 * input is the verbatim span replayed to reuse the provider prefix cache (see
 * summarizeLeaf), so inserting seq markers into the input would break that
 * cache. Attribution therefore happens after the fact, deterministically,
 * against the same rendered bytes lcm_search searches.
 *
 * A line whose anchor does not appear verbatim in the span is returned
 * unchanged: the model may have rewritten it, and a guessed pointer would send
 * lcm_expand to the wrong event. An anchor with no pointer is honest
 * information — this string is not in the log as written.
 *
 * @param text - model-returned markdown.
 * @param session - session-shaped value owning the events.
 * @param shadowedSeqs - seqs of the span being replaced; nothing outside it is
 *   searched, because a seq outside the span is not in this checkpoint's scope.
 * @returns the markdown with (seq N) appended where attribution succeeded.
 */
export function attributeAnchorPointers(text, session, shadowedSeqs) {
  if (typeof text !== "string" || text.length === 0) return text;
  const lines = text.split("\n");
  const heading = lines.findIndex((line) => ANCHOR_HEADING_RE.test(line.trim()));
  if (heading < 0) return text;
  let sectionEnd = lines.length;
  for (let end = heading + 1; end < lines.length; end += 1) {
    if (HEADING_RE.test(lines[end].trim())) {
      sectionEnd = end;
      break;
    }
  }
  const index = buildSpanIndex(session, shadowedSeqs);
  if (index.haystack.length === 0) return text;
  for (let line = heading + 1; line < sectionEnd; line += 1) {
    const anchor = anchorTextOf(lines[line]);
    if (anchor === null) continue;
    const seq = index.lookup(anchor);
    if (seq === undefined) continue;
    lines[line] = lines[line].replace(/\s+$/u, "") + " (seq " + seq + ")";
  }
  return lines.join("\n");
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
  const events = sessionEvents(session);
  for (const event of events) {
    if (event.type === "compaction/summary") summaries.push(event);
  }
  // A compaction/summary is immediately followed by its replacement message.
  // Resolve by seq, never by array index: a persisted log starts with a header
  // record that has no `seq`, so `events[seq + 1]` is off by one on every file.
  for (const summary of summaries) {
    const shadowed = summary.data?.shadowedSeqs ?? [];
    const next = resolveEventAt(session, summary.seq + 1);
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
