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
 *   - it states a TARGET length, and the request carries a separate ceiling of
 *     `max(4096, 2 x target)`: reasoning-first backends bill hidden reasoning
 *     against the same number, so a ceiling equal to the target leaves the answer
 *     half-written, while no ceiling at all substitutes the provider's own smaller
 *     default and truncates silently
 *   - it demands a fixed section skeleton (decisions / state / open threads /
 *     verbatim anchors) instead of free-form prose
 *   - it requires verbatim retention of identifiers the agent will need later
 *     (paths, commands, error strings, ids) — the single largest source of
 *     post-compaction failure in summarisation backends
 *
 * @module dsh-lcm/summarize
 */
import { BlockAssembler, LlmError, createUserMessage } from "@deepseek-ai/dsh-llm";
import { resolveTargetPolicy } from "./config.js";
import { resolveEventAt, sessionEvents } from "./events.js";
import { renderEventBody } from "./compiler.js";
import { engineDebug } from "./debug.js";

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
  // Added after measuring that a value in the anchor list is NOT answerable by
  // itself. On 15 paired failures, two carried their gold in the anchor list
  // already ("10" on its own line; "30" and "minutes" on two lines) and the
  // answering model still said UNKNOWN: a bare value in a list of 250 does not
  // say what it counts. This section exists to hold facts as sentences.
  "## 用户事实",
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
  // Two measured facts shape this rule, and they pull in opposite directions:
  // (1) the enumeration IS a filter - on 15 paired failures the golds were 7
  //     numeric, 6 short prose, 2 long prose and ZERO identifiers, i.e. exactly
  //     the category the original list excluded, so the list must name those
  //     shapes;
  // (2) the section must stay a flat list of verbatim strings, because that is
  //     what makes it searchable. Widening it to hold facts as well turned it
  //     into Chinese prose sentences and destroyed that property.
  // Hence: name the shapes HERE, carry the facts as typed rows BELOW.
  // Measured regression: widening it to "every short fact as fact: value" turned
  // the section into Chinese prose sentences, which destroys the property the
  // section exists for - a string the agent can paste into lcm_search and get the
  // event back. Facts belong in the typed-row section below, not here.
  "第一节「逐字锚点」是**词表**，不是散文、不是句子。只收**原样可粘贴的字面串**，每行一条：文件路径、命令、URL、错误串、ID/uuid、函数名或变量名、键名、数值阈值、每个人名、地名、机构名、产品名、型号、每个数字连同它的单位（如 55 inch、30 minutes、$40、2023-05-30）。",
  "**保持原文语言，逐字抄写，不翻译、不改大小写、不加解释、不写成句子。** 这一节是给 lcm_search 用的检索词表；把事实写成句子是第二节的事。",
  // Bounded on purpose. Measured: without a bound the model wrote 11614 chars of
  // anchors and then stopped, producing ONE section and no facts at all. The bound
  // is justified rather than arbitrary: the log keeps every string and
  // lcm_search can find any of them, so an exhaustive list duplicates the log and
  // crowds out the part of the checkpoint that search cannot recover - the typed
  // facts. lcm-x bounds its own extraction the same way (100 assertions per
  // source, 24000 chars of source).
  "**最多 120 行**。超过就按「唯一性优先、具体优先」取舍：只出现一次的字面串比出现几百次的通用词值钱；同一个串重复出现只写一次。宁可少列，也要保证后面每一节都写出来。",
  // Measured on 20 LongMemEval questions: with the old wording ("prefer long, cut
  // the later sections first") the anchor list reached 91% and 99.7% of one
  // checkpoint, and in the 99.7% case the other four sections were ABSENT. Those
  // four sections are what a resuming agent reads to know where it is, so the
  // instruction now protects them and asks for grouping instead of dropping.
  // The row format is borrowed from lcm-x's assertion store (assertion_store.py:
  // ASSERTION_KINDS). It is a typed row, not a sentence, because the failures it
  // targets need a slot each: a count needs its unit and what it counts, an
  // ordering needs the events kept apart, and a preference needs its polarity.
  "第二节「用户事实」装**带类型的事实行**，不是词表、也不是散文。每行 `主体.谓词 = 值 | 类型`，主体只写 user / assistant / world。类型只用这几个：",
  "  fact —— 静态事实（学位、姓名、住处、设备型号、公司、地点）；number —— 带单位、并写清在数什么的数值；time —— 时刻或时长；event —— 有先后的事件，**每条事件单独一行**，行首标 `1)` `2)` `3)` 的次序；preference —— 偏好，喜欢的东西前面标 `+`、不喜欢的标 `-`；status —— 进行中 / 已完成；commitment —— 答应过要做的事。",
  "  例：`user.degree = Business Administration | fact`、`user.watched_amateur_comedians = 10 | number`、`user.new_tv_size = 55 inch | number`、`user.friday_wakeup_earlier = 30 minutes | time`、`user.creamer_preference = +variations on almond milk + vanilla + honey; -commercial products; -high sugar | preference`、`world.event_order = 1) Walmart coupon 2) Ibotta cashback 3) ShopRite signup | event`。",
  "  **值必须原样取自原文、保持原文语言**（原文是英文就写 Business Administration，不要译成中文）；谓词用英文小写下划线。",
  "  **一个值只出现在上面的锚点清单里、没有出现在这类带类型的行里，等于没记住** —— 接手的人看到孤零零的 10 不知道它在数什么。凡是这段里出现过的、关于用户自己、用户做过的事、以及任何带数值或先后的结论，都要在这里写成一行。",
  // Counting across the whole history is the failure leaf compaction introduced:
  // two of six measured questions asked "how many X" and the answering model
  // over-counted (four appointments where two happened, two ceremonies where three
  // happened). A count is only derivable if each occurrence is a separate dated row
  // AND a rescheduled or cancelled one is marked, otherwise mentions inflate the
  // total. lcm-x carries exactly this via independent `polarity` and its
  // cancels/supersedes/reverses relations; the cheap version here is a dated event
  // row with an explicit status.
  "  **会被数数的事，一次一行、带日期和状态**：`user.event = <日期> <发生了什么> | event`，并在行尾标 `<已发生>`、`<已取消>`、`<已改期>`、`<计划中>` 之一。**同一次事件只写一行**；改期就把新旧合并成一行并标 `<已改期>`；取消的仍要写出来并标 `<已取消>` —— 否则接手的人会把还没发生的、以及被取消的也数进去。",
  "其余四节**必须都有内容**：它们是接手的人读懂状态的地方，一节都不许省。",
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
    // Measured: with a Chinese instruction the checkpoint came out in Chinese even
    // for an English conversation, and the answering model mirrored it - three of
    // 15 measured answers were semantically right but in Chinese against an English
    // gold ("三场" for 3, "六月" for June). The checkpoint is a view of the SPAN, so
    // it follows the span language, not the instruction language.
    "- Write the checkpoint in the same language as the span you are condensing. Keep every quoted value, name and unit exactly as it appears in the span, in its original language.",
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
 * Only the shadowed messages and the instruction are sent. See the long comment
 * in the body for why the host's system prompt is deliberately NOT replayed:
 * basic pays it once, a leaf backend would pay it once per leaf.
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
  // The conversation's own system prompt is NOT replayed here.
  //
  // `dsh-compaction-basic` replays it, and that is correct FOR BASIC: it compacts
  // the whole prefix in ONE call, so the system prompt is paid once and the
  // provider's warm prefix cache can absorb it. This backend compacts in leaves,
  // so the same decision is paid once PER LEAF. Measured on a real 1M-window
  // session whose system prompt is 411 154 characters (~101 120 tokens): one
  // 24 000-token leaf call billed 137 304 input tokens of which 136 064 were the
  // replayed system prompt (99%), and the call took 90.4 s. The identical leaf
  // with the system prompt omitted billed 36 184 input tokens and took 32.0 s —
  // 2.8x faster and 3.8x cheaper for the same six-section output (7 376 vs 7 158
  // characters, both complete).
  //
  // The system prompt bought nothing even when it hit the cache: cacheRead was
  // 136 064 of 137 304 (99% cached) and the call was still 90 s, because a cached
  // prefill is cheap in dollars and not in wall time.
  //
  // lcm-x never sends the host system prompt. Its leaf request is its own short
  // contract (a system message it writes) plus the transcript as user data, and
  // its fallback path is a bare `[{role:"user", content: prompt}]`. This follows
  // that: the instruction below already states the contract, so the span and the
  // instruction are the whole request.
  //
  // A twelve-leaf sweep at 90 s/leaf is 18 minutes; at 32 s/leaf it is 6.4, which
  // is what makes a sweep usable at all.

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
  // The instruction names a TARGET size; the request ceiling is set separately and
  // deliberately higher (see the ceiling comment below), so this number guides the
  // model without being the thing that cuts it off. It still earns its place — a
  // model told "roughly 2400 tokens" writes a 2400-token summary instead of a
  // 400-token stub or a 40k-token transcript.
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
  const messages = [...regionMessages, instruction];

  // A ceiling, and why it is twice the target.
  //
  // Two measured failures bracket this number. A summary-sized cap failed first:
  // reasoning-first backends bill hidden reasoning against the same completion
  // budget, so the whole cap went to thinking and the response finished
  // `max-tokens` with ZERO text. Removing the cap failed the other way: the
  // provider substituted its own smaller default, and one run was cut mid-word at
  // 7 734 characters with only the anchor section written, while the same prompt
  // with an explicit 32 768 finished at 8 817 characters with all six sections.
  // Neither "cap at the target" nor "no cap at all" is correct.
  //
  // So the ceiling is `max(4096, 2 x target)`: reasoning measured at roughly half
  // the billed completion, which makes twice the target enough room to finish, and
  // it is not the binding constraint because the model stops well before it. The
  // shrink guarantee in `region.compactSurfaceRegion` is still what bounds the
  // transaction, and it is a post-hoc check no cap can replace.
  //
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
  // A ceiling, not a limit. Measured: with NO maxTokens the provider applies its
  // own default, which is small - one run was cut mid-word at 7 734 characters with
  // only the anchor section written, and the same prompt with an explicit 32 768
  // finished at 8 817 characters with all six sections. Leaving the ceiling unset
  // did not remove a limit, it substituted an invisible and smaller one.
  //
  // The number is deliberately not the target: reasoning is billed against the
  // same ceiling and measured at roughly half of it, so a ceiling equal to the
  // target leaves the summary half-written. Twice the target stops truncation
  // without becoming the binding constraint - the model stops well before it.
  // The floor gives a small span enough room to answer at all.
  const ceiling = Math.max(4096, budgetTokens * 2);
  const options = {
    provider: target.provider,
    model: target.model,
    maxTokens: ceiling,
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
    if (attempts > emptyRetries) {
      // Tag it: the ladder in compile() turns this into the deterministic rung
      // instead of a failed compaction. lcm-x's escalation never surfaces an empty
      // result either - L1 and L2 both falling through lands on its deterministic
      // truncation, which "guaranteed convergence".
      const error = new Error("lcm: summarization produced no text content");
      error.code = "SUMMARY_EMPTY";
      throw error;
    }
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
    // `targetTokens` is what the instruction asked the model to aim for. The
    // request ceiling is the separate `max(4096, 2 x target)` above, so recording
    // the target here is the honest field: it is not the cap that was sent.
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
const EXISTING_POINTER_RE = /\((?:seqs?\s+([\d,\s-]+))\)\s*$/u;

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

/** One character that can sit inside a word (`_` is not a Unicode letter or number). */
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

/**
 * Whether a word character sits at `index`.
 * Out of range counts as a boundary, which is what an anchor at the very start or
 * end of the span needs.
 * @param text - string to inspect.
 * @param index - position, possibly -1 or past the end.
 * @returns true when a word character sits there.
 */
function wordAt(text, index) {
  if (index < 0 || index >= text.length) return false;
  return WORD_CHAR_RE.test(text[index]);
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
  // Per-event folded body, kept alongside the concatenated haystack so a pointer
  // the model COPIED out of a child checkpoint can be checked against the one
  // event it names rather than against the span as a whole (see verify()).
  const bodies = new Map();
  let cursor = 0;
  for (const seq of shadowedSeqs ?? []) {
    const body = spanBody(session, seq);
    if (body === undefined || body.length === 0) continue;
    const folded = body.toLowerCase();
    starts.push(cursor);
    seqs.push(seq);
    parts.push(folded);
    bodies.set(seq, folded);
    cursor += folded.length + 1;
  }
  const haystack = parts.join("\n");
  return {
    haystack,
    /**
     * Whether one specific event's rendered body contains the anchor verbatim.
     *
     * Exists because a pointer is not self-validating: the model copies child
     * checkpoints forward, and a checkpoint's text is a REWORDING of its span, so
     * a string can be in the span and absent from the event the pointer names.
     * Measured over 1054 attributed pointers in 46 real checkpoints: 1 (0.095%)
     * named an event that does not contain its anchor (session-dd78fcfd,
     * checkpoint seq 64, `命令: \`echo alpha\`, ... (seq 39)` — seq 39 is a
     * checkpoint whose text is a reworded summary, not the literal). Small, but it
     * is a pointer that sends lcm_expand to the wrong text, which is the one thing
     * a pointer must never do.
     * @param seq - seq the pointer names.
     * @param anchor - literal anchor text.
     * @returns true when that event's body holds the anchor.
     */
    verify(seq, anchor) {
      const body = bodies.get(seq);
      return body !== undefined && body.includes(anchor.toLowerCase());
    },
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
    },
    /**
     * How often the anchor occurs in the span as a delimited literal.
     *
     * Used only to rank anchors when the section overflows: the instruction
     * promises 「唯一性优先」 — a literal the span mentions once is worth more than
     * a generic word it repeats hundreds of times — and without a count that
     * promise is unenforceable.
     *
     * Delimited, not bare substrings. A bare substring count inflated any anchor
     * that is a PREFIX of other anchors — counted on a 129-token list, `uniq_1`
     * matched `uniq_10`..`uniq_19` and `uniq_100`..`uniq_128` and scored ~20
     * repeats, outranking a word the span really repeats 10 times, so the wrong
     * line was the one cut. A side that starts or ends outside the word class
     * imposes no boundary, which keeps `/tmp/x` and `https://…` matching inside
     * running text.
     * @param anchor - literal anchor text.
     * @returns the delimited occurrence count (0 when the span never held it).
     */
    count(anchor) {
      const needle = anchor.toLowerCase();
      if (needle.length === 0) return 0;
      const left = wordAt(needle, 0);
      const right = wordAt(needle, needle.length - 1);
      let total = 0;
      let at = haystack.indexOf(needle);
      while (at >= 0) {
        if ((!left || !wordAt(haystack, at - 1)) && (!right || !wordAt(haystack, at + needle.length))) total += 1;
        at = haystack.indexOf(needle, at + needle.length);
      }
      return total;
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
 * How many anchor lines the checkpoint may carry.
 *
 * The instruction states this bound (`ANCHOR_RULE`: 「**最多 120 行**」), but a
 * stated bound is not an enforced one. Measured on a production run: the model
 * wrote 262 anchor lines — 5 944 characters, 38% of the whole checkpoint body —
 * because nothing on the engine side ever counted them. The number is copied
 * from that sentence on purpose, so prompt and code cannot drift apart.
 */
const ANCHOR_LINE_CAP = 120;

/**
 * The section headings the instruction itself printed.
 *
 * Measured failure: that same run copied the instruction's own headings into
 * the anchor word list (one line held nothing but `## 目标与约束`, backticked).
 * Such a string pasted into `lcm_search` matches the checkpoint that contains
 * it, which is exactly the self-reference the anchor list exists to avoid. Only
 * these six phrases are dropped: a heading the model invented stays, because
 * guessing which other heading is noise would risk real text.
 */
const SKELETON_PHRASES = new Set(SUMMARY_SKELETON.map((heading) => heading.replace(/^#{1,6}\s*/u, "").trim()));

/**
 * Whether one anchor line carries nothing a search could use.
 *
 * Two narrow shapes, both measured: a line with no letter and no number at all
 * (a lone backtick, a stray dash) and a skeleton heading copied verbatim.
 * Everything else survives on purpose — `fact`, `/tmp/x`, `0xfffffe00075b9000`,
 * `42` and `2023-05-30` are precisely the strings the section exists to carry.
 * A filter keyed on "too short" or "reads like prose" would delete the golds
 * the measured failures were made of: of 15 paired failures, 7 golds were
 * numeric and 6 were short prose.
 * @param anchor - normalized anchor text.
 * @returns true when the line must be dropped.
 */
function isNonContentAnchor(anchor) {
  // `\p{L}` covers CJK and every other script, so a one-word anchor like 缓存 is
  // content while a leftover backtick or bullet is not.
  if (!/[\p{L}\p{N}]/u.test(anchor)) return true;
  // Trailing colon included: a heading copied into an open list usually keeps it.
  return SKELETON_PHRASES.has(anchor.replace(/^#{1,6}\s*/u, "").replace(/[：:]\s*$/u, "").trim());
}

/**
 * Anchor text of one section line, with a pointer the model copied forward
 * stripped, so the prune below can rank and count it. `anchorTextOf` reports
 * such a line as "no anchor" on purpose (re-attributing would append a second
 * pointer), which is the wrong answer here.
 * @param line - one line of the summary.
 * @returns the anchor text, or null when the line carries no anchor.
 */
function anchorContentOf(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0 || HEADING_RE.test(trimmed)) return null;
  let anchor = trimmed.replace(EXISTING_POINTER_RE, "");
  anchor = anchor.replace(BULLET_RE, "").trim();
  anchor = anchor.replace(/^`+([\s\S]*?)`+$/u, "$1").trim();
  if (anchor.length === 0) return null;
  return anchor;
}

/**
 * Seqs named by a pointer the model copied forward, with `a-b` ranges expanded.
 *
 * A copied pointer is a CLAIM, not provenance, so it has to be read back before
 * it is trusted. See the verification pass in `attributeAnchorPointers`.
 * @param line - one line of the summary.
 * @returns the seqs the pointer names; empty when the line carries none.
 */
function pointerSeqsOf(line) {
  const match = EXISTING_POINTER_RE.exec(line.trim());
  if (match === null) return [];
  const seqs = [];
  for (const part of match[1].split(",")) {
    const bounds = part
      .trim()
      .split("-")
      .map((value) => Number(value.trim()));
    if (bounds.length === 2 && Number.isInteger(bounds[0]) && Number.isInteger(bounds[1])) {
      for (let seq = bounds[0]; seq <= bounds[1]; seq += 1) seqs.push(seq);
    } else if (Number.isInteger(bounds[0])) {
      seqs.push(bounds[0]);
    }
  }
  return seqs;
}

/**
 * One line with its trailing pointer removed, the text kept.
 *
 * Used when a copied pointer is provably wrong and the span holds the anchor
 * nowhere: the pointer goes, the line stays. Dropping the line instead would
 * throw away text that may well be real — only the PROVENANCE is disproven.
 * @param line - one line of the summary.
 * @returns the line without its pointer.
 */
function withoutPointer(line) {
  return line.replace(EXISTING_POINTER_RE, "").replace(/\s+$/u, "");
}

/**
 * One line carrying `(seq N)`, any previous pointer replaced rather than stacked.
 * @param line - one line of the summary.
 * @param seq - the verified seq.
 * @returns the line with exactly one pointer.
 */
function withPointer(line, seq) {
  return withoutPointer(line) + " (seq " + seq + ")";
}

/**
 * Order anchors worst-first for deletion when the section overflows.
 *
 * The instruction's own wording — 「唯一性优先、具体优先」 — made checkable
 * instead of merely asked for. Three keys, in this order:
 *
 *   1. keep the anchors that exist verbatim in the span. A pointer is the only
 *      proof the string was really there, so an unverified line goes before a
 *      verified one: the pointed subset is the part that carries fidelity.
 *   2. among equals keep the least-repeated. A literal the span mentions once is
 *      worth more than a word it repeats hundreds of times.
 *   3. ties keep the earliest-listed, because position is the model's own
 *      ranking and the model is the only party that saw the span.
 * @param left - one ranked anchor row.
 * @param right - the other ranked anchor row.
 * @returns negative when `left` must be deleted first.
 */
function byDeletionPriority(left, right) {
  if (left.pointer !== right.pointer) return left.pointer ? 1 : -1;
  if (left.repeats !== right.repeats) return right.repeats - left.repeats;
  return right.order - left.order;
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
 * The same pass holds the anchor section to its promised shape. Two engine-side
 * corrections, both deterministic and both on the far side of the model call so
 * the prefix-cache contract above still holds: lines carrying no content (a lone
 * backtick, a heading the instruction itself printed) are dropped, and an
 * over-long section is cut to `ANCHOR_LINE_CAP`. Measured need: one production
 * run emitted 262 anchor lines holding both kinds of garbage, and neither the
 * prompt nor anything else stopped it.
 *
 * @param text - model-returned markdown.
 * @param session - session-shaped value owning the events.
 * @param shadowedSeqs - seqs of the span being replaced; nothing outside it is
 *   searched, because a seq outside the span is not in this checkpoint's scope.
 * @returns the markdown with (seq N) appended where attribution succeeded, and
 *   the anchor section pruned to real content and to its 120-line bound.
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
  // An empty index only means nothing can be attributed. The prune below still
  // has to run: the bound is about the checkpoint's shape, not about what this
  // particular span happened to contain.
  if (index.haystack.length > 0) {
    for (let line = heading + 1; line < sectionEnd; line += 1) {
      // A pointer the model copied out of a child checkpoint is a CLAIM, not
      // provenance. A checkpoint's text is a REWORDING of the events it absorbed,
      // so a copied pointer can name an event that does not contain the literal at
      // all — and that pointer sends lcm_expand to the wrong text, which is the one
      // failure a pointer must never have. Measured over 1054 attributed pointers
      // in 46 real checkpoints: 1 wrong (session-dd78fcfd, checkpoint seq 64,
      // `命令: \`echo alpha\`, \`echo beta\`, \`echo gamma\` (seq 39)`, where seq 39
      // is a reworded checkpoint). Rare, cheap to check, and unrecoverable if wrong.
      const copied = pointerSeqsOf(lines[line]);
      if (copied.length > 0) {
        const anchor = anchorContentOf(lines[line]);
        if (anchor === null) continue;
        if (copied.some((seq) => index.verify(seq, anchor))) continue;
        // Not in the event it names. Re-attribute to the event that does hold it;
        // when the span holds it nowhere, drop only the pointer and keep the text.
        const seq = index.lookup(anchor);
        lines[line] = seq === undefined ? withoutPointer(lines[line]) : withPointer(lines[line], seq);
        continue;
      }
      const anchor = anchorTextOf(lines[line]);
      if (anchor === null) continue;
      const seq = index.lookup(anchor);
      if (seq === undefined) continue;
      lines[line] = withPointer(lines[line], seq);
    }
  }
  // Rebuild the section in one pass. A dropped line is not an anchor at all, so
  // it must not consume one of the 120 slots; a blank line is presentation and is
  // neither counted nor removed.
  const rows = [];
  for (let line = heading + 1; line < sectionEnd; line += 1) {
    const anchor = anchorContentOf(lines[line]);
    if (anchor === null) {
      rows.push({ text: lines[line], anchor: null });
      continue;
    }
    if (isNonContentAnchor(anchor)) continue;
    rows.push({
      text: lines[line],
      anchor,
      // Either the model copied this pointer out of a child checkpoint or the
      // loop above just attributed one; both mean the string exists verbatim.
      pointer: EXISTING_POINTER_RE.test(lines[line].trim()),
      repeats: index.count(anchor),
      order: line
    });
  }
  const anchors = rows.filter((row) => row.anchor !== null);
  const doomed = new Set();
  if (anchors.length > ANCHOR_LINE_CAP) {
    const worst = [...anchors].sort(byDeletionPriority).slice(0, anchors.length - ANCHOR_LINE_CAP);
    for (const row of worst) doomed.add(row);
  }
  const keptRows = rows.filter((row) => !doomed.has(row));
  const kept = keptRows.map((row) => row.text);
  // A silent cut reads as "this list is everything the span held". Measured on a
  // real span: 300 in-span anchors kept 120, 180 dropped, and a
  // /truncat|cut|omitted/ search over the checkpoint body found nothing — the
  // reader cannot tell a complete anchor list from a capped one, which turns the
  // cap into invisible loss. The note goes AFTER the list on its own line, so it
  // consumes no anchor slot (the section still holds exactly ANCHOR_LINE_CAP
  // anchors) and cannot be mistaken for an anchor; it is written in the section's
  // own language, because the checkpoint follows the span's language, not this
  // module's, and it names the recovery path each dropped string still has.
  if (doomed.size > 0) {
    const keptAnchors = anchors.length - doomed.size;
    // Last line of the section region, after the list's own trailing blank line:
    // the blank is what separates "anchor list" from "everything else", so a note
    // before it would read as one more anchor to any consumer that counts lines up
    // to that blank.
    kept.push(`（逐字锚点已截断：保留 ${keptAnchors} / ${anchors.length} 条，其余请用 lcm_search 在原始日志中检索）`);
  }
  return [...lines.slice(0, heading + 1), ...kept, ...lines.slice(sectionEnd)].join("\n");
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
