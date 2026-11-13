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
import { COMPILER_REV, estimateEntryTokens, isCheckpointSource, renderEventBody } from "./compiler.js";
import { resolveEventAt, sessionEvents } from "./events.js";
import { describeError, engineDebug } from "./debug.js";
import {
  TargetPressureConfigError,
  resolveCompactSpec,
  resolveConfig,
  resolveSummaryBudget,
  resolveTargetPolicy
} from "./config.js";
import { LeafPrepCache, preparedLeafKey } from "./prep.js";
import { appendAssertions, buildAssertionInstruction, markMined, parseAssertions, readMined, unminedCheckpoints } from "./assertion.js";
import { appendRollup, buildRollupInstruction, buildRollupRecord, isChronology, pendingRollups, planDayRollups, readRollups } from "./rollup.js";
import { assertNoActiveCompaction, compactSurfaceRegion, prepareCompaction, selectCompactableRange, validateSurfaceRegion } from "./region.js";
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

/**
 * The completion ceiling `summarizeLeaf` sends for one summary target.
 *
 * Not the target itself. A summary-sized cap was measured spending the whole
 * completion budget on hidden reasoning (`max-tokens` finish, ZERO text), and no
 * cap at all was measured substituting the provider's own smaller default (a run
 * cut mid-word at 7 734 characters with only the anchor section written, against
 * 8 817 characters and all six sections at an explicit 32 768). Twice the target,
 * floored at 4 096, is what the summarizer sends — so it is also the only honest
 * value for the record's `maxTokens`, which `dsh-compaction/types` documents as
 * "the generation cap the summarize call sent" and which `dsh-compaction-basic`
 * records straight off its own `options.maxTokens`.
 *
 * `./summarize.js` holds the formula because it builds the request. This copy
 * exists only so the durable record can state the number that was actually sent;
 * `test/contract-fields.test.js` pins the recorded value against the options the
 * stub transport received, so the two cannot drift apart silently.
 * @param targetTokens - the summary target named in the instruction.
 * @returns the completion ceiling that accompanies it.
 */
function requestCeilingTokens(targetTokens) {
  return Math.max(4096, targetTokens * 2);
}

/**
 * The exact provider/model `summarizeLeaf` routes one leaf summary through.
 *
 * Needed by the deterministic rung: the engine, not a model, writes that body,
 * but `compaction/summary` requires non-empty `provider`/`model` strings and a
 * payload carrying `undefined` cannot be appended at all (see `./region.js`).
 * The resolved target is the honest answer there — it is the route that WAS
 * tried, its empty responses are what forced the fallback, and the entry header
 * already says in so many words that the body is not a model summary.
 *
 * Resolution mirrors `./summarize.js` (`configured ?? routed ?? agent options`,
 * with the exact-route `modelPolicies` row merged first), because reading
 * `summarizationProvider` off the top-level config once ignored an override.
 * A test pins this copy against the route the transport actually received.
 * @param config - resolved engine configuration.
 * @param agent - supplies the durable routed header and the fallback route.
 * @returns the resolved route; `undefined` when no route was ever resolved.
 */
function resolveSummarizationTarget(config, agent) {
  const routed = agent?.session === undefined ? undefined : routedTarget(agent.session);
  const options = agent?.options ?? {};
  const agentTarget =
    typeof options.provider === "string" && options.provider.length > 0 &&
    typeof options.model === "string" && options.model.length > 0
      ? { provider: options.provider, model: options.model }
      : undefined;
  const conversation = routed ?? agentTarget;
  const policy = conversation === undefined ? config : resolveTargetPolicy(config, conversation);
  return policy.summarizationProvider.length > 0
    ? { provider: policy.summarizationProvider, model: policy.summarizationModel }
    : conversation;
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
  // Nothing was cut, so nothing may be said. This rung is reached both by bodies
  // that overrun and by a deterministic body built to fit (see compile), and the
  // unconditional `text + note` labelled the second kind as truncated: measured on
  // a 6-node span that fit completely (397 tokens, 6/6 seqs present) the checkpoint
  // still told the reader the tail had been cut deterministically. A warning that
  // fires when nothing happened is worse than no warning — it teaches the reader to
  // ignore it on the run where it is true.
  if (estimateEntryTokens(text) <= available) return text;
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

/**
 * The deterministic rung: build a checkpoint body from the span itself, no model.
 *
 * lcm-x's level 3 is "deterministic truncation — no LLM, guaranteed convergence",
 * and its ladder reaches it whenever the model produces nothing usable - an empty
 * answer included. Ours only reached a degraded result on the too-long path and
 * threw on the empty path, so a reasoning-only response failed the compaction.
 *
 * The body keeps the message bodies verbatim in order, cut to the budget at a line
 * boundary. It is a worse summary than the model's and it is honest about that:
 * the header says so, and the pointer line still tells the agent how to read the
 * original. Degraded coverage beats no coverage, which is the whole point of the
 * rung.
 * @param prepared - the priced span snapshot.
 * @param budgetTokens - target size for the body.
 * @returns a checkpoint body that always fits and is never empty.
 */
function deterministicCheckpoint(prepared, budgetTokens) {
  const lines = [
    "## 逐字锚点",
    "[deterministic: span words, cut to fit]"
  ];
  let used = estimateEntryTokens(lines.join("\n"));
  const cap = Math.max(64, budgetTokens);
  for (const seq of prepared.shadowedSeqs) {
    const event = resolveEventAt(prepared.session, seq);
    if (event === undefined) continue;
    const rendered = renderEventBody(prepared.session, event);
    for (const line of String(rendered?.body ?? "").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const cost = estimateEntryTokens(trimmed) + 1;
      if (used + cost > cap) return lines.join("\n");
      lines.push(`(seq ${seq}) ${trimmed}`);
      used += cost;
    }
  }
  return lines.join("\n");
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
    `Every state section below (${stateHeadings.join(" / ")}) must still carry content: shorten their sentences, never drop or empty a section.`
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
// One key needs a floor of its own. `condensationFanin` is not a size: it is the
// switch that turns on ./region.js's condensation branch AND its skip over the
// checkpoints already on the surface. At 1 the guard `fanin > 1` is false, so the
// automatic path loses both, every leaf re-absorbs its predecessor, and the surface
// holds one checkpoint forever at a growing depth. 1 is therefore not a small value
// of this key, it is the bug this key exists to prevent.
const condensationFaninSchema = z.number().step(1).min(2);
const fullSweepMaxPassesSchema = z.number().step(1).min(1);
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
    condensationFanin: condensationFaninSchema,
    thresholdFullSweep: z.boolean(),
    fullSweepMaxPasses: fullSweepMaxPassesSchema,
    fullSweepMaxSeconds: fullSweepMaxPassesSchema,
    // `min(0)`, not `min(1)`: 0 DISABLES the soft stop and is the shipped default.
    // Declared with the shared positive-integer schema, the value 0 was refused at
    // composition time and `compaction-lcm` never loaded at all — measured:
    //
    //   compaction-lcm (dsh-lcm): ValidationError: invalid config:
    //     $.fullSweepSoftSeconds expected number >= 1 but got 0
    //
    // The engine was absent for a whole session while every offline check passed,
    // because `resolveConfig` in ./config.js accepts 0 and only the schema did not.
    fullSweepSoftSeconds: compactionRetriesSchema,
    fullSweepTargetShare: z.number().min(0).max(1),
    fullSweepReserveSeconds: fullSweepMaxPassesSchema,
    leafEstimateFloorSeconds: fullSweepMaxPassesSchema,
    stallCooldownMs: maxTokensSchema,
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
    backgroundLeafPrep: z.boolean(),
    temporalRollups: z.boolean(),
    rollupBuildsPerPass: fullSweepMaxPassesSchema,
    rollupMaintenanceBudgetMs: fullSweepMaxPassesSchema,
    rollupDailyTargetTokens: fullSweepMaxPassesSchema,
    rollupDailyMaxTokens: fullSweepMaxPassesSchema,
    rollupDir: z.string(),
    assertionExtraction: z.boolean(),
    assertionMaxSourcesPerPass: fullSweepMaxPassesSchema,
    assertionTimeoutSeconds: fullSweepMaxPassesSchema,
    assertionDir: z.string(),
    debug: z.boolean(),
    debugLogPath: z.string(),
    // ── optional vector recall layer (inert unless vectorEnabled) ──
    vectorEnabled: z.boolean(),
    vectorBaseUrl: z.string(),
    vectorModel: z.string(),
    vectorDim: maxTokensSchema,
    vectorTopK: maxTokensSchema,
    vectorTimeoutMs: maxTokensSchema,
    vectorCacheDir: z.string(),
    // The NAME of the environment variable holding the bearer token, not the
    // token. A literal secret in the composition would be a secret in a
    // repository; "" (the default) sends no Authorization header at all, which
    // is what a keyless local backend expects.
    vectorApiKeyEnv: z.string()
  });
  /** Settings namespace for user-owned LCM compaction preferences. */
  /** Resolved and validated compaction configuration. */
  config;
  /**
   * Consecutive `TargetPressureConfigError` suppressions per route, so a
   * permanently misconfigured target warns on a doubling schedule instead of once
   * and never again (see the pre-step listener). Cleared the moment the same
   * route resolves a pressure spec again.
   */
  pressureConfigFaults = new Map();
  overflowRetries = new WeakMap();
  /**
   * Sessions with an idle-continuation pass in flight.
   *
   * A guard against two passes on one session: `agent/status` can fire `idle`
   * more than once (a re-render, a retried turn), and a second pass would only
   * re-measure the same surface and lose the race to the first.
   */
  idlePasses = new Set();
  /**
   * Prepared leaf summaries, keyed by span + route. Empty unless
   * `backgroundLeafPrep` is on.
   *
   * lcm-x keeps its equivalent queue in SQLite so it survives a restart and serves
   * several conversations from one bank. Here the scope is deliberately narrower:
   * memory only, and a restart simply means the next crossing pays a model call.
   */
  leafPrep = new LeafPrepCache();
  /** Sessions with a background prep pass in flight, same role as `idlePasses`. */
  prepPasses = new Set();
  /** Sessions with a rollup maintenance pass in flight. */
  rollupPasses = new Set();
  /** Sessions with an assertion extraction pass in flight. */
  assertionPasses = new Set();
  overflowAgents = new WeakMap();
  constructor(ctx, config = {}) {
    super(ctx);
    this.config = resolveConfig(config);
    engineDebug(this.config, `constructed rev=${COMPILER_REV} debugLog=${this.config.debugLogPath} summaryRatio=${this.config.summaryRatio} cap=${this.config.checkpointCap}`);
    this._autoDisposer = null;
    this._autoActive = false;
    // Per-session stall hold: { tokens, until }. See compactPressure for why a hold
    // exists at all rather than re-deciding every step.
    this.stallBySession = new Map();
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
          // A configuration this engine cannot price is not a transient failure:
          // `resolveCompactSpec` throws BEFORE the pressure gate, so on the
          // pre-step path it raises on EVERY step of every turn, and compaction
          // never runs again for that route until the configuration changes
          // (`retainTokens >= threshold`, or headroom/maxTokens larger than the
          // window — both are reachable from a settings form).
          //
          // The old code returned silently after the FIRST one, so a real
          // misconfiguration switched compaction off permanently behind a single
          // line that was easy to miss, and nothing ever said "switched off".
          // Silence was the defect; a line per step is the noise that produced it.
          // So every occurrence goes to the debug log, and the warning itself
          // repeats on a doubling schedule (1st, 2nd, 4th, 8th, ...) with the
          // suppressed count in it: six lines describe the first sixty steps, and
          // a session that has been unable to compact for thousands of steps keeps
          // saying so instead of falling silent forever.
          const message = describeError(error);
          const suppressed = (this.pressureConfigFaults.get(error.targetKey) ?? 0) + 1;
          this.pressureConfigFaults.set(error.targetKey, suppressed);
          engineDebug(this.config, `step compaction suppressed (${suppressed}x) for ${error.targetKey}: ${message}`);
          if ((suppressed & (suppressed - 1)) === 0) {
            ctx.logger.warn(
              `compaction is switched off by configuration for ${error.targetKey} (${suppressed} suppressed attempt${suppressed === 1 ? "" : "s"}): ${message}. Nothing will be compacted on this route until the configuration is fixed.`
            );
          }
          return next();
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
      // ── the idle continuation ───────────────────────────────────────────
      // A sweep that stops on its soft target leaves the session still over
      // threshold, and the only thing that used to pick it up was the NEXT
      // pre-step — i.e. the next thing the operator types. lcm-x does not have
      // that gap: its corpus work runs in a bounded background pass, so a
      // partial sweep is finished without a user turn.
      //
      // `idle` is the safe place to do the same here, and it is the signal the
      // base engine already trusts (it clears `overflowRetries` on it): nothing
      // is mid-turn, no request is in flight, so a compaction cannot race a
      // live surface edit. The pass is the SAME automatic path, so every guard
      // still applies — threshold, retained tail, span floor, and its own two
      // clocks. A no-op when the session is under threshold.
      //
      // Deliberately not awaited: `agent/status` is a notification, not a
      // middleware chain, and blocking it would stall whatever the host does
      // next. Failures go to the debug log only — an idle pass that cannot make
      // progress must never surface as an error the operator has to dismiss.
      if (status === "idle") this._continueOnIdle(agent);
      // Prep is the opposite case to the idle sweep: it runs when the session is
      // still UNDER threshold, so the next crossing has a leaf already written.
      if (status === "idle") this._prepareNextLeaf(agent);
      // Rollups are time-indexed, not pressure-driven: idle is the only moment they
      // can be built without competing with a request for the model.
      if (status === "idle") this._maintainRollups(agent);
      // Assertions are derived from checkpoints, so they run after the rollup pass and
      // never compete with it: both are idle-only and both are bounded.
      if (status === "idle") this._extractAssertions(agent);
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
   * This is the number written into the instruction ("aim for roughly N tokens").
   * It is NOT the request ceiling: `summarizeLeaf` sends `max(4096, 2 x target)`,
   * because leaving the ceiling unset handed control to the provider's own smaller
   * default and responses were cut before the sections finished. The name keeps its
   * historical spelling because it is also the config key it delegates to
   * (`maxTokens`), which still sets the target.
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
    let result;
    // Named in the entry header rather than only in the body: the body is subject to
    // the truncation rung, so a label that lives in the first lines can be cut. The
    // header always survives.
    let usedDeterministic = false;
    // Who wrote the record and under what cap. `identity` stays undefined unless
    // the deterministic rung has to answer for the body (no model did); the
    // ceiling is the cap the producing call SENT, which is not the instruction
    // target and is absent when no call produced the body at all.
    let identity;
    let sentCeiling;
    // A prepared leaf, if the background pass already computed this exact span on
    // this exact route. Taking it removes one model call from the foreground and
    // the summary it carries was written by the same summarizer under the same
    // instruction — the only thing that changed is WHEN it was paid for.
    const prepKey = this.config.backgroundLeafPrep === true
      ? preparedLeafKey(prepared, resolveSummarizationTarget(this.config, agent))
      : undefined;
    const preparedResult = prepKey === undefined ? undefined : this.leafPrep.take(prepKey);
    try {
      result = preparedResult ?? await summarizeLeaf(this.ctx, this.config, prepared, agent, budget, signal);
      if (preparedResult !== undefined) engineDebug(this.config, `summarize used a prepared leaf span=${prepared.shadowedSeqs.length} (${this.leafPrep.describe()})`);
      // The cap the call actually SENT. It is no longer always the base ceiling:
      // an empty response escalates it (see `ceilingFor`), and the record has to
      // name the number in force or an operator judging "could this have been cut
      // off?" reads the wrong one.
      sentCeiling = result.maxTokens ?? requestCeilingTokens(budget);
    } catch (error) {
      // Two codes are summariser OUTCOMES rather than transport failures: an empty
      // response and a response cut at the provider's cap. A rate limit, a timeout
      // or an abort is neither, and must keep propagating so the harness can route
      // or retry instead of quietly accepting a degraded body.
      if (error?.code !== "SUMMARY_EMPTY" && error?.code !== "MAX_TOKENS") throw error;
      // lcm-x's ladder does not surface an empty summary either:
      // when L1 and L2 both come back empty it falls through to deterministic
      // truncation, whose documented property is "guaranteed convergence". Our
      // version threw after emptySummaryRetries, which meant a model that answered
      // with reasoning only - observed twice in one subagent run - turned into a
      // failed compaction and an unusable span.
      //
      // The deterministic body is built from the span itself, so it cannot be empty
      // and cannot be longer than the budget.
      // Built to the *target*, then put through the same truncation rung as an
      // over-long model body: the shrink gate compares against the span, and a
      // small span makes the target larger than the bound.
      usedDeterministic = true;
      // The record still has to name a route. Nothing model-authored is left to
      // name, so the honest value is the target this rung resolved and tried:
      // `compaction/summary.provider|model` are REQUIRED non-empty strings, and a
      // payload with `undefined` in them cannot be appended at all — measured,
      // `snapshotJsonValue({provider: undefined, model: "m"})` rejects the whole
      // payload, so the commit threw after `compaction/start` had landed and the
      // surface never shrank. The entry header already labels the body
      // "DETERMINISTIC fallback, not a model summary", so naming the route does
      // not claim authorship. No ceiling is recorded: no call produced this body.
      identity = resolveSummarizationTarget(this.config, agent);
      const headroom = Math.max(32, limit - headerTokens(prepared, budget));
      const fallback = truncateToBudget(deterministicCheckpoint(prepared, budget), headroom);
      engineDebug(this.config, `summarize escalated to deterministic body after empty responses tokens=${estimateEntryTokens(fallback)} shadowed=${limit}`);
      result = { summary: [{ type: "text", text: fallback }] };
    }
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
      sentCeiling = requestCeilingTokens(aggressiveBudget);
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
        text: `[lcm leaf summary${usedDeterministic ? " · DETERMINISTIC fallback, not a model summary" : ""} · ${prepared.shadowedSeqs.length} nodes · seqs ${prepared.start}-${prepared.end} · ~${prepared.shadowedTokenCount} → ~${tokens} tokens · anchors below carry (seq N): restore with lcm_expand, or find anything else with lcm_search]\n${text}`,
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
      // `??` rather than a ternary on `usedDeterministic`: the identity is a
      // property of the body that was actually kept, not of the branch taken.
      provider: result.provider ?? identity?.provider,
      model: result.model ?? identity?.model,
      maxTokens: sentCeiling,
      usage: result.usage,
      rawOutput: result.rawOutput
    };
  }
  /**
   * Mine the checkpoints that have no assertions yet. lcm-x's
   * `assertion_extraction_enabled`, off by default.
   *
   * A checkpoint is prose, so "which host did we flash and when" is a reading
   * comprehension task over a paragraph. An assertion is the same fact as a triple
   * with the seq it came from, which makes that question a scan over short rows and
   * keeps the citation: every row names the checkpoint that `lcm_expand` can open.
   *
   * Bounded on both axes like the reference (`assertion_max_sources_per_pass: 4`,
   * `assertion_extraction_timeout_seconds: 30`), and it stamps the deadline into the
   * abort signal so a slow model cannot hold the pass open past its budget.
   * @param agent - the agent that just went idle.
   */
  _extractAssertions(agent) {
    if (this.config.assertionExtraction !== true) return;
    const session = agent?.session;
    if (session === undefined) return;
    if (this.assertionPasses.has(session.id)) return;
    this.assertionPasses.add(session.id);
    void (async () => {
      try {
        const mined = readMined(this.config.assertionDir, session.id);
        const pending = unminedCheckpoints(sessionEvents(session), mined).slice(0, this.config.assertionMaxSourcesPerPass);
        if (pending.length === 0) return;
        const deadline = AbortSignal.timeout(this.config.assertionTimeoutSeconds * 1000);
        let extracted = 0;
        for (const event of pending) {
          if (deadline.aborted) break;
          const body = (event.data?.summary ?? []).map((block) => block.text ?? "").join("");
          if (body.trim().length === 0) continue;
          // Same shape as the rollup path and for the same reason: a checkpoint seq is
          // not a message event, so the body has to travel as a DOCUMENT.
          const prepared = {
            session,
            documents: [{ seq: event.seq, text: body }],
            shadowedSeqs: [event.seq],
            shadowedTokenCount: estimateEntryTokens(body),
            start: event.seq,
            end: event.seq
          };
          const result = await summarizeLeaf(this.ctx, this.config, prepared, agent, 1024, deadline, undefined,
            buildAssertionInstruction(event.seq));
          const rows = parseAssertions(summaryBodyOf(result), event.seq);
          appendAssertions(this.config.assertionDir, session.id, rows);
          // An empty extraction is a real answer, so it is recorded in the LEDGER,
          // not as a sentinel row: a fake fact in the store would surface in every
          // search, and leaving the seq unrecorded would pay for the same nothing on
          // every idle.
          markMined(this.config.assertionDir, session.id, event.seq, rows.length);
          extracted += 1;
        }
        if (extracted > 0) engineDebug(this.config, `assertions mined from ${extracted} checkpoint(s)`);
      } catch (error) {
        engineDebug(this.config, `assertion pass skipped: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.assertionPasses.delete(session.id);
      }
    })();
  }

  /**
   * Build the day rollups that are missing or stale, bounded by the two knobs
   * lcm-x uses: `rollupBuildsPerPass` and `rollupMaintenanceBudgetMs`.
   *
   * A checkpoint has no time semantics: its seq range describes WHICH span it
   * replaced, not when the work happened. So "what did we do on the 11th" cannot be
   * answered by walking the DAG — it needs a view over a time slice, which is what
   * this builds and stores in `rollupDir`.
   *
   * Off is available (`temporalRollups: false`) but the default is on, matching
   * `temporal_rollups_enabled: bool = True`. The pass is bounded on both axes, so
   * "on" costs at most two calls and five seconds per idle, only when a day is
   * actually new or its checkpoints changed.
   * @param agent - the agent that just went idle.
   */
  _maintainRollups(agent) {
    if (this.config.temporalRollups !== true) return;
    const session = agent?.session;
    if (session === undefined) return;
    if (this.rollupPasses.has(session.id)) return;
    this.rollupPasses.add(session.id);
    const startedAt = Date.now();
    void (async () => {
      try {
        const planned = planDayRollups(sessionEvents(session));
        if (planned.length === 0) return;
        const stored = readRollups(this.config.rollupDir, session.id);
        const pending = pendingRollups(planned, stored);
        if (pending.length === 0) return;
        const header = session.requestHeader();
        const target = header?.config;
        if (target === undefined || target.provider.length === 0 || target.model.length === 0) return;
        let built = 0;
        for (const day of pending) {
          if (built >= this.config.rollupBuildsPerPass) break;
          if (Date.now() - startedAt >= this.config.rollupMaintenanceBudgetMs) break;
          const budget = Math.min(this.config.rollupDailyTargetTokens, this.config.rollupDailyMaxTokens);
          // The bodies go in as DOCUMENTS. A checkpoint seq is not a message event,
          // so deriving the prompt from seqs produced zero messages and this pass
          // threw on every idle without ever writing a file.
          const documents = [];
          for (const entry of day.entries) {
            const event = session.eventAt?.(entry.seq);
            const text = (event?.data?.summary ?? []).map((block) => block.text ?? "").join("");
            if (text.trim().length > 0) documents.push({ seq: entry.seq, text });
          }
          if (documents.length === 0) continue;
          const prepared = {
            session,
            documents,
            shadowedSeqs: day.entries.map((entry) => entry.seq),
            shadowedTokenCount: day.tokens,
            start: day.entries[0].seq,
            end: day.entries[day.entries.length - 1].seq
          };
          const result = await summarizeLeaf(this.ctx, this.config, prepared, agent, budget, undefined, undefined,
            buildRollupInstruction(day.periodStart, budget));
          const text = summaryBodyOf(result).trim();
          if (text.length === 0) continue;
          // A body that is not a chronology is not a rollup. Measured failure: a
          // 3 070-token day came back as "I'll start by locating the checkpoint
          // bodies." — 14 tokens, and nothing downstream noticed because the store
          // accepted any non-empty text.
          //
          // Not stored, and not marked built either: `pendingRollups` decides that
          // from the fingerprint, so leaving the day unwritten means the next idle
          // retries it. That is the right answer for a bad answer — a retry costs
          // one call, and storing prose costs every future reader.
          if (!isChronology(text)) {
            engineDebug(this.config, `rollup rejected ${day.periodStart}: answer is not a chronology (${text.length} chars)`);
            continue;
          }
          appendRollup(this.config.rollupDir, session.id, buildRollupRecord(day, text));
          built += 1;
          engineDebug(this.config, `rollup built ${day.periodStart} seqs=${prepared.shadowedSeqs.length} source=${day.tokens}`);
        }
      } catch (error) {
        engineDebug(this.config, `rollup pass skipped: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.rollupPasses.delete(session.id);
      }
    })();
  }

  /**
   * Pre-compute the leaf the NEXT compaction would need, while the session is idle
   * and still below its threshold. lcm-x's `background_leaf_prep_enabled`, off by
   * default.
   *
   * The point is the clock, not the tokens: a sweep is bounded at 60 s soft / 120 s
   * hard, and one leaf costs ~17 s, so a crossing spends its entire budget writing
   * summaries it could have written earlier. Preparing one leaf ahead means the
   * next crossing promotes it and spends its clock on the leaf AFTER that.
   *
   * Refuses to run over threshold: there a sweep is already owed, and pre-computing
   * a leaf would compete with the pass that is supposed to commit it.
   *
   * Never throws — the caller is a status notification with no turn to fail.
   * @param agent - the agent that just went idle.
   */
  _prepareNextLeaf(agent) {
    if (this.config.backgroundLeafPrep !== true) return;
    if (!this.leafPrep.hasCapacity) return;
    const session = agent?.session;
    if (session === undefined) return;
    // One prep at a time per session: two would select the same leaf and pay twice.
    if (this.prepPasses.has(session.id)) return;
    this.prepPasses.add(session.id);
    void (async () => {
      try {
        const header = session.requestHeader();
        const target = header?.config;
        if (target === undefined || target.provider.length === 0 || target.model.length === 0) return;
        const policy = resolveTargetPolicy(this.config, target);
        const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model);
        const context = info.context;
        if (context === undefined) return;
        const spec = resolveCompactSpec(policy, context.contextWindow, reservedCompletionTokens(header, info.defaultMaxTokens));
        const measurement = this.ctx.tokenMeter.measure(session, header);
        // Over threshold means a sweep is owed; leave the leaf for it.
        if (measurement.totalTokens >= spec.thresholdTokens) return;
        const range = selectCompactableRange(session, measurement, spec.retainTokens, this.config.summaryFloorTokens, this.config.leafSpanTokens, this.config.condensationFanin);
        if (range === null) return;
        // The same two steps `compactSurfaceRegion` takes before it compiles, minus
        // the transaction: this pass writes nothing, it only pays for a summary the
        // foreground may later promote.
        const selection = validateSurfaceRegion(session, range.start, range.end);
        const prepared = prepareCompaction(this.regionDependencies(), session, selection);
        if (prepared === null) return;
        const route = resolveSummarizationTarget(this.config, agent);
        const key = preparedLeafKey(prepared, route);
        if (this.leafPrep.has(key)) return;
        const budget = this.effectiveMaxTokens(prepared.shadowedTokenCount);
        const result = await summarizeLeaf(this.ctx, this.config, prepared, agent, budget, undefined);
        // The same guard the foreground applies: a body at least as long as the span
        // cannot survive the shrink gate, so caching it would only turn a paid call
        // into a paid call plus a wasted slot.
        const kept = estimateEntryTokens(summaryBodyOf(result));
        if (kept <= 0 || kept >= prepared.shadowedTokenCount) {
          engineDebug(this.config, `prep discarded a body that cannot shrink kept=${kept} span=${prepared.shadowedTokenCount}`);
          return;
        }
        this.leafPrep.put(key, result);
        engineDebug(this.config, `prep stored a leaf seqs=${range.start}-${range.end} kept=${kept} (${this.leafPrep.describe()})`);
      } catch (error) {
        engineDebug(this.config, `prep skipped: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.prepPasses.delete(session.id);
      }
    })();
  }

  /**
   * Continue a sweep that stopped on its soft target, once the agent is idle.
   *
   * The soft target exists so a leaf never overruns the hard ceiling, which means
   * a sweep deliberately stops with the session still over threshold. Before this,
   * the only thing that resumed it was the next `agent/pre-step` — i.e. the
   * operator typing something. lcm-x has no such gap: its corpus maintenance runs
   * in a bounded background pass, so a partial sweep finishes without a user turn.
   *
   * `idle` is the safe moment here. It is the signal the base engine already
   * trusts (it clears `overflowRetries` on it), nothing is mid-turn and no request
   * is in flight, so a compaction cannot race a live surface edit. The pass is the
   * SAME automatic path, so every guard still applies: threshold, retained tail,
   * span floor, its own two clocks. Under threshold it is a no-op that returns
   * before any model call.
   *
   * Not awaited by the caller: `agent/status` is a notification, not middleware.
   * One in-flight pass per session, because a second one would only re-measure the
   * same surface and lose the race to the first.
   * @param agent - the agent that just went idle.
   */
  _continueOnIdle(agent) {
    const id = agent?.session?.id;
    if (id === undefined) return;
    if (this.idlePasses.has(id)) return;
    this.idlePasses.add(id);
    // A detached promise, so the host's idle handling is never blocked. The
    // catch is the only place an idle failure can go: there is no turn to fail.
    void (async () => {
      try {
        const result = await this.compactIfNeeded(agent, "pressure", undefined);
        if (result !== null) {
          this.ctx.logger.info(
            `compaction (idle): shadowed ${result.shadowedSeqs.length} surface nodes (seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`
          );
        }
      } catch (error) {
        // Under threshold, misconfigured, or nothing compactable: all of these are
        // ordinary answers to "is there work?", and none of them is worth an error
        // the operator has to dismiss. The debug log keeps them findable.
        engineDebug(this.config, `idle compaction skipped: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.idlePasses.delete(id);
      }
    })();
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
        // No leaf cap on this trigger: `0` is the selector's "no ceiling".
        //
        // The leaf cap exists so a PRESSURE compaction produces bounded leaves —
        // many small summaries that condense into a DAG instead of one
        // ever-deeper checkpoint. Overflow recovery is the opposite case: the
        // provider has already refused the request, so the pass has to remove as
        // much as the measurement needs, in one attempt. Measured on a 60 725-token
        // / 81-node session, `dsh-compaction-basic` selected 59 961 tokens (79
        // nodes) and landed the request back under the window in one pass, while
        // the leaf cap (24 000) held this engine to 24 288 tokens (32 nodes) — with
        // the default `maxOverflowRetries: 1` that can return still over the
        // window where the reference backend would have fit. The span floor and the
        // fanin stay as they are: the floor is what refuses a span no summary could
        // undercut, and the fanin is what keeps an overflow pass from
        // re-summarising its own checkpoint.
        const range = selectCompactableRange(agent.session, measurement, 0, this.config.summaryFloorTokens, 0, this.config.condensationFanin);
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
    // The route priced successfully, so any previous config fault on it is over:
    // the suppression counter is "consecutive failures", which is what makes the
    // pre-step warning schedule restart from 1 after a fix.
    this.pressureConfigFaults.delete(`${target.provider}/${target.model}`);
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
    if (measurement.totalTokens < spec.thresholdTokens) {
      // Below the gate: whatever stalled is irrelevant now, and the next crossing
      // must be evaluated fresh.
      this.stallBySession.delete(agent.session.id);
      return null;
    }
    // lcm-x holds a stalled session instead of re-deciding it on every step:
    // `_no_progress_hold` is a monotonic deadline, and while it is armed
    // `should_compress` returns False before any work happens ("never latches; it
    // ends at its time, a stored leaf clears it"). We simply re-ran the whole
    // evaluation every step and logged the same decline each time - which is why
    // "over threshold with nothing worth compacting" looked like a hang.
    //
    // The hold is released by any of three real changes: a stored checkpoint, the
    // session growing by another leaf's worth (new material to compact), or the
    // deadline expiring.
    const stall = this.stallBySession.get(agent.session.id);
    if (stall !== undefined && !requireBelowThreshold) {
      const grew = measurement.totalTokens >= stall.tokens + this.config.leafSpanTokens;
      if (!grew && Date.now() < stall.until) return null;
      this.stallBySession.delete(agent.session.id);
    }
    // ── lcm-x's threshold full sweep ──────────────────────────────────────
    // A crossing is a SWEEP, not a single leaf. Measured on a real 1M-window
    // session (807 187 tok = 80.7%): one leaf of 24 000 landed at 783 136
    // (78.3%), the very next cross released another, and the session stayed
    // welded to the threshold paying one full model call per 2.4% of window.
    //
    // The reference backend (`threshold_full_sweep_enabled`, default True) raises
    // its leaf-pass budget to 12 on a crossing and runs until the raw backlog
    // outside the fresh tail is drained — not until the threshold is merely
    // re-cleared. The total work to move a 650k span is the same either way; the
    // difference is that a sweep pays it once instead of spreading it over 27
    // crossings, each of which leaves the session sitting at ~80% and therefore
    // paying an 800k-token prompt on EVERY request in between.
    //
    // A manual request keeps the retry budget: `requireBelowThreshold` is a model
    // switch that must report why it cannot admit the new model, and "the sweep
    // stopped after its pass budget" is not that answer.
    const sweep = this.config.thresholdFullSweep && !requireBelowThreshold;
    const passBudget = sweep ? this.config.fullSweepMaxPasses : spec.compactionRetries + 1;
    // Passes are not a spend guard on their own when a pass is slow: twelve
    // 30-second leaves is six minutes inside one step, and the session is blocked
    // for all of it. lcm-x bounds the same sweep by wall clock and records a
    // partial stop so the next turn continues; so does this.
    const sweepStart = Date.now();
    // `usableDeadline`, not the raw ceiling: lcm-x computes
    // `t0 + hard - finalize_reserve` and reserves that slice for the commit and
    // the re-measure that follows the last leaf. Without it the hard clock is a
    // promise the loop cannot keep — a leaf admitted at 599 s still has to write
    // its checkpoint afterwards.
    const sweepReserveMs = this.config.fullSweepReserveSeconds * 1000;
    const sweepDeadline = sweep
      ? sweepStart + this.config.fullSweepMaxSeconds * 1000 - sweepReserveMs
      : Number.POSITIVE_INFINITY;
    // TWO clocks, not one. lcm-x splits the same budget into a soft target and a
    // hard ceiling (`_foreground_budget_seconds`, engine.py:2120):
    //
    //   hard = foreground_hard_seconds  (0 -> _THRESHOLD_FULL_SWEEP_MAX_SECONDS)
    //   soft = foreground_soft_seconds  (default 60), clamped to at most hard
    //   usable_deadline = t0 + hard - finalize_reserve
    //
    // and `admit()` refuses to START a call once `now + estimate > t0 + soft`,
    // while `usable_left < MIN_CALL_SECONDS` refuses even the first one. So the
    // effective stop in the reference is the SOFT target; `hard` only bounds a
    // call that is already running, which no budget can interrupt.
    //
    // Without the soft layer our deadline was a pure wall clock: a 17 s leaf
    // started with 5 s left still ran, landing 12 s past the budget. The soft
    // target is what makes the stop predictable, and the reserve is what keeps
    // the finalize (commit + re-measure) inside the ceiling.
    // The sweep TARGET, which is what decides when to stop — the clock only bounds
    // a pass that cannot reach it. lcm-x works the same way and that is why its 60 s
    // soft target is enough: `sweep_target_tokens = min(leaf_chunk_tokens,
    // threshold * 0.25)` (`compaction.py:2258-2260`) and the loop runs until the
    // summary prefix is under it.
    //
    // We had the clock alone. Measured consequence: a session at 705 375 tokens
    // owed 26 leaves to reach its floor, and at 3-4 leaves per crossing that is 8
    // crossings — the reported "compacted 3 times and still at 70%".
    //
    // The target is a TOKEN BUDGET TO RECLAIM, not a summary-frontier size, because
    // this engine has no separate frontier: the surface is the frontier. So a sweep
    // stops when it has reclaimed this much, which is the same thing expressed in
    // the quantity the loop can actually measure.
    const sweepTargetTokens = sweep
      ? Math.floor(spec.thresholdTokens * this.config.fullSweepTargetShare)
      : 0;
    const sweepFloorTokens = sweep ? measurement.totalTokens - sweepTargetTokens : 0;
    // `0` disables the soft stop entirely (lcm-x guards its own test with `soft > 0`
    // and `force` sets it to 0). Without this, 0 would evaluate to `sweepStart` and
    // refuse the second leaf on every sweep — the opposite of what 0 means.
    const softDeadline = sweep && this.config.fullSweepSoftSeconds > 0
      ? sweepStart + this.config.fullSweepSoftSeconds * 1000
      : Number.POSITIVE_INFINITY;
    // How long one leaf takes, so "is there room for another one" is a question
    // the loop can answer. Seeded from the config floor and replaced by the
    // measured wall of each pass: lcm-x uses the p90 of the last eight calls per
    // route (cold 30 s, floor 15 s); one route here, so the last pass is enough,
    // clamped the same way.
    let leafWallMs = this.config.leafEstimateFloorSeconds * 1000;
    let result = null;
    let passes = 0;
    let sweepStop = "";
    for (; passes < passBudget; passes += 1) {
      const now = Date.now();
      // ── the three admission tests, in lcm-x's order ──────────────────────
      // `admit()` (escalation.py:159) refuses to START a call when
      //   1. the hard clock has no usable time left,
      //   2. the estimate does not fit in what is left, or
      //   3. the estimate would carry the call past the SOFT target.
      // All three need the estimate, which is why the estimate comes first here.
      //
      // The first pass is exempt from 2 and 3: with nothing measured, refusing it
      // would mean never learning the leaf cost at all. lcm-x exempts it the same
      // way (`if not self.progress`), but still applies a 15 s floor to test 1.
      if (passes > 0 && now >= sweepDeadline) {
        sweepStop = "time_budget_exhausted";
        break;
      }
      if (passes > 0 && now + leafWallMs > sweepDeadline) {
        // No room for one more leaf even before the soft target: this is the hard
        // clock answering through the estimate rather than through elapsed time,
        // which is what stops a leaf being admitted 5 s before the ceiling.
        sweepStop = "time_budget_exhausted";
        break;
      }
      // ── the target test, which is what actually ends a productive sweep ──
      // Ahead of the soft clock on purpose: a pass that has reclaimed its share is
      // done, and saying so is more honest than reporting a clock stop for work that
      // finished. lcm-x's loop is shaped the same way — `sweep_summary_prefix_before
      // > sweep_target_tokens` is the continuation condition, the clock is the
      // backstop beneath it.
      if (passes > 0 && sweep && measurement.totalTokens <= sweepFloorTokens) {
        sweepStop = "target_reached";
        break;
      }
      if (passes > 0 && now + leafWallMs > softDeadline) {
        // A clock stop with the target still unmet is a PARTIAL pass, and the report
        // says so rather than implying the backlog is gone.
        sweepStop = measurement.totalTokens <= sweepFloorTokens ? "target_reached" : "soft_target_reached";
        break;
      }
      // The span floor is what stops the "span=1 seqs=24-24 shadowedTokens=428
      // budget=512" attempt: at 428 tokens the resolved budget is clamped to
      // summaryFloorTokens (512), so the checkpoint could never be smaller and
      // the call was guaranteed to fail after paying for it.
      const range = selectCompactableRange(agent.session, measurement, spec.retainTokens, this.config.summaryFloorTokens, this.config.leafSpanTokens, this.config.condensationFanin);
      if (range === null) {
        // Silence here was misleading: "over threshold but nothing to compact" and
        // "compaction is broken" looked identical in the log. Measured case - a
        // 14 372-token session with retainTokens 4 472 leaves ONE 233-token node
        // compactable, and the span floor refuses it (233 <= 2 x 512), so the
        // session stays over its threshold and nothing happens, correctly.
        engineDebug(
          this.config,
          `pressure stalled: ${measurement.totalTokens} >= ${spec.thresholdTokens} but no range passed the guards (retain=${spec.retainTokens} floor=${this.config.summaryFloorTokens} leaf=${this.config.leafSpanTokens} fanin=${this.config.condensationFanin}); holding until a stored checkpoint, +${this.config.leafSpanTokens} tokens, or ${this.config.stallCooldownMs}ms`
        );
        // Arm the hold so the next steps do not re-decide the same question. A
        // manual request (requireBelowThreshold) is never held: the operator asked
        // for an answer, and "nothing to compact" is that answer.
        if (!requireBelowThreshold) {
          this.stallBySession.set(agent.session.id, {
            tokens: measurement.totalTokens,
            until: Date.now() + this.config.stallCooldownMs
          });
        }
        // A step-boundary attempt that cannot make progress is a no-op; a model
        // switch that cannot is a refusal, because admitting the new model would
        // send an over-threshold request.
        if (result === null && !requireBelowThreshold) return null;
        if (result === null) throw new Error(`no safe compaction range can reduce ${targetKey} context below its threshold (${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`);
        /* v8 ignore next -- paired with the defensive post-success branch above. */
        break;
      }
      const leafStarted = Date.now();
      result = await this.compactRegion(range.start, range.end, agent, signal);
      // The measured cost of the leaf just written, which is what the next pass's
      // "is there room for another one" test uses. Clamped to the same floor and
      // ceiling lcm-x uses for its estimate (15 s .. hard budget), so one freak
      // slow leaf cannot end the sweep early on its own.
      leafWallMs = Math.min(
        Math.max(Date.now() - leafStarted, this.config.leafEstimateFloorSeconds * 1000),
        this.config.fullSweepMaxSeconds * 1000
      );
      // A stored checkpoint is the one unambiguous progress signal, and lcm-x clears
      // its hold on exactly that. Anything that reaches here has a new node on the
      // surface, so the session is no longer stalled.
      this.stallBySession.delete(agent.session.id);
      measurement = meter.measure(agent.session, header);
      // A SWEEP does not stop on re-clearing the threshold — that is exactly the
      // tick this key exists to remove. It stops when the raw prefix is drained
      // (the next selection returns null) or when its pass budget is spent.
      if (!sweep && measurement.totalTokens < spec.thresholdTokens) return result;
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
    const remaining = selectCompactableRange(agent.session, measurement, spec.retainTokens, this.config.summaryFloorTokens, this.config.leafSpanTokens, this.config.condensationFanin);
    if (remaining === null) {
      engineDebug(
        this.config,
        `pressure exhausted: ${measurement.totalTokens} >= ${spec.thresholdTokens} but nothing is compactable (baseline is above the threshold; lower it or accept this size)`
      );
      return result;
    }
    // A sweep that ran out of budget is a PARTIAL progress report, not a failure:
    // lcm-x records the same stop reasons and lets the next turn continue. It is
    // only a failure when nothing was written at all, which the loop above already
    // turned into a return/throw.
    if (sweep && result !== null) {
      engineDebug(
        this.config,
        `sweep stopped (${sweepStop.length > 0 ? sweepStop : "pass_budget_exhausted"}) after ${passes} leaf pass(es): ${measurement.totalTokens} tokens, target ${sweepFloorTokens}, threshold ${spec.thresholdTokens}; ${measurement.totalTokens <= sweepFloorTokens ? "target met" : "the next pass continues"}`
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
          // Manual /compact is lcm-x's `compress(force=True)`, and that means LEAF
          // granularity with the SOFT target off — not one call over everything.
          //
          // `force` changes exactly one clock in the reference (`compaction.py:2250`):
          //
          //     if force or state.force_overflow:
          //         state.budget.soft = 0.0   # soft is for AUTOMATIC compactions
          //
          // Leaf selection is untouched, so a manual pass still walks
          // `_select_oldest_leaf_chunk(candidate_raw, leaf_chunk_tokens)` with
          // `leaf_chunk_tokens = 24_000`. Only `force_overflow` — the provider-refused
          // request — takes `leaf.to_compact = candidate_raw`, i.e. the whole span in
          // one call.
          //
          // We had that backwards: the manual path passed a leaf cap of 0, so it sent
          // the entire surface as one summarizer prompt. Measured on the macOS build
          // session: 2 506 nodes / 686 174 tokens in one call, capped at 120 anchor
          // lines — 0.05 anchors per node against 2.67 for a leaf, 36x fewer pointers
          // back into the log, and 95% of the window consumed at 950k with nothing
          // left for output.
          //
          // So: leaves, and the hard clock bounds the pass. The soft target is 0
          // because the operator asked for this explicitly, and `retain 0` because
          // "compact what you can" is the whole meaning of the command.
          //
          // The fanin is the one shape knob manual compaction keeps, and passing it is
          // not cosmetic: `fanin > 1` is the only branch in ./region.js that skips the
          // checkpoints already on the surface. With fanin 0 every manual run started
          // its leaf at the oldest surface node — the previous checkpoint — so each
          // /compact re-summarised its own last summary and depth grew 1,2,3,... per
          // repeat.
          const deadline = Date.now() + this.config.fullSweepMaxSeconds * 1000;
          let result = null;
          for (;;) {
            operationSignal.throwIfAborted();
            const current = this.ctx.tokenMeter.measure(agent.session);
            const range = selectCompactableRange(agent.session, current, 0, 0, this.config.leafSpanTokens, this.config.condensationFanin);
            if (range === null) return result;
            result = await compactSurfaceRegion(this.regionDependencies(), agent.session, range.start, range.end, agent, {
              owner: null,
              stability: "selected-span",
              ...sourceCommandId === undefined ? {} : { sourceCommandId },
              flush: async () => {
                await this.ctx.sessions.flush(agent.session);
              }
            }, operationSignal);
            if (Date.now() >= deadline) return result;
          }
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
