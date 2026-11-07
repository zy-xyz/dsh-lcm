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
 * The LCM delta appears only in the summary budget, which basic derives from
 * `headroomTokens` alone:
 *
 *   summaryTokens = clamp(shadowed × summaryRatio, summaryFloorTokens, checkpointCap)
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

/** Request-pressure fraction, matching basic's 0.8. */
const DEFAULT_THRESHOLD_RATIO = 0.8;
/** Capacity reserved for the next completion, matching basic's 65536. */
const DEFAULT_HEADROOM_TOKENS = 65536;
/** Verbatim-tail fraction of the message budget, matching basic's 0.16. */
const DEFAULT_RETAIN_RATIO = 0.16;
/** Summary budget as a fraction of the shadowed span (LCM-only). */
const DEFAULT_SUMMARY_RATIO = 0.12;
/** Lower bound for one summary, so a small span still yields a usable note. */
const DEFAULT_SUMMARY_FLOOR_TOKENS = 512;
/** Absolute ceiling for one summary. */
const DEFAULT_CHECKPOINT_CAP = 16384;
/**
 * Whether a leaf summary anchor list gets `(seq N)` pointers.
 *
 * On by default: attribution is pure local computation over events already in
 * memory — no request, no extra token — and it is what turns the anchor list
 * from a lost citation into an index `lcm_expand` can follow directly.
 */
const DEFAULT_ANCHOR_POINTERS = true;

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
  "anchorPointers",
  "debug",
  "debugLogPath",
  "vectorEnabled",
  "vectorBaseUrl",
  "vectorModel",
  "vectorDim",
  "vectorTopK",
  "vectorTimeoutMs",
  "vectorCacheDir"
];

/** Complete public top-level key set. */
const CONFIG_KEYS = new Set([...POLICY_KEYS, ...LCM_KEYS, "modelPolicies", "auto"]);

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
    anchorPointers: config.anchorPointers ?? DEFAULT_ANCHOR_POINTERS,
    debug,
    debugLogPath,
    // ── optional vector recall (inert unless vectorEnabled) ──
    vectorEnabled: config.vectorEnabled ?? DEFAULT_VECTOR_ENABLED,
    vectorBaseUrl: config.vectorBaseUrl ?? DEFAULT_VECTOR_BASE_URL,
    vectorModel: config.vectorModel ?? DEFAULT_VECTOR_MODEL,
    vectorDim: config.vectorDim ?? DEFAULT_VECTOR_DIM,
    vectorTopK: config.vectorTopK ?? DEFAULT_VECTOR_TOPK,
    vectorTimeoutMs: config.vectorTimeoutMs ?? DEFAULT_VECTOR_TIMEOUT_MS,
    vectorCacheDir: config.vectorCacheDir ?? DEFAULT_VECTOR_CACHE_DIR
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
 * Resolve the summary token budget for one leaf summary.
 *
 * Two ceilings apply, and both are meaningful to a `compaction-basic` user:
 *
 *   scaled   = shadowed × summaryRatio, clamped to [summaryFloorTokens, checkpointCap]
 *   budget   = min(scaled, maxTokens)
 *
 * The scaled term keeps the compression ratio stable across context-window
 * sizes. The `maxTokens` term preserves basic's contract that `maxTokens` is the
 * summary request's output cap — so an existing config that set
 * `maxTokens: 4096` to bound summarizer spend keeps that bound instead of
 * silently inheriting the larger `checkpointCap`.
 *
 * @param config - resolved configuration.
 * @param shadowedTokenCount - tokens in the span being replaced.
 * @returns the summary token ceiling.
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
  if (config.summaryRatio !== undefined) assertRatio(`${name}.summaryRatio`, config.summaryRatio);
  if (config.anchorPointers !== undefined && typeof config.anchorPointers !== "boolean") throw new Error(`${name}.anchorPointers must be a boolean`);
  if (config.debug !== undefined && typeof config.debug !== "boolean") throw new Error(`${name}.debug must be a boolean`);
  if (config.debugLogPath !== undefined && typeof config.debugLogPath !== "string") throw new Error(`${name}.debugLogPath must be a string`);
  if (config.vectorEnabled !== undefined && typeof config.vectorEnabled !== "boolean") throw new Error(`${name}.vectorEnabled must be a boolean`);
  if (config.vectorBaseUrl !== undefined) assertNonEmptyString(`${name}.vectorBaseUrl`, config.vectorBaseUrl);
  if (config.vectorModel !== undefined) assertNonEmptyString(`${name}.vectorModel`, config.vectorModel);
  if (config.vectorDim !== undefined) assertPositiveInteger(`${name}.vectorDim`, config.vectorDim);
  if (config.vectorTopK !== undefined) assertPositiveInteger(`${name}.vectorTopK`, config.vectorTopK);
  if (config.vectorTimeoutMs !== undefined) assertPositiveInteger(`${name}.vectorTimeoutMs`, config.vectorTimeoutMs);
  if (config.vectorCacheDir !== undefined) assertNonEmptyString(`${name}.vectorCacheDir`, config.vectorCacheDir);
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
