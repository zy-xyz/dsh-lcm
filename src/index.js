/**
 * Lossless Context Management compaction engine for the DeepSeek Harness.
 *
 * A drop-in replacement for `@deepseek-ai/dsh-compaction-basic`: the same
 * `ctx.compaction` seam, the same configuration surface, the same durable
 * transaction protocol (`compaction/start|summary|end`, surface stability,
 * shrink guarantee, `busy`/`changed`/`summary`/`commit`/`persistence`
 * failures). Only the summarizer changes: instead of a free-form prose
 * summary, the model writes a structured checkpoint whose facts stay
 * retrievable through `lcm_expand` / `lcm_search` against the append-only log.
 *
 * The log is the truth; the checkpoint is a view over it.
 *
 * @module dsh-lcm
 */
import z from "@deepseek-ai/schemastery";
import { CompactionEngine, ManualCompactionError } from "@deepseek-ai/dsh-compaction";
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError } from "@deepseek-ai/dsh-llm";
import { assertNever } from "@deepseek-ai/dsh-util-values";
import { COMPILER_REV, estimateEntryTokens, isCheckpointSource } from "./compiler.js";
import { describeError, engineDebug } from "./debug.js";
import {
  TargetPressureConfigError,
  resolveCompactSpec,
  resolveConfig,
  resolveSummaryBudget,
  resolveTargetPolicy
} from "./config.js";
import { assertNoActiveCompaction, compactSurfaceRegion, selectCompactableRange } from "./region.js";
import { SUMMARY_SKELETON, summarizeLeaf } from "./summarize.js";

export { TargetPressureConfigError, resolveCompactSpec, resolveConfig, resolveTargetPolicy };

// ── the engine ──────────────────────────────────────────────────────────────

/** Resolve the exact provider/model durably routed for the latest request. */
export function routedTarget(session) {
  const config = session.requestHeader()?.config;
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) return;
  return {
    provider: config.provider,
    model: config.model
  };
}

/**
 * Output tokens one routed request reserves, exactly as basic computes it: the
 * request envelope's own `maxTokens`, else the adapter's default.
 * @param header - durable routed request header.
 * @param defaultMaxTokens - adapter-provided default, when any.
 * @returns the reserved completion budget (0 when unknown).
 */
function reservedCompletionTokens(header, defaultMaxTokens) {
  return header?.config?.maxTokens ?? defaultMaxTokens ?? 0;
}

// ── shrink-retry wording ───────────────────────────────────────────────────

/**
 * Level 3 of the escalation ladder: deterministic truncation, no model call.
 *
 * lcm-x's fallback rung ("Level 3 (Fallback): Deterministic truncation — no LLM,
 * guaranteed convergence"). The alternative - and what this package did before -
 * is to throw SUMMARY_NOT_SHRINKING, which turns "the model wrote too much" into
 * "the compaction fails": the whole span loses its summary and the failure repeats
 * on the next step. lcm-x's invariant is the opposite: prefer degraded coverage
 * over failure.
 *
 * The anchor section is emitted FIRST for exactly this reason, so truncation costs
 * the narrative tail and keeps every pointer the agent needs to drill back in. The
 * cut lands on a line boundary and the result says it was truncated, so a reader is
 * never misled about completeness.
 * @param text - the summary body that overran.
 * @param limit - token budget it must fit under.
 * @returns the truncated body, labelled.
 */
function truncateToBudget(text, limit) {
  const full =
    "\n\n[truncated to fit: the tail of this checkpoint was cut deterministically. The original span is intact in the log — use lcm_search or lcm_expand for anything missing here.]";
  const terse = "\n[truncated; see lcm_search]";
  // A note that eats most of the budget defeats the purpose. Fall back to a terse
  // one, and if even that does not fit, return the plain cut.
  const note = estimateEntryTokens(full) * 4 <= limit ? full : estimateEntryTokens(terse) * 4 <= limit ? terse : "";
  const available = Math.max(1, limit - estimateEntryTokens(note));
  if (estimateEntryTokens(text) <= available) return text + note;
  const lines = text.split("\n");
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const cost = estimateEntryTokens(line) + 1;
    if (used + cost > available) break;
    kept.push(line);
    used += cost;
  }
  // Never return an empty body: the first line is the section header, which is the
  // cheapest useful thing to keep, and the bound is still enforced below.
  if (kept.length === 0) kept.push(lines[0] ?? "");
  let out = kept.join("\n") + note;
  // Hard guarantee: the escalation rung exists to converge, so trim characters
  // until the estimate fits rather than trusting the per-line arithmetic.
  while (estimateEntryTokens(out) > limit && out.length > 16) out = out.slice(0, Math.max(16, out.length - Math.ceil(out.length / 8)));
  return out;
}

/**
 * Token cost of the fixed header that prefixes every checkpoint body.
 *
 * The shrink bound is checked against the assembled ENTRY, not the body, so the
 * truncation rung has to reserve this. Measured: a 100-token bound with an
 * unreserved ~30-token header put the entry back over and the escalation stopped
 * converging.
 * @param prepared - the priced span snapshot.
 * @param bodyTokens - current body size (used in the header text).
 * @returns the header's token cost.
 */
function headerTokens(prepared, bodyTokens) {
  return estimateEntryTokens(
    `[lcm leaf summary · ${prepared.shadowedSeqs.length} nodes · seqs ${prepared.start}-${prepared.end} · ~${prepared.shadowedTokenCount} → ~${bodyTokens} tokens · anchors below carry (seq N): restore with lcm_expand, or find anything else with lcm_search]\n`
  );
}

/** Join one summarizer result's text blocks into the checkpoint body. */
function summaryBodyOf(result) {
  return result.summary.map((block) => block.text ?? "").join("\n");
}

/**
 * The extra instruction appended to ONE length-retry attempt.
 *
 * A model told "aim for roughly N tokens" overruns it routinely: a measured run
 * wrote a 2438-token summary for a 1517-token span, 4.8x the 512-token target
 * and longer than the text it replaced, so the shrink guarantee in `region.js`
 * rejected the compiled checkpoint and the model call was wasted. The gate is
 * right; the retry is what changes, and it has to change the PROMPT or the same
 * request samples the same overrun. Three things go in, in this order: what
 * went wrong last time (so the model does not repeat it), the hard upper bound
 * as a NUMBER (a target worded as a target was already ignored), and what may
 * be cut versus what must survive (a bare "be shorter" is satisfied by deleting
 * the anchor list, which is the one section that carries fidelity).
 * @param writtenTokens - estimated body size of the rejected attempt.
 * @param limitTokens - hard upper bound: the shadowed span's own token count.
 * @returns the instruction block appended after the normal instruction.
 */
function hardShrinkConstraint(writtenTokens, limitTokens) {
  const [anchorHeading, ...stateHeadings] = SUMMARY_SKELETON;
  const anchorSection = anchorHeading.replace(/^#+\s*/u, "");
  return [
    `HARD CONSTRAINT — the previous attempt was rejected: it produced a summary LONGER than the span it replaced (${writtenTokens} estimated tokens against ${limitTokens}).`,
    `The summary body MUST be shorter than ${limitTokens} tokens. That is a hard upper bound, not a target.`,
    `Cut narrative prose, restated tool output, and repeated explanation. Do NOT shorten the "${anchorSection}" list to save room — merge duplicate anchors instead, and keep every anchor you listed.`,
    `All four state sections (${stateHeadings.join(" / ")}) must still carry content: shorten their sentences, never drop or empty a section.`
  ].join("\n");
}

// ── schemastery surface (composition-time validation only) ─────────────────
// The resolved defaults and every cross-field rule live in ./config.js; these
// schemas exist so the Loader can validate a composition entry before the
// engine constructor runs.

const thresholdRatioSchema = z.number();
const headroomTokensSchema = z.number().step(1).min(0);
const retainRatioSchema = z.number();
const retainTokensSchema = z.number().step(1).min(0);
const checkpointCapSchema = z.number().step(1).min(1);
const summarizationProviderSchema = z.string();
const summarizationModelSchema = z.string();
const maxTokensSchema = z.number().step(1).min(1);
const compactionRetriesSchema = z.number().step(1).min(0);
const maxOverflowRetriesSchema = z.number().step(1).min(0);

const modelPolicy = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: thresholdRatioSchema,
  headroomTokens: headroomTokensSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema
});

/**
 * LLM-summarizing compaction backend using `ctx.tokenMeter` for pressure,
 * retention, and checkpoint pricing. It descends from
 * `dsh-compaction-instant`'s deterministic VCC-style compiler, but the
 * replacement step is now a real model call (`src/summarize.js`).
 *
 * `compile()` is the sole subclass customization hook; range selection and the
 * durable mutation strategy stay fixed so every pricing decision uses the
 * singleton token meter.
 */
export class LcmCompactionEngine extends CompactionEngine {
  static inject = [
    "llm",
    "tokenMeter",
    "sessions"
  ];
  static Config = z.object({
    thresholdRatio: thresholdRatioSchema,
    headroomTokens: headroomTokensSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    maxTokens: maxTokensSchema,
    checkpointCap: checkpointCapSchema,
    summaryRatio: z.number(),
    summaryFloorTokens: maxTokensSchema,
    leafSpanTokens: maxTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
    // ── LCM-only keys ──
    // These MUST be declared here. schemastery's `simplify` is a whitelist: a
    // key the schema never learned about is dropped when a patch re-route writes
    // the configuration back through `fiber.update`, so an undeclared key is a
    // key that silently disappears on the next settings change (measured: nine
    // keys lost, `anchorPointers` and every `vector*` among them).
    //
    // Types mirror ./config.js's own validation exactly (boolean flags, positive
    // integers, strings) and no `.default()` is declared, matching every other
    // key in this schema: a default here would make `simplify` drop an
    // explicitly-set value that happens to equal it, and ./config.js is already
    // the single source for resolved defaults.
    anchorPointers: z.boolean(),
    emptySummaryRetries: compactionRetriesSchema,
    debug: z.boolean(),
    debugLogPath: z.string(),
    // ── optional vector recall layer (inert unless vectorEnabled) ──
    vectorEnabled: z.boolean(),
    vectorBaseUrl: z.string(),
    vectorModel: z.string(),
    vectorDim: maxTokensSchema,
    vectorTopK: maxTokensSchema,
    vectorTimeoutMs: maxTokensSchema,
    vectorCacheDir: z.string()
  });
  /** Settings namespace for user-owned LCM compaction preferences. */
  /** Resolved and validated compaction configuration. */
  config;
  warnedPressureConfigTargets = new Set();
  overflowRetries = new WeakMap();
  overflowAgents = new WeakMap();
  constructor(ctx, config = {}) {
    super(ctx);
    this.config = resolveConfig(config);
    engineDebug(this.config, `constructed rev=${COMPILER_REV} debugLog=${this.config.debugLogPath} summaryRatio=${this.config.summaryRatio} cap=${this.config.checkpointCap}`);
    this._autoDisposer = null;
    this._autoActive = false;
    this._syncAuto();
  }
  /** Register or dispose the automatic-compaction listeners with the `auto` flag. */
  _syncAuto() {
    const active = this.config.auto === true;
    if (active === this._autoActive) return;
    if (this._autoDisposer !== null) {
      this._autoDisposer();
      this._autoDisposer = null;
    }
    this._autoActive = active;
    if (active) this._autoDisposer = this._registerAutomaticCompaction();
  }
  /**
   * Register automatic between-step pressure, model-switch pressure, and
   * model-request overflow recovery. `compactIfNeeded` and `compactPressure`
   * stay dynamically dispatched so subclass overrides are honored at event time.
   *
   * The five listeners are `dsh-compaction-basic`'s five: pre-step pressure,
   * idle status, the `agent/request` model-switch gate, the session/event
   * overflow bookkeeping, and `agent/request-error` overflow recovery.
   */
  _registerAutomaticCompaction() {
    const { ctx } = this;
    const logResult = (result, trigger) => {
      ctx.logger.info(`compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes (seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens) with the instant compiler`);
    };
    const disposers = [];
    disposers.push(ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
      if (!signal.aborted) try {
        const result = await this.compactIfNeeded(agent, "pressure", signal);
        if (result !== null) logResult(result, "step pressure");
      } catch (error) {
        if (error instanceof TargetPressureConfigError) {
          if (this.warnedPressureConfigTargets.has(error.targetKey)) return next();
          this.warnedPressureConfigTargets.add(error.targetKey);
        }
        const message = describeError(error);
        ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`);
        // Also to the debug log: ctx.logger.warn is invisible from a headless
        // run's stderr, and "compaction silently never fires" looked exactly
        // like "compaction fired and failed" until this line existed.
        engineDebug(this.config, `step compaction failed: ${message}`);
      }
      return next();
    }));
    disposers.push(ctx.on("agent/status", ({ agent, status }) => {
      if (status === "idle") this.overflowRetries.delete(agent);
    }));
    // A model switch is a pressure event: the next request runs on a DIFFERENT
    // window, and if the new one is smaller the history that comfortably fit the
    // old model no longer fits. basic prices the PROPOSED envelope here (not the
    // durable one), so the decision already uses the new model's capacity, and it
    // requires the history to actually land below the new threshold before the
    // switch is allowed. Failing to get there is reported as a refused switch
    // rather than surfacing later as a provider context-window error mid-turn.
    //
    // `prepend: true` because this listener must observe the config BEFORE any
    // other consumer acts on it: it may still veto the switch.
    disposers.push(ctx.on("agent/request", async ({ agent, signal }, next) => {
      const config = await next();
      const previous = agent.session.requestHeader();
      if (
        signal.aborted ||
        previous === undefined ||
        config.provider === "" ||
        config.model === "" ||
        (previous.config.provider === config.provider && previous.config.model === config.model)
      ) return config;
      try {
        const result = await this.compactPressure(agent, { ...previous, config }, signal, true);
        if (result !== null) logResult(result, "model switch");
      } catch (error) {
        signal.throwIfAborted();
        const message = describeError(error);
        throw new LlmError(
          `Cannot switch to ${config.provider}/${config.model}: context compaction failed: ${message}. The previous request model is preserved; retry or select a model with a larger context window.`,
          "MODEL_SWITCH_COMPACTION_FAILED",
          { cause: error }
        );
      }
      return config;
    }, { prepend: true }));
    disposers.push(ctx.on("session/event", (session, event) => {
      if (event.type !== "assistant/message") return;
      const agent = this.overflowAgents.get(session);
      if (agent !== undefined) this.overflowRetries.delete(agent);
    }));
    disposers.push(ctx.on("agent/request-error", async ({ agent, failure, signal }, next) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next();
      this.overflowAgents.set(agent.session, agent);
      const target = routedTarget(agent.session);
      if (target === undefined) return next();
      const policy = resolveTargetPolicy(this.config, target);
      const retries = this.overflowRetries.get(agent) ?? 0;
      if (retries >= policy.maxOverflowRetries) return next();
      const generation = agent.session.surface.replaceGeneration;
      let result;
      try {
        result = await this.compactIfNeeded(agent, "context-overflow", signal);
      } catch (recoveryError) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(`context-overflow compaction failed after durable surface progress: ${message}; retrying from the replacement surface`);
          this.overflowRetries.set(agent, retries + 1);
          return { kind: "retry" };
        }
        ctx.logger.warn(`context-overflow compaction failed: ${message}; ${signal.aborted ? "cancellation prevents retry" : "preserving the original request error"}`);
        return next();
      }
      if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next();
      if (result !== null) logResult(result, "context overflow recovery");
      this.overflowRetries.set(agent, retries + 1);
      return { kind: "retry" };
    }));
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* a failing listener teardown must not break the disposal sweep */
        }
      }
    };
  }
  /**
   * Resolve the TARGET length for one LLM leaf summary.
   *
   * This is a number written into the instruction ("aim for roughly N tokens"),
   * not a request cap: `summarizeLeaf` sends no `maxTokens`, so the provider's
   * own default ceiling applies. The name keeps its historical spelling because
   * it is also the config key it delegates to (`maxTokens`), which still bounds
   * the target.
   * @param shadowedTokenCount - tokens in the span being replaced.
   * @returns the summary target length (`summaryRatio` of the span, clamped).
   */
  effectiveMaxTokens(shadowedTokenCount) {
    return resolveSummaryBudget(this.config, shadowedTokenCount);
  }
  /**
   * Summarize one priced region with a model call.
   *
   * This is the sole delta over `dsh-lcm`: where the instant
   * backend runs a deterministic verbatim compiler, this backend asks the model
   * for a structured summary. Everything around it — range selection, the
   * durable transaction, the shrink guarantee, the `seq N` pointers and the
   * `lcm_expand` recovery path — is unchanged, so the summary is a lossy *view*
   * over a lossless log rather than the last copy of the history.
   *
   * @param prepared - priced selection snapshot (selection, session, pricing).
   * @param agent - supplies the routed model and session.
   * @param signal - optional cancellation forwarded to the summarizer.
   * @returns one entry holding the summary, plus provenance and stats.
   */
  async compile(prepared, agent, signal) {
    signal?.throwIfAborted();
    const budget = this.effectiveMaxTokens(prepared.shadowedTokenCount);
    engineDebug(
      this.config,
      `summarize span=${prepared.shadowedSeqs.length} seqs=${prepared.shadowedSeqs[0]}-${prepared.shadowedSeqs[prepared.shadowedSeqs.length - 1]} shadowedTokens=${prepared.shadowedTokenCount} budget=${budget}`
    );
    // The hard bound is the shadowed span itself: a summary at least as long as
    // the text it replaces cannot survive the shrink guarantee in `region.js`,
    // so measuring the body against it is the cheapest honest pre-check. It is
    // deliberately NOT the framed comparison: framing adds a header, an intro
    // line and the retention footer, none of which the summarizer can control,
    // so gating on framed tokens would retry summaries that are already fine and
    // still fail the ones framing alone sinks.
    // The gate this pre-check stands in for is stated in ROUTE prices
    // (`region.js` compares the framed replacement against
    // `prepared.shadowedRouteTokenCount`), so the limit must be the same number;
    // `prepared.shadowedTokenCount` is the heuristic shadow price the token
    // meter folds and is not the comparison basis. The fallback keeps a
    // caller-shaped `prepared` (one carrying only the shadow price) working.
    const limit = prepared.shadowedRouteTokenCount ?? prepared.shadowedTokenCount;
    let result = await summarizeLeaf(this.ctx, this.config, prepared, agent, budget, signal);
    signal?.throwIfAborted();
    let text = summaryBodyOf(result);
    let tokens = estimateEntryTokens(text);
    // `limit > 0` keeps the degenerate zero-token span on its historical path:
    // the shrink gate rejects it either way, and a retry there would only add a
    // full-price call to a guaranteed failure.
    if (limit > 0 && tokens >= limit) {
      engineDebug(this.config, `summarize oversize body=${tokens} >= shadowed=${limit} target=${budget}: retrying once with a hard length bound`);
      // Exactly one retry: the second attempt either fits or the failure is
      // reported with both numbers. No loop — a model that overruns twice on a
      // restated hard bound is not going to fit on attempt four, and every
      // attempt is a full-price call.
      // Level 2 — aggressive: half the budget and a bullet-point shape. lcm-x
      // calls this the aggressive rung of its three-level escalation
      // (escalation.py: "Level 2 (Aggressive): LLM bullet-point summary at half
      // the token budget").
      const aggressiveBudget = Math.max(128, Math.floor(budget / 2));
      result = await summarizeLeaf(this.ctx, this.config, prepared, agent, aggressiveBudget, signal, hardShrinkConstraint(tokens, limit));
      signal?.throwIfAborted();
      text = summaryBodyOf(result);
      tokens = estimateEntryTokens(text);
      if (tokens >= limit) {
        // Level 3 — deterministic truncation, no model call, guaranteed to
        // converge. lcm-x: "Level 3 (Fallback): Deterministic truncation — no LLM,
        // guaranteed convergence", and its invariant is to prefer degraded
        // coverage over failure. Our previous behaviour threw SUMMARY_NOT_SHRINKING
        // here, which turned "the model wrote too much" into "the compaction fails"
        // and repeated on every step. The anchor section is emitted FIRST precisely
        // so that truncation costs the narrative and keeps the pointers.
        // The checkpoint header below is prepended to this body, so the body must
        // leave room for it or the entry lands over the bound again.
        text = truncateToBudget(text, Math.max(32, limit - headerTokens(prepared, tokens)));
        tokens = estimateEntryTokens(text);
        engineDebug(this.config, `summarize escalated to deterministic truncation tokens=${tokens} shadowed=${limit} (degraded coverage, not a failure)`);
      } else {
        engineDebug(this.config, `summarize aggressive retry done tokens=${tokens} shadowed=${limit}`);
      }
    }
    const entries = [
      {
        seq: prepared.shadowedSeqs[0],
        // The header names both recovery paths. Anchors in the body carry their
        // own `(seq N)`, so the common case is one lcm_expand call; a fact the
        // checkpoint never listed is still findable with lcm_search. Saying only
        // "restore with lcm_expand" left the model guessing which seq to name.
        text: `[lcm leaf summary · ${prepared.shadowedSeqs.length} nodes · seqs ${prepared.start}-${prepared.end} · ~${prepared.shadowedTokenCount} → ~${tokens} tokens · anchors below carry (seq N): restore with lcm_expand, or find anything else with lcm_search]\n${text}`,
        kind: "checkpoint"
      }
    ];
    engineDebug(this.config, `summarize done tokens=${tokens} ratio=${(prepared.shadowedTokenCount / Math.max(1, tokens)).toFixed(2)}`);
    return {
      entries,
      stats: {
        nodes: prepared.shadowedSeqs.length,
        entries: 1,
        toolCalls: 0,
        toolResults: 0,
        images: 0,
        documents: 0,
        reasoningElided: 0,
        noiseElided: 0,
        checkpoints: 1,
        tokens,
        elidedToolRows: 0,
        elidedRows: 0
      },
      capped: false,
      provider: result.provider,
      model: result.model,
      targetTokens: budget,
      usage: result.usage,
      rawOutput: result.rawOutput
    };
  }
  /**
   * Compact for replayed step-boundary pressure or one provider-confirmed
   * context overflow. Both triggers price the latest durable routed request
   * envelope; overflow bypasses the normal threshold and retained-tail policy
   * so it can force one useful balanced reduction.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to the compile.
   * @returns the latest compaction result, or `null` when none ran.
   */
  async compactIfNeeded(agent, trigger, signal) {
    const target = routedTarget(agent.session);
    engineDebug(this.config, `compactIfNeeded trigger=${trigger} target=${target === undefined ? "none" : target.provider + "/" + target.model} auto=${String(this.config.auto)}`);
    if (target === undefined) return null;
    switch (trigger) {
      // The durable envelope IS the proposed envelope for a step boundary.
      case "pressure": return this.compactPressure(agent, agent.session.requestHeader(), signal, false);
      case "context-overflow": {
        const meter = this.ctx.tokenMeter;
        const prune = this.ctx.get("toolResultPruner");
        let measurement = meter.measure(agent.session);
        if (prune !== undefined) {
          prune.pruneSession(agent.session);
          measurement = meter.measure(agent.session);
        }
        // Overflow recovery is still an AUTOMATIC reduction, so the same
        // "not worth a summary call" floor applies: a span the summary budget
        // could never undercut would burn one model call and then fail the shrink
        // guarantee, which is strictly worse than preserving the original error.
        const range = selectCompactableRange(agent.session, measurement, 0, this.config.summaryFloorTokens, this.config.leafSpanTokens);
        if (range === null) return null;
        return this.compactRegion(range.start, range.end, agent, signal);
      }
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default: assertNever(trigger, "compaction trigger");
    }
  }
  /**
   * Compact one PROPOSED request envelope down below its own pressure threshold.
   *
   * The envelope is a parameter because a model switch has to be priced on the
   * config the next request would actually use — the durable header still
   * describes the previous model. `dsh-compaction-basic` has this same split
   * (`compactIfNeeded` for the durable envelope, `compactPressure` for a
   * proposed one); only the span floor and the summary target are ours.
   *
   * @param agent - agent whose session is measured and compacted.
   * @param header - the request envelope to price; `undefined` when none exists.
   * @param signal - live turn cancellation signal.
   * @param requireBelowThreshold - when true, failing to reach the threshold is an
   *   ERROR rather than a quiet `null`: a refused model switch must report why.
   * @returns the last compaction result, or `null` when nothing was needed.
   */
  async compactPressure(agent, header, signal, requireBelowThreshold) {
    const target = header?.config;
    if (target === undefined || target.provider.length === 0 || target.model.length === 0) return null;
    const policy = resolveTargetPolicy(this.config, target);
    const meter = this.ctx.tokenMeter;
    let measurement = meter.measure(agent.session, header);
    const prune = this.ctx.get("toolResultPruner");
    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
    const context = info.context;
    assertNoActiveCompaction(agent.session, "automatic pressure compaction");
    const targetKey = `${target.provider}/${target.model}`;
    if (context === undefined) throw new TargetPressureConfigError(targetKey, `compaction-lcm: no context capacity for ${targetKey}; configure contextWindow on that adapter model`);
    // basic's exact reservation: the routed request's own output budget must not
    // be counted as available message space. It is read off the envelope being
    // priced, so a model switch reserves the NEW model's completion budget.
    const spec = resolveCompactSpec(policy, context.contextWindow, reservedCompletionTokens(header, info.defaultMaxTokens));
    // Observability for the one decision that silently does nothing: G6 asks for a
    // state surface, and "compaction never fired" was indistinguishable from
    // "compaction fired and failed" without this line.
    engineDebug(
      this.config,
      `pressure: measured=${measurement.totalTokens} threshold=${spec.thresholdTokens} window=${context.contextWindow} retain=${spec.retainTokens} required=${String(requireBelowThreshold)}`
    );
    if (measurement.totalTokens < spec.thresholdTokens) return null;
    if (prune !== undefined) {
      prune.pruneSession(agent.session);
      measurement = meter.measure(agent.session, header);
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null;
    let result = null;
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      // The span floor is what stops the "span=1 seqs=24-24 shadowedTokens=428
      // budget=512" attempt: at 428 tokens the resolved budget is clamped to
      // summaryFloorTokens (512), so the checkpoint could never be smaller and
      // the call was guaranteed to fail after paying for it.
      const range = selectCompactableRange(agent.session, measurement, spec.retainTokens, this.config.summaryFloorTokens, this.config.leafSpanTokens);
      if (range === null) {
        // A step-boundary attempt that cannot make progress is a no-op; a model
        // switch that cannot is a refusal, because admitting the new model would
        // send an over-threshold request.
        if (result === null && !requireBelowThreshold) return null;
        if (result === null) throw new Error(`no safe compaction range can reduce ${targetKey} context below its threshold (${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`);
        /* v8 ignore next -- paired with the defensive post-success branch above. */
        break;
      }
      result = await this.compactRegion(range.start, range.end, agent, signal);
      measurement = meter.measure(agent.session, header);
      if (measurement.totalTokens < spec.thresholdTokens) return result;
    }
    // Still above threshold after the allowed attempts. Before calling that a
    // failure, ask whether any further compaction is even possible: when the
    // threshold sits below the non-compactable baseline (system prompt, tool
    // definitions, retained tail) there is nothing left to compact, and
    // reporting a failure every step forever is not a diagnosis - it is noise
    // that hides real ones. Measured: thresholdRatio 0.002 puts the threshold at
    // 512 tokens under a ~9k baseline, and the engine retried every single step.
    // Same floor the loop above uses: without it this probe reports the tiny
    // range the loop just refused as "still compactable" and the error survives.
    const remaining = selectCompactableRange(agent.session, measurement, spec.retainTokens, this.config.summaryFloorTokens, this.config.leafSpanTokens);
    if (remaining === null) {
      engineDebug(
        this.config,
        `pressure exhausted: ${measurement.totalTokens} >= ${spec.thresholdTokens} but nothing is compactable (baseline is above the threshold; lower it or accept this size)`
      );
      return result;
    }
    throw new Error(`compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts (${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`);
  }
  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, retained for signature parity.
   * @param signal - optional cancellation signal.
   * @returns the successful durable compaction result.
   */
  async compactRegion(start, end, agent, signal) {
    return compactSurfaceRegion(this.regionDependencies(), agent.session, start, end, agent, {
      owner: "current-turn",
      stability: "whole-surface"
    }, signal);
  }
  /**
   * Force one useful idle-session compaction below the pressure threshold, and
   * resolve only after its standalone marker pair is durably checkpointed.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  compactNow(agent, signal, sourceCommandId) {
    signal.throwIfAborted();
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal]);
        try {
          operationSignal.throwIfAborted();
          const measurement = this.ctx.tokenMeter.measure(agent.session);
          // Manual /compact follows basic: retain 0 tokens, i.e. compact the whole
          // history except the trailing node, independent of the pressure policy.
          const range = selectCompactableRange(agent.session, measurement, 0);
          if (range === null) return null;
          return await compactSurfaceRegion(this.regionDependencies(), agent.session, range.start, range.end, agent, {
            owner: null,
            stability: "selected-span",
            ...sourceCommandId === undefined ? {} : { sourceCommandId },
            flush: async () => {
              await this.ctx.sessions.flush(agent.session);
            }
          }, operationSignal);
        } catch (error) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) throw new ManualCompactionError("cancelled", "manual compaction was cancelled", { cause: error });
          operationSignal.throwIfAborted();
          throw error;
        }
      });
    } catch (error) {
      throw new ManualCompactionError("busy", "manual compaction requires an idle agent with no waking queued work", { cause: error });
    }
  }
  /** Bind the effective token meter, the compile hook, and the summary-recovery waterfall. */
  regionDependencies() {
    return {
      meter: this.ctx.tokenMeter,
      compile: (prepared, owner, abort) => this.compile(prepared, owner, abort),
      // The recovery seam every summarization backend exposes under
      // `compaction/summary-error`; this is what `dsh-compaction-image-offload`
      // listens on to offload the oldest retained images when a route answers
      // `IMAGE_OFFLOAD_REQUIRED`. Without it the listener can never fire and an
      // image-heavy region is unrecoverable. `false` is the documented default:
      // the region transaction rethrows the original error.
      recover: (error, agent, sourceEventSeqs, signal) => this.ctx.waterfall("compaction/summary-error", {
        session: agent.session,
        sourceEventSeqs,
        error,
        ...signal === undefined ? {} : { signal }
      }, () => false)
    };
  }
}

export default LcmCompactionEngine;
