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
import { appendFileSync } from "node:fs";
import { CompactionEngine, ManualCompactionError } from "@deepseek-ai/dsh-compaction";
import { CONTEXT_WINDOW_EXCEEDED_CODE } from "@deepseek-ai/dsh-llm";
import { assertNever } from "@deepseek-ai/dsh-util-values";
import { COMPILER_REV, estimateEntryTokens, isCheckpointSource } from "./compiler.js";
import {
  TargetPressureConfigError,
  resolveCompactSpec,
  resolveConfig,
  resolveSummaryBudget,
  resolveTargetPolicy
} from "./config.js";
import { assertNoActiveCompaction, compactSurfaceRegion, selectCompactableRange } from "./region.js";
import { summarizeLeaf } from "./summarize.js";

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
/**
 * Emit one engine-side debug line through the resolved sink when debug is on.
 * @param config - resolved configuration.
 * @param line - the diagnostic text.
 */
function engineDebug(config, line) {
  if (config.debug !== true) return;
  const text = `[dsh-lcm] engine: ${line}`;
  try {
    console.error(text);
  } catch {
    /* stderr may be unavailable in embedded contexts */
  }
  try {
    appendFileSync(config.debugLogPath, `${text}\n`, "utf8");
  } catch {
    /* a failing debug log must never break the engine */
  }
}

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
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
    debug: z.boolean(),
    debugLogPath: z.string()
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
   * Register automatic between-step pressure and model-request overflow
   * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
   * overrides are honored at event time.
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
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`);
      }
      return next();
    }));
    disposers.push(ctx.on("agent/status", ({ agent, status }) => {
      if (status === "idle") this.overflowRetries.delete(agent);
    }));
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
   * Resolve the token budget for one LLM leaf summary.
   * @param shadowedTokenCount - tokens in the span being replaced.
   * @returns the summary token ceiling (`summaryRatio` of the span, clamped).
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
    const result = await summarizeLeaf(this.ctx, this.config, prepared, agent, budget, signal);
    signal?.throwIfAborted();

    const text = result.summary.map((block) => block.text ?? "").join("\n");
    const tokens = estimateEntryTokens(text);
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
      maxTokens: budget,
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
    if (target === undefined) return null;
    const policy = resolveTargetPolicy(this.config, target);
    const meter = this.ctx.tokenMeter;
    let measurement = meter.measure(agent.session);
    switch (trigger) {
      case "context-overflow": break;
      case "pressure": break;
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default: assertNever(trigger, "compaction trigger");
    }
    const prune = this.ctx.get("toolResultPruner");
    if (trigger === "context-overflow") {
      if (prune !== undefined) {
        prune.pruneSession(agent.session);
        measurement = meter.measure(agent.session);
      }
      const range = selectCompactableRange(agent.session, measurement, 0);
      if (range === null) return null;
      return this.compactRegion(range.start, range.end, agent, signal);
    }
    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
    const context = info.context;
    assertNoActiveCompaction(agent.session, "automatic pressure compaction");
    const targetKey = `${target.provider}/${target.model}`;
    if (context === undefined) throw new TargetPressureConfigError(targetKey, `compaction-lcm: no context capacity for ${targetKey}; configure contextWindow on that adapter model`);
    // basic's exact reservation: the routed request's own output budget must not
    // be counted as available message space.
    const spec = resolveCompactSpec(
      policy,
      context.contextWindow,
      reservedCompletionTokens(agent.session.requestHeader(), info.defaultMaxTokens)
    );
    if (measurement.totalTokens < spec.thresholdTokens) return null;
    if (prune !== undefined) {
      prune.pruneSession(agent.session);
      measurement = meter.measure(agent.session);
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null;
    let result = null;
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      const range = selectCompactableRange(agent.session, measurement, spec.retainTokens);
      if (range === null) {
        /* v8 ignore else -- concrete replacement preserves a compactable checkpoint; subclass hooks cannot mutate it. */
        if (result === null) return null;
        /* v8 ignore next -- paired with the defensive post-success branch above. */
        break;
      }
      result = await this.compactRegion(range.start, range.end, agent, signal);
      measurement = meter.measure(agent.session);
      if (measurement.totalTokens < spec.thresholdTokens) return result;
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
  /** Bind the effective token meter and dynamically dispatched compile hook. */
  regionDependencies() {
    return {
      meter: this.ctx.tokenMeter,
      compile: (prepared, owner, abort) => this.compile(prepared, owner, abort)
    };
  }
}

export default LcmCompactionEngine;
