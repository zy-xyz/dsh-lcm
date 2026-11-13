/**
 * Configuration resolution for `dsh-lcm`.
 *
 * The key surface is a strict superset of `@deepseek-ai/dsh-compaction-basic`:
 * every key basic accepts is accepted here with the same meaning and the same
 * default, so an existing basic configuration drops in unchanged. The LCM-only
 * keys (`summaryRatio`, `summaryFloorTokens`, `checkpointCap`, `debug`,
 * `debugLogPath`) only add behavior; none of them change what the shared keys
 * mean.
 *
 * Budget math mirrors basic exactly:
 *
 *   messageBudget  = contextWindow − reservedCompletionTokens
 *   pressureBudget = messageBudget − headroomTokens
 *   thresholdTokens = floor(min(contextWindow × thresholdRatio, pressureBudget))
 *   retainTokens   = retainTokens ?? floor(messageBudget × retainRatio)
 *
 * The LCM delta appears only in the summary TARGET, which basic derives from
 * `headroomTokens` alone:
 *
 *   targetTokens = clamp(shadowed × summaryRatio, summaryFloorTokens, checkpointCap)
 *
 * "Target" is literal: this number is written into the summarizer instruction
 * ("aim for roughly N tokens"). It is not the request ceiling either — that is
 * `max(4096, 2 x target)`, set in `summarizeLeaf` so the provider's own smaller
 * default cannot cut the response short.
 *
 * @module dsh-lcm/config
 */
import { deepFreeze } from "@deepseek-ai/dsh-util-values";
import {
  DEFAULT_VECTOR_BASE_URL,
  DEFAULT_VECTOR_CACHE_DIR,
  DEFAULT_VECTOR_DIM,
  DEFAULT_VECTOR_ENABLED,
  DEFAULT_VECTOR_MODEL,
  DEFAULT_VECTOR_TIMEOUT_MS,
  DEFAULT_VECTOR_TOPK
} from "./vectors.js";

// ── defaults (basic-compatible values are marked) ──────────────────────────

/**
 * Request-pressure fraction: start compacting at 75% of the window.
 *
 * lcm-x's `context_threshold` default (`config.py:1092`). It was basic's 0.8, and
 * the difference is not cosmetic: on a 1M window the threshold moves from 800 000
 * to 750 000, which is 50 000 tokens of request headroom bought back at the cost
 * of compacting slightly earlier. Measured on the macOS build session, the 80%
 * setting left it hovering at 97% of threshold with 20 sweeps in two days.
 */
const DEFAULT_THRESHOLD_RATIO = 0.75;
/** Capacity reserved for the next completion, matching basic's 65536. */
const DEFAULT_HEADROOM_TOKENS = 65536;
/**
 * Verbatim-tail fraction of the message budget: ~47 000 tokens on a 1M window.
 *
 * Three candidates were measured against the same arithmetic on a 1M window:
 *
 * | ratio | tail | floor | compactable band |
 * |---|---|---|---|
 * | 0.16 (basic) | 149 514 | 250 055 | 499 945 |
 * | 0.05 | 46 723 | 147 264 | 602 736 |
 * | 0.026 (lcm-x's own 24 000) | 24 296 | 124 837 | 625 163 |
 *
 * 0.16 is basic's and it was inherited, not chosen: it leaves the smallest band
 * and the highest floor. lcm-x keeps `fresh_tail_max_tokens = 24_000` verbatim,
 * which is 0.026 here. 0.05 sits between them deliberately — twice lcm-x's tail,
 * because this engine's leaf summaries are coarser than lcm-x's chunked ones and
 * more verbatim recent context compensates, while still buying back 20% of the
 * compactable band that 0.16 gave away.
 */
const DEFAULT_RETAIN_RATIO = 0.05;
/**
 * Summary budget as a fraction of the shadowed span.
 *
 * lcm-x sets `leaf_target_ratio` 0.20 but its floor and cap are BOTH 2 000
 * (`config.py:1487-1489`), so the ratio can never win: every leaf summary is
 * exactly 2 000 tokens no matter how big the source. The three keys here reproduce
 * that exactly — 0.20 / floor 2 000 / cap 2 000 — because a fixed target is the
 * behaviour being matched, not a rounding of it.
 *
 * What it costs: a 24 000-token leaf now keeps 2 000 instead of 2 880, and a span
 * from 24 000 to 157 000 compresses at 12:1 to 78:1 rather than a flat 8:1. Detail
 * that no longer fits is still reachable — the checkpoint carries `(seq N)` anchors
 * into the append-only log and `lcm_search` scans what it omitted — which is the
 * same recovery path the reference relies on.
 */
const DEFAULT_SUMMARY_RATIO = 0.2;
/**
 * Lower bound for one summary, lcm-x `leaf_target_min_tokens`.
 *
 * Also the selector's span floor, doubled: a span at or below twice this could
 * never shrink to under half, so the call is refused before it is paid for.
 */
const DEFAULT_SUMMARY_FLOOR_TOKENS = 2000;
/**
 * Ceiling on one compaction's span, in tokens.
 *
 * 24 000, lcm-x's `leaf_chunk_tokens`, and the number is a FIDELITY choice before
 * it is a cost choice. The anchor list is capped at 120 lines, so anchor density
 * per compacted node falls as the span grows:
 *
 * | span | nodes/leaf | anchors/node |
 * |---|---|---|
 * | 24 000 | ~90 | ~1.35 |
 * | 96 000 | ~355 | ~0.34 |
 *
 * A 4x loss of pointers back into the log. The checkpoint carries `(seq N)` anchors
 * and `lcm_search` can find what it omitted, but a node with no anchor is reachable
 * only by searching — so widening the leaf trades recoverability for throughput.
 *
 * The throughput argument was measured and is real (wall time is bound by the
 * ~2 000-token OUTPUT target, not the input: r=0.11 with output tokens, r=0.32 with
 * input, so a 96k leaf reclaims 94 198 in 37.9 s against 21 479 in 32.3 s). It is
 * also the wrong trade: the sweep budget can be paid in instalments, an anchor that
 * was never written cannot be paid back later.
 *
 * So the budget is what gives, not the span — see `fullSweepMaxSeconds` and the
 * idle continuation that resumes a partial sweep.
 */
const DEFAULT_LEAF_SPAN_TOKENS = 24000;
/**
 * Whether one threshold crossing condenses until the raw prefix is drained,
 * instead of releasing a single leaf.
 *
 * This is lcm-x's `threshold_full_sweep_enabled` (default True there too), and it
 * exists because the one-leaf-per-crossing behaviour measured on a real 1M-window
 * session is not compaction but a tick: crossing at 807 187 tokens (80.7%)
 * released one 24 000-token leaf and landed at 783 136 (78.3%), then crossed
 * again immediately. Each crossing paid a full model call to buy 2.4% of the
 * window, so the session sat welded to the threshold forever.
 *
 * The reference backend's semantics are "crossing = sweep": `max_leaf_passes`
 * is raised to 12 and the loop runs until the raw backlog outside the fresh tail
 * is drained, not until the threshold is merely re-cleared. One crossing then
 * buys a real drop.
 */
const DEFAULT_THRESHOLD_FULL_SWEEP = true;
/**
 * Leaves one full sweep may release (lcm-x's `_THRESHOLD_FULL_SWEEP_MAX_PASSES`).
 *
 * The bound is a spend guard, not a target: a sweep that drains first stops
 * early. 12 leaves of 24 000 is 288 000 tokens, i.e. 28.8% of a 1M window, which
 * is enough to move a session off the threshold in one crossing without turning
 * a single step into an unbounded spend.
 */
const DEFAULT_FULL_SWEEP_MAX_PASSES = 12;
/**
 * Wall-clock budget for one full sweep, in seconds.
 *
 * lcm-x's number, and it stays: a longer budget was measured to be the wrong answer
 * to a slow sweep. Four minutes inside one step is felt, and it buys nothing that a
 * correctly sized target does not buy more cheaply.
 *
 * What it admits, measured over 173 leaves:
 *
 *   120 s - 10 s reserve = 110 s usable
 *   one leaf = 32.3 s median (p100 72.9 s)
 *   => 3 leaves per crossing, 64 437 tokens reclaimed
 *
 * paired with `fullSweepTargetShare` 0.08 so the target lands inside that budget.
 * The pair is the design: the target says what "done" means and the clock bounds a
 * sweep that cannot get there. Setting either without the other produced both
 * failures this file records - a clock with no target stopped wherever it happened
 * to be, and a target with an unreachable clock never reported done.
 */
const DEFAULT_FULL_SWEEP_MAX_SECONDS = 120;
/**
 * When the sweep stops STARTING leaves, leaving room to finish the one running.
 *
 * lcm-x's `foreground_soft_seconds` defaults to 60 with a hard of 120, i.e. half
 * the ceiling, and `admit()` refuses a call once `now + estimate > t0 + soft`.
 * Half is the ratio that keeps a sweep from ending on a truncated leaf; the
 * remaining half pays for the leaf already in flight plus the finalize.
 * Same ratio, same numbers: 60 of 120.
 *
 * 0 DISABLES IT, and that is the default. lcm-x treats 0 the same way (`soft > 0`
 * guards the test, and `force` sets it to 0 outright). The reason is arithmetic:
 * a leaf here costs a median of 19.9 s but has been measured at 72.9 s, so a 60 s
 * soft target can be SHORTER THAN ONE LEAF. When that happens the estimate after
 * the first leaf exceeds the whole budget, the second admission is refused, and the
 * sweep ends after exactly one leaf — measured live on this session: one 72.9 s leaf
 * out of 469 470 tokens reclaimed 22 220 against a 187 500 target, then stopped.
 *
 * A clock that can end a sweep before its target is reachable is not a backstop, it
 * is the binding constraint wearing a backstop's name. So the HARD ceiling is what
 * bounds a sweep, and `fullSweepTargetShare` is what ends it. An operator who wants
 * a short leash sets this to a value at least a few leaf-costs long; 0 keeps the
 * sweep going until the target or the hard clock, whichever comes first.
 */
const DEFAULT_FULL_SWEEP_SOFT_SECONDS = 0;
/**
 * Fraction of the threshold that one sweep aims to drain.
 *
 * lcm-x bounds a sweep by a TARGET rather than by the clock (`sweep_target_tokens
 * = min(leaf_chunk_tokens, threshold * 0.25)`, `compaction.py:2258-2260`). We had
 * the clock alone, so a crossing stopped however much was owed — measured: a
 * session at 705 375 tokens reported "compacted 3 times and still at 70%".
 *
 * 0.25 is lcm-x's share, but its target counts SUMMARY-PREFIX tokens, a much
 * smaller quantity than the raw tokens this engine reclaims. Copied literally onto
 * thresholdTokens it becomes 187 500 tokens, which at the measured 21 479 per leaf
 * is 9 leaves and 291 s — a target the budget cannot reach and the operator does
 * not want to wait for.
 *
 * So the share is sized from the budget, not copied:
 *
 *   hard 120 s (−10 s reserve) / 32.3 s median leaf = 3 leaves
 *   3 x 21 479 = 64 437 tokens = 0.086 of a 750 000 threshold
 *
 * 0.08 makes `target_reached` reachable inside one crossing, which is what makes
 * the stop reason meaningful: a sweep now ends because it finished, not because a
 * clock cut it off mid-backlog. Anything still owed is picked up by the next
 * threshold crossing or by `_continueOnIdle`.
 */
const DEFAULT_FULL_SWEEP_TARGET_SHARE = 0.08;
/**
 * Slice of the hard ceiling reserved for the commit and the re-measure.
 *
 * lcm-x reserves `min(20, max(5, p90(finalize)))` and subtracts it from the hard
 * clock (`usable_deadline = t0 + hard - reserve`). We have no measured finalize
 * history to take a p90 from, so this is the midpoint of their range: a commit
 * plus one meter re-measure on this backend takes a few seconds, and 10 s leaves
 * room for a slow disk without eating a whole leaf.
 */
const DEFAULT_FULL_SWEEP_RESERVE_SECONDS = 10;
/**
 * Floor for the measured leaf cost used by the soft-target test.
 *
 * lcm-x floors its p90 estimate at `_THRESHOLD_FULL_SWEEP_MIN_CALL_SECONDS = 15`.
 * A floor is what stops one fast leaf from admitting a slow successor: with no
 * floor, a 2 s condensation pass would claim the next leaf also costs 2 s.
 */
const DEFAULT_LEAF_ESTIMATE_FLOOR_SECONDS = 15;
/**
 * How many same-depth checkpoints trigger a condensation into one higher node.
 *
 * lcm-x's `condensation_fanin` default is 4. Without a fanin the surface keeps a
 * flat row of depth-1 leaves: every checkpoint is independent and nothing ever
 * produces a rollup, so the assembled context grows linearly with history instead
 * of logarithmically.
 */
const DEFAULT_CONDENSATION_FANIN = 4;
/**
 * How long a stalled session stays held after a pass found nothing worth compacting.
 *
 * Borrowed from lcm-x's `_no_progress_hold`: a monotonic deadline armed when a
 * pass makes no progress, checked before any work happens, cleared by a stored
 * leaf. Re-deciding the same unanswerable question on every step produced the same
 * decline line each time and made "nothing to compact" indistinguishable from a
 * hang. Sixty seconds is long enough that a stalled session stops being re-priced
 * on every step, short enough that it resumes on its own.
 */
const DEFAULT_STALL_COOLDOWN_MS = 60000;
/**
 * Ceiling on one summary's TARGET length: lcm-x `leaf_target_max_tokens`.
 *
 * Equal to the floor on purpose. `resolveSummaryBudget` clamps to
 * `[summaryFloorTokens, checkpointCap]`, so floor == cap collapses the whole
 * formula to that one number — which is exactly what the reference computes
 * (`min(2000, max(2000, span * 0.20))`). A `ratio` that cannot win looks like a
 * bug until you read both constants together; this comment exists so the next
 * reader does not "fix" it.
 *
 * Not a request cap and not a post-hoc gate: a model that overshoots is accepted
 * as-is. The real bound on a compaction transaction is the shrink guarantee in
 * `region.compactSurfaceRegion` (`framedSummaryTokenCount < shadowedRouteTokenCount`).
 */
const DEFAULT_CHECKPOINT_CAP = 2000;
/**
 * Whether a leaf summary anchor list gets `(seq N)` pointers.
 *
 * On by default: attribution is pure local computation over events already in
 * memory — no request, no extra token — and it is what turns the anchor list
 * from a lost citation into an index `lcm_expand` can follow directly.
 */
const DEFAULT_ANCHOR_POINTERS = true;
/**
 * Extra attempts one summary gets when the model returns no text block at all.
 *
 * A reasoning-first backend can spend the whole completion budget on reasoning
 * and emit zero text blocks; that is a sampling accident, not a deterministic
 * failure, and the next attempt usually returns text. Two extra attempts (three
 * total on the same prompt) buys that without turning a broken route into an
 * unbounded spend. Rotation is deliberately not attempted: the prompt and the
 * route stay fixed so the failure stays reproducible.
 */
const DEFAULT_EMPTY_SUMMARY_RETRIES = 2;
/**
 * Pre-compute the next leaf summary in the background. Off by default.
 *
 * lcm-x ships the same feature disabled (`config.py:1494`
 * `background_leaf_prep_enabled: bool = False`). It spends a model call on a
 * session that may never compact, and `_continueOnIdle` already covers the case
 * this was built for — a sweep that stopped on its clock resumes when the agent
 * goes idle. Turning it on trades idle model calls for a cheaper threshold
 * crossing; both are defensible, so it is a switch rather than a decision.
 */
const DEFAULT_BACKGROUND_LEAF_PREP = false;
/**
 * Build day-level temporal rollups in the background. On by default, like lcm-x
 * (`temporal_rollups_enabled: bool = True`).
 *
 * This one ships enabled because it is cheap relative to what it buys: a pass is
 * bounded by `rollupMaintenanceBudgetMs` and `rollupBuildsPerPass`, and the
 * result is the only index that can answer "what did we do on the 11th" without
 * scanning a log whose checkpoints have no time semantics of their own.
 */
const DEFAULT_TEMPORAL_ROLLUPS = true;
/** How many rollups one maintenance pass may build (lcm-x ships 2). */
const DEFAULT_ROLLUP_BUILDS_PER_PASS = 2;
/** Wall-clock budget for one rollup pass (lcm-x ships 5 000 ms). */
const DEFAULT_ROLLUP_BUDGET_MS = 5000;
/** Target size of one day rollup (lcm-x ships 5 000). */
const DEFAULT_ROLLUP_TARGET_TOKENS = 5000;
/** Hard bound on one day rollup (lcm-x ships 15 000). */
const DEFAULT_ROLLUP_MAX_TOKENS = 15000;
/**
 * Where rollup sidecars live. Outside the session log on purpose: a rollup
 * committed AS a session event would become a surface node and be compacted
 * again, which grows the thing it is meant to compress.
 */
const DEFAULT_ROLLUP_DIR = ".lcm-rollups";
/**
 * Extract typed assertions from checkpoints. Off by default, like lcm-x
 * (`assertion_extraction_enabled: bool = False`; its store switch
 * `assertions_enabled` is also `False`).
 *
 * A checkpoint is prose; an assertion is the same fact as a triple with the seq
 * it came from. It costs a model call per checkpoint and the store has to be kept
 * in step with the log, so nothing else depends on it: `lcm_search` and
 * `lcm_expand` work whether or not one assertion has ever been extracted.
 */
const DEFAULT_ASSERTION_EXTRACTION = false;
/** Checkpoints one extraction pass may read (lcm-x ships 4). */
const DEFAULT_ASSERTION_MAX_SOURCES_PER_PASS = 4;
/** Wall-clock budget for one extraction pass (lcm-x ships 30 s). */
const DEFAULT_ASSERTION_TIMEOUT_SECONDS = 30;
/** Where assertion sidecars live; outside the session log for the same reason as rollups. */
const DEFAULT_ASSERTION_DIR = ".lcm-assertions";

/** Fields shared by top-level defaults and exact-target overrides (== basic). */
const POLICY_KEYS = [
  "thresholdRatio",
  "headroomTokens",
  "retainRatio",
  "retainTokens",
  "summarizationProvider",
  "summarizationModel",
  "maxTokens",
  "compactionRetries",
  "maxOverflowRetries"
];

/**
 * LCM-only tuning keys. Top-level only; not valid inside modelPolicies.
 *
 * The seven `vector*` keys configure the optional semantic recall layer
 * (`./vectors.js`). They default to off, so resolving a configuration that
 * never mentions them changes no behavior.
 */
const LCM_KEYS = [
  "summaryRatio",
  "summaryFloorTokens",
  "checkpointCap",
  "leafSpanTokens",
  "condensationFanin",
  "thresholdFullSweep",
  "fullSweepMaxPasses",
  "fullSweepMaxSeconds",
  "fullSweepSoftSeconds",
  "fullSweepTargetShare",
  "fullSweepReserveSeconds",
  "leafEstimateFloorSeconds",
  "stallCooldownMs",
  "anchorPointers",
  "emptySummaryRetries",
  "backgroundLeafPrep",
  "temporalRollups",
  "rollupBuildsPerPass",
  "rollupMaintenanceBudgetMs",
  "rollupDailyTargetTokens",
  "rollupDailyMaxTokens",
  "rollupDir",
  "assertionExtraction",
  "assertionMaxSourcesPerPass",
  "assertionTimeoutSeconds",
  "assertionDir",
  "debug",
  "debugLogPath",
  "vectorEnabled",
  "vectorBaseUrl",
  "vectorModel",
  "vectorDim",
  "vectorTopK",
  "vectorTimeoutMs",
  "vectorCacheDir",
  "vectorApiKeyEnv"
];

/**
 * Complete public top-level key set.
 *
 * Exported because it is the single source of truth for the config surface: the
 * composition-time schemastery `Config` in ./index.js must declare exactly these
 * keys, or `Config.simplify` silently drops the ones it never learned about when a
 * patch re-route writes the configuration back (see test/config-surface.test.js).
 * A test asserting that agreement is what keeps the two lists from drifting apart.
 */
export const CONFIG_KEYS = new Set([...POLICY_KEYS, ...LCM_KEYS, "modelPolicies", "auto"]);

/** Complete exact-target override key set. */
const MODEL_POLICY_KEYS = new Set(["provider", "model", ...POLICY_KEYS]);

/** Target-specific pressure failure the caller may suppress as a warning. */
export class TargetPressureConfigError extends Error {
  /**
   * @param targetKey - exact `provider/model` route used as the warning key.
   * @param message - actionable configuration failure detail.
   */
  constructor(targetKey, message) {
    super(message);
    this.targetKey = targetKey;
  }
}

// ── resolution ─────────────────────────────────────────────────────────────

/**
 * Resolve and validate service defaults plus exact-target partial overrides.
 * @param config - untrusted plugin configuration after Loader normalization.
 * @returns detached immutable defaults and the validated override table.
 */
export function resolveConfig(config = {}) {
  validateKeys(config, CONFIG_KEYS, "LcmCompactionConfig");
  validatePolicy(config, "LcmCompactionConfig");
  if (config.auto !== undefined && typeof config.auto !== "boolean") {
    throw new Error("LcmCompactionConfig: auto must be a boolean");
  }

  const headroomTokens = config.headroomTokens ?? DEFAULT_HEADROOM_TOKENS;
  const maxTokens = config.maxTokens ?? headroomTokens;
  assertPositiveInteger("LcmCompactionConfig.maxTokens (explicit or from headroomTokens)", maxTokens);
  const thresholdRatio = config.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO;
  const retention = resolveRetention(config, { retainRatio: DEFAULT_RETAIN_RATIO });
  validateRatioRetention(thresholdRatio, retention, "LcmCompactionConfig");

  // basic's exact inheritance rule: a row inherits its own headroomTokens as
  // maxTokens only when the top-level maxTokens was left undefined.
  const modelPolicies = resolveModelPolicies(config.modelPolicies);
  for (const [index, policy] of modelPolicies.entries()) {
    if (policy.maxTokens === undefined && config.maxTokens === undefined && policy.headroomTokens !== undefined) {
      policy.maxTokens = policy.headroomTokens;
    }
    assertPositiveInteger(
      `LcmCompactionConfig: modelPolicies[${index}].maxTokens (explicit or from headroomTokens)`,
      policy.maxTokens ?? maxTokens
    );
    validateRatioRetention(
      policy.thresholdRatio ?? thresholdRatio,
      resolveRetention(policy, retention),
      `LcmCompactionConfig: modelPolicies[${index}]`
    );
  }

  const debug = config.debug === true ||
    (typeof process !== "undefined" && process.env?.DSH_COMPACTION_DEBUG === "1");
  const debugLogPath = config.debugLogPath ??
    (typeof process !== "undefined" && process.env?.DSH_HOME
      ? `${process.env.DSH_HOME}/compaction-debug.log`
      : "/tmp/dsh-compaction-debug.log");

  return deepFreeze({
    thresholdRatio,
    headroomTokens,
    ...retention,
    summarizationProvider: config.summarizationProvider ?? "",
    summarizationModel: config.summarizationModel ?? "",
    maxTokens,
    compactionRetries: config.compactionRetries ?? 1,
    maxOverflowRetries: config.maxOverflowRetries ?? 1,
    modelPolicies,
    auto: config.auto ?? true,
    // ── LCM-only ──
    summaryRatio: config.summaryRatio ?? DEFAULT_SUMMARY_RATIO,
    summaryFloorTokens: config.summaryFloorTokens ?? DEFAULT_SUMMARY_FLOOR_TOKENS,
    checkpointCap: config.checkpointCap ?? DEFAULT_CHECKPOINT_CAP,
    leafSpanTokens: config.leafSpanTokens ?? DEFAULT_LEAF_SPAN_TOKENS,
    condensationFanin: config.condensationFanin ?? DEFAULT_CONDENSATION_FANIN,
    thresholdFullSweep: config.thresholdFullSweep ?? DEFAULT_THRESHOLD_FULL_SWEEP,
    fullSweepMaxPasses: config.fullSweepMaxPasses ?? DEFAULT_FULL_SWEEP_MAX_PASSES,
    fullSweepMaxSeconds: config.fullSweepMaxSeconds ?? DEFAULT_FULL_SWEEP_MAX_SECONDS,
    fullSweepSoftSeconds: config.fullSweepSoftSeconds ?? DEFAULT_FULL_SWEEP_SOFT_SECONDS,
    fullSweepTargetShare: config.fullSweepTargetShare ?? DEFAULT_FULL_SWEEP_TARGET_SHARE,
    fullSweepReserveSeconds: config.fullSweepReserveSeconds ?? DEFAULT_FULL_SWEEP_RESERVE_SECONDS,
    leafEstimateFloorSeconds: config.leafEstimateFloorSeconds ?? DEFAULT_LEAF_ESTIMATE_FLOOR_SECONDS,
    stallCooldownMs: config.stallCooldownMs ?? DEFAULT_STALL_COOLDOWN_MS,
    anchorPointers: config.anchorPointers ?? DEFAULT_ANCHOR_POINTERS,
    emptySummaryRetries: config.emptySummaryRetries ?? DEFAULT_EMPTY_SUMMARY_RETRIES,
    backgroundLeafPrep: config.backgroundLeafPrep ?? DEFAULT_BACKGROUND_LEAF_PREP,
    temporalRollups: config.temporalRollups ?? DEFAULT_TEMPORAL_ROLLUPS,
    rollupBuildsPerPass: config.rollupBuildsPerPass ?? DEFAULT_ROLLUP_BUILDS_PER_PASS,
    rollupMaintenanceBudgetMs: config.rollupMaintenanceBudgetMs ?? DEFAULT_ROLLUP_BUDGET_MS,
    rollupDailyTargetTokens: config.rollupDailyTargetTokens ?? DEFAULT_ROLLUP_TARGET_TOKENS,
    rollupDailyMaxTokens: config.rollupDailyMaxTokens ?? DEFAULT_ROLLUP_MAX_TOKENS,
    rollupDir: config.rollupDir ?? DEFAULT_ROLLUP_DIR,
    assertionExtraction: config.assertionExtraction ?? DEFAULT_ASSERTION_EXTRACTION,
    assertionMaxSourcesPerPass: config.assertionMaxSourcesPerPass ?? DEFAULT_ASSERTION_MAX_SOURCES_PER_PASS,
    assertionTimeoutSeconds: config.assertionTimeoutSeconds ?? DEFAULT_ASSERTION_TIMEOUT_SECONDS,
    assertionDir: config.assertionDir ?? DEFAULT_ASSERTION_DIR,
    debug,
    debugLogPath,
    // ── optional vector recall (inert unless vectorEnabled) ──
    vectorEnabled: config.vectorEnabled ?? DEFAULT_VECTOR_ENABLED,
    vectorBaseUrl: config.vectorBaseUrl ?? DEFAULT_VECTOR_BASE_URL,
    vectorModel: config.vectorModel ?? DEFAULT_VECTOR_MODEL,
    vectorDim: config.vectorDim ?? DEFAULT_VECTOR_DIM,
    vectorTopK: config.vectorTopK ?? DEFAULT_VECTOR_TOPK,
    vectorTimeoutMs: config.vectorTimeoutMs ?? DEFAULT_VECTOR_TIMEOUT_MS,
    vectorCacheDir: config.vectorCacheDir ?? DEFAULT_VECTOR_CACHE_DIR,
    vectorApiKeyEnv: config.vectorApiKeyEnv ?? ""
  });
}

/**
 * Merge the exact provider/model override over the validated default policy.
 * @param config - resolved defaults and override table.
 * @param target - exact durable provider/model route to match.
 * @returns detached immutable policy before model-capacity scaling.
 */
export function resolveTargetPolicy(config, target) {
  const override = findOverride(config.modelPolicies, target);
  const inheritedRetention = config.retainTokens === undefined
    ? { retainRatio: config.retainRatio }
    : { retainTokens: config.retainTokens };
  return deepFreeze({
    target: { provider: target.provider, model: target.model },
    thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
    headroomTokens: override?.headroomTokens ?? config.headroomTokens,
    ...resolveRetention(override ?? {}, inheritedRetention),
    summarizationProvider: override?.summarizationProvider ?? config.summarizationProvider,
    summarizationModel: override?.summarizationModel ?? config.summarizationModel,
    maxTokens: override?.maxTokens ?? config.maxTokens,
    compactionRetries: override?.compactionRetries ?? config.compactionRetries,
    maxOverflowRetries: override?.maxOverflowRetries ?? config.maxOverflowRetries
  });
}

/**
 * Scale one routed policy into concrete token budgets for its model capacity.
 * @param policy - merged policy for the exact routed target.
 * @param contextWindow - positive adapter-owned capacity for that target.
 * @param reservedCompletionTokens - output tokens one routed request reserves.
 * @returns detached immutable pressure and retention budgets.
 */
export function resolveCompactSpec(policy, contextWindow, reservedCompletionTokens = 0) {
  const targetKey = `${policy.target.provider}/${policy.target.model}`;
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new TargetPressureConfigError(targetKey, `LcmCompactionConfig: contextWindow (${contextWindow}) must be a positive integer`);
  }
  if (!Number.isInteger(reservedCompletionTokens) || reservedCompletionTokens < 0) {
    throw new TargetPressureConfigError(targetKey, `LcmCompactionConfig: reservedCompletionTokens (${reservedCompletionTokens}) must be a non-negative integer`);
  }
  const messageBudgetTokens = contextWindow - reservedCompletionTokens;
  if (messageBudgetTokens <= 0) {
    throw new TargetPressureConfigError(
      targetKey,
      `compaction-lcm: ${targetKey} reserves ${reservedCompletionTokens} completion tokens of its ${contextWindow}-token context window, leaving no message budget; raise the adapter model's contextWindow above the effective request maxTokens`
    );
  }
  const pressureBudgetTokens = messageBudgetTokens - policy.headroomTokens;
  if (pressureBudgetTokens <= 0) {
    throw new TargetPressureConfigError(
      targetKey,
      `compaction-lcm: ${targetKey} reserves ${reservedCompletionTokens} completion tokens and ${policy.headroomTokens} headroom tokens of its ${contextWindow}-token context window, leaving no pressure budget; lower maxTokens or headroomTokens, or raise the adapter contextWindow`
    );
  }
  const thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens));
  const retainTokens = policy.retainTokens === undefined
    ? Math.floor(messageBudgetTokens * policy.retainRatio)
    : policy.retainTokens;
  if (retainTokens >= thresholdTokens) {
    throw new TargetPressureConfigError(
      targetKey,
      `LcmCompactionConfig: ${targetKey} retainTokens (${retainTokens}) must be less than threshold tokens ${thresholdTokens}`
    );
  }
  return deepFreeze({
    target: { ...policy.target },
    contextWindow,
    thresholdRatio: policy.thresholdRatio,
    thresholdTokens,
    retainTokens,
    summarizationProvider: policy.summarizationProvider,
    summarizationModel: policy.summarizationModel,
    maxTokens: policy.maxTokens,
    compactionRetries: policy.compactionRetries,
    maxOverflowRetries: policy.maxOverflowRetries
  });
}

/**
 * Resolve the summary TARGET length for one leaf summary.
 *
 * Two terms, and both are meaningful to a `compaction-basic` user:
 *
 *   scaled   = shadowed × summaryRatio, clamped to [summaryFloorTokens, checkpointCap]
 *   target   = min(scaled, maxTokens)
 *
 * The scaled term keeps the compression ratio stable across context-window
 * sizes. The `maxTokens` term keeps basic's key surface working: a config that
 * set `maxTokens: 4096` still gets 4096 as the number the model is asked to aim
 * for, instead of silently inheriting the larger `checkpointCap`.
 *
 * It is the target, not the ceiling. The request ceiling is `max(4096, 2 x this)`:
 * a reasoning-first backend spends part of any ceiling on hidden reasoning, so a
 * ceiling equal to the target left the summary half-written, and no ceiling at all
 * was worse — the provider's default is smaller and silent.
 *
 * @param config - resolved configuration.
 * @param shadowedTokenCount - tokens in the span being replaced.
 * @returns the summary target length.
 */
export function resolveSummaryBudget(config, shadowedTokenCount) {
  const scaled = Math.floor(shadowedTokenCount * config.summaryRatio);
  const clamped = Math.min(config.checkpointCap, Math.max(config.summaryFloorTokens, scaled));
  return Math.max(1, Math.min(clamped, config.maxTokens));
}

// ── exact-target overrides ─────────────────────────────────────────────────

/** Find the override row for one exact route, if any. */
function findOverride(policies, target) {
  return policies.find((policy) => policy.provider === target.provider && policy.model === target.model);
}

/**
 * Validate, detach, and reject duplicate exact-target policies.
 * @param configured - untrusted `modelPolicies` value.
 * @param defaults - resolved top-level policy, used to validate each merged row.
 * @returns detached policy list.
 */
function resolveModelPolicies(configured) {
  if (configured === undefined) return [];
  if (!Array.isArray(configured)) throw new Error("LcmCompactionConfig: modelPolicies must be an array");
  const seen = new Set();
  return configured.map((source, index) => {
    assertModelPolicy(source, `LcmCompactionConfig: modelPolicies[${index}]`);
    const key = `${source.provider}\u0000${source.model}`;
    if (seen.has(key)) throw new Error(`LcmCompactionConfig: duplicate model policy for ${source.provider}/${source.model}`);
    seen.add(key);
    return { ...source };
  });
}

/** Validate one untrusted exact-target override and narrow its public type. */
function assertModelPolicy(source, name) {
  if (!isUnknownRecord(source)) throw new Error(`${name} must be an object`);
  validateKeys(source, MODEL_POLICY_KEYS, name);
  assertNonEmptyString(`${name}.provider`, source.provider);
  assertNonEmptyString(`${name}.model`, source.model);
  validatePolicy(source, name);
}

// ── validation ─────────────────────────────────────────────────────────────

/** Validate the fields common to defaults and exact-target partial overrides. */
function validatePolicy(config, name) {
  const { thresholdRatio, headroomTokens, retainRatio, retainTokens, maxTokens, compactionRetries, maxOverflowRetries } = config;
  if (thresholdRatio !== undefined) assertRatio(`${name}.thresholdRatio`, thresholdRatio);
  if (headroomTokens !== undefined) assertNonNegativeInteger(`${name}.headroomTokens`, headroomTokens);
  if (retainRatio !== undefined) assertRatio(`${name}.retainRatio`, retainRatio);
  if (retainTokens !== undefined) assertNonNegativeInteger(`${name}.retainTokens`, retainTokens);
  if (retainRatio !== undefined && retainTokens !== undefined) {
    throw new Error(`${name}: retainRatio and retainTokens are mutually exclusive`);
  }
  if (maxTokens !== undefined) assertPositiveInteger(`${name}.maxTokens`, maxTokens);
  if (compactionRetries !== undefined) assertNonNegativeInteger(`${name}.compactionRetries`, compactionRetries);
  if (maxOverflowRetries !== undefined) assertNonNegativeInteger(`${name}.maxOverflowRetries`, maxOverflowRetries);
  validateSummarizationPair(config, name);
  if (config.checkpointCap !== undefined) assertPositiveInteger(`${name}.checkpointCap`, config.checkpointCap);
  if (config.summaryFloorTokens !== undefined) assertPositiveInteger(`${name}.summaryFloorTokens`, config.summaryFloorTokens);
  if (config.leafSpanTokens !== undefined) assertPositiveInteger(`${name}.leafSpanTokens`, config.leafSpanTokens);
  if (config.condensationFanin !== undefined) assertCondensationFanin(`${name}.condensationFanin`, config.condensationFanin);
  if (config.thresholdFullSweep !== undefined && typeof config.thresholdFullSweep !== "boolean") throw new Error(`${name}.thresholdFullSweep must be a boolean`);
  if (config.fullSweepMaxPasses !== undefined) assertPositiveInteger(`${name}.fullSweepMaxPasses`, config.fullSweepMaxPasses);
  if (config.fullSweepMaxSeconds !== undefined) assertPositiveInteger(`${name}.fullSweepMaxSeconds`, config.fullSweepMaxSeconds);
  if (config.fullSweepSoftSeconds !== undefined) assertPositiveInteger(`${name}.fullSweepSoftSeconds`, config.fullSweepSoftSeconds);
  if (config.fullSweepTargetShare !== undefined) assertRatio(`${name}.fullSweepTargetShare`, config.fullSweepTargetShare);
  if (config.fullSweepReserveSeconds !== undefined) assertNonNegativeInteger(`${name}.fullSweepReserveSeconds`, config.fullSweepReserveSeconds);
  if (config.leafEstimateFloorSeconds !== undefined) assertPositiveInteger(`${name}.leafEstimateFloorSeconds`, config.leafEstimateFloorSeconds);
  // The stall hold's deadline was the ONE key of the 28 declared in the schema
  // and never checked here, so `"60000"` or `1.5` reached the engine and
  // `Date.now() + stallCooldownMs` produced `NaN`. Every `Date.now() < NaN`
  // comparison is false, so the hold never armed - the stall protection was
  // silently disabled by a value the composition schema already refuses
  // (`min(1).step(1)`). Same rule as its peers: a positive integer.
  if (config.stallCooldownMs !== undefined) assertPositiveInteger(`${name}.stallCooldownMs`, config.stallCooldownMs);
  if (config.summaryRatio !== undefined) assertRatio(`${name}.summaryRatio`, config.summaryRatio);
  if (config.anchorPointers !== undefined && typeof config.anchorPointers !== "boolean") throw new Error(`${name}.anchorPointers must be a boolean`);
  if (config.emptySummaryRetries !== undefined) assertNonNegativeInteger(`${name}.emptySummaryRetries`, config.emptySummaryRetries);
  if (config.backgroundLeafPrep !== undefined && typeof config.backgroundLeafPrep !== "boolean") throw new Error(`${name}.backgroundLeafPrep must be a boolean`);
  if (config.temporalRollups !== undefined && typeof config.temporalRollups !== "boolean") throw new Error(`${name}.temporalRollups must be a boolean`);
  if (config.rollupBuildsPerPass !== undefined) assertPositiveInteger(`${name}.rollupBuildsPerPass`, config.rollupBuildsPerPass);
  if (config.rollupMaintenanceBudgetMs !== undefined) assertPositiveInteger(`${name}.rollupMaintenanceBudgetMs`, config.rollupMaintenanceBudgetMs);
  if (config.rollupDailyTargetTokens !== undefined) assertPositiveInteger(`${name}.rollupDailyTargetTokens`, config.rollupDailyTargetTokens);
  if (config.rollupDailyMaxTokens !== undefined) assertPositiveInteger(`${name}.rollupDailyMaxTokens`, config.rollupDailyMaxTokens);
  if (config.rollupDir !== undefined) assertNonEmptyString(`${name}.rollupDir`, config.rollupDir);
  if (config.assertionExtraction !== undefined && typeof config.assertionExtraction !== "boolean") throw new Error(`${name}.assertionExtraction must be a boolean`);
  if (config.assertionMaxSourcesPerPass !== undefined) assertPositiveInteger(`${name}.assertionMaxSourcesPerPass`, config.assertionMaxSourcesPerPass);
  if (config.assertionTimeoutSeconds !== undefined) assertPositiveInteger(`${name}.assertionTimeoutSeconds`, config.assertionTimeoutSeconds);
  if (config.assertionDir !== undefined) assertNonEmptyString(`${name}.assertionDir`, config.assertionDir);
  if (config.debug !== undefined && typeof config.debug !== "boolean") throw new Error(`${name}.debug must be a boolean`);
  if (config.debugLogPath !== undefined && typeof config.debugLogPath !== "string") throw new Error(`${name}.debugLogPath must be a string`);
  if (config.vectorEnabled !== undefined && typeof config.vectorEnabled !== "boolean") throw new Error(`${name}.vectorEnabled must be a boolean`);
  if (config.vectorBaseUrl !== undefined) assertNonEmptyString(`${name}.vectorBaseUrl`, config.vectorBaseUrl);
  if (config.vectorModel !== undefined) assertNonEmptyString(`${name}.vectorModel`, config.vectorModel);
  if (config.vectorDim !== undefined) assertPositiveInteger(`${name}.vectorDim`, config.vectorDim);
  if (config.vectorTopK !== undefined) assertPositiveInteger(`${name}.vectorTopK`, config.vectorTopK);
  if (config.vectorTimeoutMs !== undefined) assertPositiveInteger(`${name}.vectorTimeoutMs`, config.vectorTimeoutMs);
  if (config.vectorCacheDir !== undefined) assertNonEmptyString(`${name}.vectorCacheDir`, config.vectorCacheDir);
  // Deliberately allows the empty string: "" is the documented "send no
  // Authorization header" value, and it is the default for keyless backends.
  if (config.vectorApiKeyEnv !== undefined && typeof config.vectorApiKeyEnv !== "string") throw new Error(`${name}.vectorApiKeyEnv must be a string`);
}

/** Require one scope to omit, clear, or replace the summarization target as a pair. */
function validateSummarizationPair(config, name) {
  const provider = config.summarizationProvider;
  const model = config.summarizationModel;
  if (provider !== undefined && typeof provider !== "string") throw new Error(`${name}.summarizationProvider must be a string`);
  if (model !== undefined && typeof model !== "string") throw new Error(`${name}.summarizationModel must be a string`);
  if (provider === undefined && model === undefined) return;
  if (provider === undefined || model === undefined || (provider.length === 0) !== (model.length === 0)) {
    throw new Error(`${name}: summarizationProvider and summarizationModel must be set together as an empty or non-empty pair`);
  }
}

/** Choose the explicit retention form, or inherit the already-resolved fallback. */
function resolveRetention(config, fallback) {
  if (config.retainTokens !== undefined) return { retainTokens: config.retainTokens };
  if (config.retainRatio !== undefined) return { retainRatio: config.retainRatio };
  return { ...fallback };
}

/** Reject a retention fraction that would swallow the pressure threshold. */
function validateRatioRetention(thresholdRatio, retention, name) {
  if (retention.retainRatio !== undefined && retention.retainRatio >= thresholdRatio) {
    throw new Error(`${name}: retainRatio (${retention.retainRatio}) must be less than the resolved thresholdRatio (${thresholdRatio})`);
  }
}

/** Reject stale or misspelled keys before defaults can hide them. */
function validateKeys(config, keys, name) {
  for (const key of Object.keys(config)) if (!keys.has(key)) throw new Error(`${name}: unknown key "${key}"`);
}

function isUnknownRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
}

function assertPositiveInteger(name, value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} (${String(value)}) must be a positive integer`);
  }
}

/**
 * Require a condensation fanin of at least 2.
 *
 * Not an ordinary "positive integer" check, because the floor is semantic: ./region.js
 * gates its whole condensation branch - and the skip over the checkpoints already on
 * the surface - on `fanin > 1`. A fanin of 1 does not make condensation rarer, it
 * turns it off, and with it every leaf starts at the previous checkpoint again: the
 * surface holds one checkpoint forever and its depth grows by one per compaction
 * (measured: 1 checkpoint, depth 1,2,3 over a three-round replay). The message names
 * that consequence so the value is not read as "just a small fanin".
 * @param name - config path for the offending key.
 * @param value - candidate fanin.
 */
function assertCondensationFanin(name, value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 2) {
    throw new Error(`${name} (${String(value)}) must be an integer >= 2: below 2 the condensation branch and its skip over existing checkpoints are both off, so every compaction re-summarises its own last summary and the surface holds one checkpoint at a growing depth`);
  }
}

function assertNonNegativeInteger(name, value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} (${String(value)}) must be a non-negative integer`);
  }
}

function assertRatio(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} (${String(value)}) must be a number in (0, 1]`);
  }
}
