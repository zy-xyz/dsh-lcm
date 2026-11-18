/**
 * Model-facing same-session recall tools for `dsh-lcm`.
 *
 * Two complementary entry points over the durable session log:
 *
 *   - `recall` — restore the exact original content of earlier events by a
 *     typed reference: `type: "seq"` for `(seq N)` / `(seqs A-B)` markers,
 *     `type: "result"` for the `result N` pointer on a tool-call one-liner,
 *     `type: "checkpoint"` for a `[checkpoint N]` elision line.
 *   - `search` — keyword/regex search over the log. Returns the matching
 *     events with their `(seq N)` pointers, so the agent can then call
 *     `recall` to restore any hit in full.
 *
 * Neither call does a model round-trip and neither paraphrases: the log is
 * append-only, so the output is always the original content.
 *
 * Registered as the `recall` and `search` tools on any context providing
 * `tools`.
 * @module dsh-lcm/tool
 */
import fs from "node:fs";
import os from "node:os";
import z from "@deepseek-ai/schemastery";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { DEFAULT_MAX_RECALL_TOKENS, MAX_RECALL_TOKENS, recallSession, resolveRecallBudget, resolveRecallReference } from "./recall.js";
import { DEFAULT_MAX_SEARCH_HITS, HYBRID_RANK_MODES, InvalidSearchPatternError, RANK_MODES, searchSessionHybrid } from "./search.js";
import { resolveVectorConfig } from "./vectors.js";
import { hotKeysFor, overlayFor, registerLiveConsumer } from "./live.js";
import { embedBackfill } from "./command.js";
import { insightRoutes, readLog, sessionFiles, warmReports } from "./insight.js";
import { deriveEventMessage } from "./events.js";
import { readRollups } from "./rollup.js";

const name = "tool-lcm-expand";
// `webServer` carries the insight endpoints. Declaring it here rather than adding a
// second bundle keeps the read-only panel in the package it reads: one install, one
// row, and the panel cannot drift from the engine it reports on.
const inject = ["tools", "webServer"];
/**
 * Texts one incremental embedding pass may embed. Two batches of 32.
 *
 * lcm-x schedules "one batch per corpus" in its background pass; the bound exists
 * so an idle moment cannot turn into a full backfill competing with live requests.
 * `/lcm-embed backfill --apply` remains the way to drain a corpus deliberately.
 */
const DEFAULT_EMBED_MAINTENANCE_LIMIT = 64;

/** Validate and default the tool plugin configuration. */
function resolveConfig(config = {}) {
  const maxRecallTokens = config.maxRecallTokens ?? DEFAULT_MAX_RECALL_TOKENS;
  const maxSearchHits = config.maxSearchHits ?? DEFAULT_MAX_SEARCH_HITS;
  const legacyNames = config.legacyNames ?? true;
  const rank = config.rank ?? "density";
  if (typeof maxRecallTokens !== "number" || !Number.isInteger(maxRecallTokens) || maxRecallTokens <= 0) throw new Error("ToolRecallConfig: maxRecallTokens must be a positive integer");
  if (typeof maxSearchHits !== "number" || !Number.isInteger(maxSearchHits) || maxSearchHits <= 0) throw new Error("ToolRecallConfig: maxSearchHits must be a positive integer");
  if (typeof legacyNames !== "boolean") throw new Error("ToolRecallConfig: legacyNames must be a boolean");
  const allowLanAccess = config.allowLanAccess ?? false;
  if (typeof allowLanAccess !== "boolean") throw new Error("ToolRecallConfig: allowLanAccess must be a boolean");
  const rollupDir = config.rollupDir ?? ".lcm-rollups";
  if (typeof rollupDir !== "string" || rollupDir.length === 0) throw new Error("ToolRecallConfig: rollupDir must be a non-empty string");
  const embedMaintenanceLimit = config.embedMaintenanceLimit ?? DEFAULT_EMBED_MAINTENANCE_LIMIT;
  if (typeof embedMaintenanceLimit !== "number" || !Number.isInteger(embedMaintenanceLimit) || embedMaintenanceLimit <= 0) throw new Error("ToolRecallConfig: embedMaintenanceLimit must be a positive integer");
  if (typeof rank !== "string" || !RANK_MODES.includes(rank) && !HYBRID_RANK_MODES.includes(rank)) {
    throw new Error("ToolRecallConfig: rank must be one of " + [...RANK_MODES, ...HYBRID_RANK_MODES].join(", ") + " (vector/hybrid need vectorEnabled)");
  }
  // The vector keys ride along so the search handler can read them; they are
  // inert unless `vectorEnabled` is true and `rank` names a vector mode.
  return { maxRecallTokens, maxSearchHits, legacyNames, rank, embedMaintenanceLimit, rollupDir, allowLanAccess, ...resolveVectorConfig(config) };
}

/**
 * Composition-time schema for this row.
 *
 * WHY IT EXISTS: the Loader validates a row's `config` through
 * `Config["~standard"].validate` BEFORE it restarts the plugin (cordis'
 * `resolveConfig`, called from `fiber.update`). Without a schema that check is
 * skipped entirely, so a bad value was only caught by {@link resolveConfig}
 * inside `apply` — which runs AFTER the old instance has been disposed and
 * after `ctx.tools.register` has already installed the tools. Measured on
 * `maxSearchHits: -3`: the registrations were undone, the fiber landed in
 * `state=3` (failed) and the live tool list was empty. With the schema the same
 * value throws before the restart, so the old instance keeps serving.
 *
 * Types and bounds mirror {@link resolveConfig} and `./vectors.js`
 * `resolveVectorConfig` exactly — same type, same `integer >= 1` floor, same
 * `rank` set — because two layers that disagree is the bug being removed: a
 * value one accepts and the other rejects still reaches the failed-row path.
 * test/compat.test.js asserts the agreement per key by iterating this schema.
 *
 * NO `.default()` ANYWHERE, on purpose: schemastery's `simplify` omits a value
 * equal to the declared default, and `simplify`'s output is what a
 * `fiber.update` re-route writes back — so a default would turn "explicitly
 * configured to the default value" into silence — the trap the engine row's own
 * `Config` documents in `src/index.js` ("simplify is a whitelist").
 * {@link resolveConfig} stays the single source of resolved defaults; every key
 * here is optional.
 */
const Config = z.object({
  rank: z.union([...RANK_MODES, ...HYBRID_RANK_MODES]),
  maxSearchHits: z.number().step(1).min(1),
  maxRecallTokens: z.number().step(1).min(1),
  legacyNames: z.boolean(),
  embedMaintenanceLimit: z.number().step(1).min(1),
  // Where the engine writes its day rollups. The tool row reads the same sidecar the
  // engine row writes, so the default matches ./config.js.
  rollupDir: z.string().min(1),
  // Serve the insight endpoints beyond loopback. Off by default: they expose
  // session history and file paths.
  allowLanAccess: z.boolean(),
  // The vector block rides along for the search handler; inert unless
  // `vectorEnabled` is true and `rank` names a vector mode (same as
  // resolveConfig, which spreads these through resolveVectorConfig).
  vectorEnabled: z.boolean(),
  vectorBaseUrl: z.string().min(1),
  vectorModel: z.string().min(1),
  vectorDim: z.number().step(1).min(1),
  vectorTopK: z.number().step(1).min(1),
  vectorCandidateTokens: z.number().step(1).min(1),
  vectorCandidateLimit: z.number().step(1).min(1),
  vectorTimeoutMs: z.number().step(1).min(1),
  // Requests in flight during a backfill. Measured 13x on this endpoint (four
  // 1-text requests: 107.6 s serial, 8.3 s concurrent), bounded so a pass cannot
  // starve the search route on the same gateway.
  vectorConcurrency: z.number().step(1).min(1),
  vectorCacheDir: z.string().min(1),
  // A variable NAME, so the empty string is legal here (it means "send no
  // Authorization header", the keyless-backend default). Same rule as
  // src/config.js: only a non-string is refused.
  vectorApiKeyEnv: z.string()
});

const RECALL_DESCRIPTION = "Restore the exact original content of earlier events in THIS conversation by a typed reference. type=\"seq\" with a seq selection id (\"3-7,15\", \"seq 12\", \"seqs 3-7\" — the checkpoint marker forms) restores those events; type=\"result\" with the \"result N\" pointer from a tool-call one-liner (\"result 3\" or \"3\") restores that tool result; type=\"checkpoint\" with an ordinal (\"1\" = oldest, as in a \"[checkpoint N]\" elision line) or a \"seq N\" pointer restores that full checkpoint. The durable log is append-only, so recalled content is always the original tokens. To find events by keyword or regex instead, use the search tool. One call is bounded by a token budget, and the budget is yours to set: when an event was cut, the text ends with a marker saying how much came back of how much, and passing a larger maxTokens returns the rest of it. There is no paging cursor — the log is indexed by seq, so a bigger budget on the same reference is the page.";

const SEARCH_DESCRIPTION = "Search THIS conversation's durable event log by keyword or regular expression (case-insensitive, Unicode-aware). Every event ever recorded is searchable, including content elided or truncated by compaction checkpoints — the log is append-only and untouched. Returns the matching events with their (seq N) seq numbers and the matching lines. Then call recall with a (seq N) pointer to restore any hit's full exact original content. Matching is line by line and literal: a pasted natural-language question almost never hits, and \"domain controller\" only matches those two words adjacent — search one distinctive word instead, or join alternatives with | (\"timeout|ETIMEDOUT\"). Escape regex special characters (e.g. use \\\\( for a literal parenthesis).";

const RECALL_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string", required: true },
      recalled: { type: "integer", required: true },
      missing: { type: "integer", required: true },
      skipped: { type: "integer", required: true },
      truncated: { type: "boolean", required: true },
      tokens: { type: "integer", required: true }
    }
  },
  render: (_args, value) => [{ type: "text", text: value.text }]
};

const SEARCH_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string", required: true },
      pattern: { type: "string", required: true },
      totalMatches: { type: "integer", required: true },
      omitted: { type: "integer", required: true },
      truncated: { type: "boolean", required: true },
      tokens: { type: "integer", required: true }
    }
  },
  render: (_args, value) => [{ type: "text", text: value.text }]
};

/** Shared execution of one typed recall request against the calling agent. */
function executeRecall(exec, type, id, resolved, maxTokens) {
  const agent = exec.agent;
  if (agent === undefined) throw new HarnessError("recall requires a calling agent with a session", "RECALL_AGENT_REQUIRED");
  const { selections, errors } = resolveRecallReference(agent.session, type, id);
  if (errors.length > 0) throw new HarnessError(`invalid ${type} recall: ${errors.join("; ")}`, "RECALL_INVALID_SELECTION");
  let budget;
  try {
    budget = resolveRecallBudget(maxTokens, resolved.maxRecallTokens);
  } catch (error) {
    throw new HarnessError(error.message, "RECALL_INVALID_BUDGET", { cause: error });
  }
  const recalled = recallSession(agent.session, selections, { maxRecallTokens: budget });
  return {
    text: recalled.text,
    recalled: recalled.recalled,
    missing: recalled.missing,
    skipped: recalled.skipped,
    truncated: recalled.truncated,
    tokens: recalled.tokens
  };
}

/**
 * Build the typed `recall` tool definition against one resolved config.
 * @param resolved - validated `{ maxRecallTokens, maxSearchHits }`.
 * @returns a registry-ready ToolDefinition.
 */
function defineRecallTool(resolved, toolName = "lcm_expand") {
  return defineTool({
    name: toolName,
    description: RECALL_DESCRIPTION,
    parameters: {
      type: {
        type: "string",
        required: true,
        enum: ["seq", "result", "checkpoint"],
        description: 'Reference type: "seq" for events by sequence number, "result" for a tool result by its `result N` pointer, "checkpoint" for a whole checkpoint by ordinal or seq.'
      },
      id: {
        type: "string",
        required: true,
        description: 'Type-dependent reference: "3-7,15" / "seq 12" for seq; "result 3" or "3" for result; "1" / "checkpoint 1" or "seq 12345" for checkpoint.'
      },
      maxTokens: {
        type: "integer",
        description: `Optional total budget for this call, in tokens; raise it when a result ended with a truncation marker, or lower it to spend less on a huge event. Omitted means the configured default of ${resolved.maxRecallTokens}. Capped at ${MAX_RECALL_TOKENS} — above that the budget is clamped, not refused.`
      }
    },
    output: RECALL_OUTPUT,
    execute: (args, exec) => executeRecall(exec, args.type, args.id, resolved, args.maxTokens),
    presentCall: (args) => ({
      card: "generic",
      title: "Recall events",
      kind: "read",
      rawInput: args.maxTokens === undefined ? `${args.type} ${args.id}` : `${args.type} ${args.id} (maxTokens ${args.maxTokens})`
    })
  });
}

/** Description for the `lcm_timeline` tool. */
const TIMELINE_DESCRIPTION = "Read the day-level timeline this session's compaction engine has already built. A rollup is a chronology of one UTC day assembled from that day's checkpoints, with (seq N) citations into the log, so this answers \"what happened on the 11th\" without scanning the log or re-summarising anything. Local and free: no model call, no network. Returns the most recent days by default; pass `period` for one specific day, or `period: \"list\"` for just the available days.";

/**
 * Build the `lcm_timeline` tool definition: the read side of the rollup store.
 *
 * Rollups were written and never read. The pass runs on every idle, costs up to
 * `rollupBuildsPerPass` model calls, and nothing exposed the result — lcm-x serves
 * the same data through its `lcm_recent` tool, which is the piece this mirrors.
 * @param resolved - validated config; `rollupDir` is where the sidecar lives.
 * @returns a registry-ready ToolDefinition.
 */
function defineTimelineTool(resolved, toolName = "lcm_timeline") {
  return defineTool({
    name: toolName,
    description: TIMELINE_DESCRIPTION,
    parameters: {
      period: {
        type: "string",
        description: 'Optional. A UTC day as "YYYY-MM-DD" to read that day only, or "list" to return just the available days and their sizes.'
      },
      limit: {
        type: "integer",
        description: "Optional number of most-recent days to return when `period` is omitted. Defaults to 3."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", required: true },
          days: { type: "array", required: true, items: { type: "string" } },
          returned: { type: "integer", required: true },
          available: { type: "integer", required: true }
        }
      }
    },
    execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined || agent.session === undefined) {
        throw new HarnessError("lcm_timeline requires a calling agent with a session", "TIMELINE_AGENT_REQUIRED");
      }
      const stored = readRollups(resolved.rollupDir, agent.session.id);
      if (stored.length === 0) {
        return {
          text: "lcm: no timeline has been built for this session yet. Rollups are written on idle, after a checkpoint exists for the day.",
          days: [],
          returned: 0,
          available: 0
        };
      }
      const days = stored.map((record) => record.periodStart).sort();
      const period = typeof args.period === "string" ? args.period.trim() : "";
      if (period === "list") {
        return { text: days.join("\n"), days, returned: days.length, available: stored.length };
      }
      const wanted = period.length > 0
        ? stored.filter((record) => record.periodStart === period)
        : stored.slice().sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1)).slice(0, Math.max(1, args.limit ?? 3));
      if (wanted.length === 0) {
        return {
          text: "lcm: no timeline for " + period + ". Available: " + days.join(", "),
          days,
          returned: 0,
          available: stored.length
        };
      }
      const body = wanted
        .map((record) => "## " + record.periodStart + "  (" + record.sourceTokens + " tokens -> " + record.tokens + ")\n" + record.text)
        .join("\n\n");
      return {
        text: body,
        days: wanted.map((record) => record.periodStart),
        returned: wanted.length,
        available: stored.length
      };
    },
    presentCall: (args) => ({
      card: "generic",
      title: "Read timeline",
      kind: "read",
      rawInput: args.period ?? "recent"
    })
  });
}

/**
 * Build the `search` (grep) tool definition against one resolved config.
 * @param resolved - validated `{ maxRecallTokens, maxSearchHits }`.
 * @returns a registry-ready ToolDefinition.
 */
function defineSearchTool(resolved, toolName = "lcm_search") {
  return defineTool({
    name: toolName,
    description: SEARCH_DESCRIPTION,
    parameters: {
      pattern: {
        type: "string",
        required: true,
        description: "Keyword or regular expression to search for (case-insensitive). Prefer one distinctive word over a sentence or an adjacent phrase; use | for alternatives (timeout|ETIMEDOUT). Escape regex special characters."
      }
    },
    output: SEARCH_OUTPUT,
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined) throw new HarnessError("search requires a calling agent with a session", "RECALL_AGENT_REQUIRED");
      let result;
      try {
        // Hybrid collapses to the lexical search, byte for byte, whenever the
        // vector layer is off (the default) or `rank` names a lexical mode.
        result = await searchSessionHybrid(agent.session, args.pattern, resolved, exec.signal);
      } catch (error) {
        if (error instanceof InvalidSearchPatternError) throw new HarnessError(error.message, "SEARCH_INVALID_PATTERN", { cause: error });
        throw error;
      }
      return {
        text: result.text,
        pattern: result.pattern,
        totalMatches: result.totalMatches,
        omitted: result.omitted,
        truncated: result.truncated,
        tokens: result.tokens
      };
    },
    presentCall: (args) => ({
      card: "generic",
      title: "Search history",
      kind: "read",
      rawInput: args.pattern
    })
  });
}

/**
 * Register the recall tools (`recall` restore + `search` grep).
 * @param ctx - context carrying the tools service.
 * @param config - `{ maxRecallTokens?, maxSearchHits? }`.
 * @returns the installed registrations' combined disposer.
 */
function apply(ctx, config) {
  // The overlay is merged before resolving so a value set from the panel is also
  // what a freshly booted process starts with, not only what a running one got
  // patched to.
  const declared = config;
  const resolved = resolveConfig({ ...config, ...overlayFor("vector") });
  // Live surface for the panel: the search row owns the vector keys, so it is the
  // row that receives them. `Object.assign` onto the SAME resolved record is the
  // mechanism — every handler reads `resolved.key` at call time, so replacing the
  // record would strand the closures that tools were registered with.
  const liveKeys = () => hotKeysFor("vector");
  const applyConfig = (patch, options = {}) => {
    const next = resolveConfig({ ...declared, ...overlayFor("vector"), ...patch });
    const commit = () => { Object.assign(resolved, next); };
    if (options.dryRun === true) return commit;
    commit();
    return undefined;
  };
  if (typeof ctx.effect === "function") {
    ctx.effect(() => registerLiveConsumer("tool-lcm-expand", "vector", liveKeys, applyConfig, () => ({ ...resolved })));
  }
  // ── the embedding maintenance driver ──────────────────────────────────
  // lcm-x does not gate this on an idle agent. `_schedule_embedding_maintenance` fires
  // on session bind and after a leaf is published, runs one bounded pass, and re-arms
  // at `_LOCAL_IDLE_MULTIPLIER x` the wall clock that pass took (`engine.py:3149,3165`,
  // `embedding_maintenance.py:230`). The gate is `embeddings_enabled`; the pacing is
  // that cycle.
  //
  // Two things this port got wrong, both measured:
  //
  //   - it was gated on `agent/status === "idle"`, so an active conversation embedded
  //     nothing: eight minutes, 2 400 texts pending, zero rows written.
  //   - it drove ONE session, the one that happened to fire. Upstream's pass is keyed
  //     by DATABASE and walks the whole corpus. Here the backlog sat in twelve
  //     sessions, most of them finished subagent logs that never emit again, so
  //     per-session draining could not reach them by construction.
  //
  // So the chain is process-wide and walks every session log, starting with the one
  // that triggered it.
  /** Rest 0.82 x what the last pass spent. lcm-x's own constant (#1586). */
  const EMBED_DUTY_RATIO = 0.82;
  /** Never tighter than this, so a pass that returns instantly cannot spin. */
  const EMBED_MIN_REST_MS = 1_000;
  /** The one chain. `{ timer, stopped, queue, index }` while running, else null. */
  let embedJob = null;
  /** When the last full-corpus sweep started; see `corpusQueue`. */
  let lastSweepAt = 0;

  /** Where a walk's boundaries are recorded. The maintenance lines go to stdout,
   *  which nothing in this profile can read back, so "is it walking or spinning"
   *  was unanswerable from outside. */
  const sweepLogPath = (process.env.DSH_HOME ?? os.homedir() + "/.dsh") + "/lcm-sweep.log";
  const noteSweep = (line) => fs.appendFileSync(sweepLogPath, new Date().toISOString() + " " + line + "\n");

  /** File -> mtimeMs at which the sweep last DRAINED it. */
  const seenFiles = new Map();
  /** A full sweep walks every log, so it runs at most this often. */
  const EMBED_SWEEP_COOLDOWN_MS = 30 * 60_000;
  /**
   * Ceiling for ONE slice, watchdog included.
   *
   * `vectorTimeoutMs` bounds a single request, but a pass issues several batches and
   * the abort has been observed not to fire: measured 2026-11-17, a chain embedded one
   * text and then sat for nine minutes with no output, and the operator-run drain hung
   * the same way at its tail. A slice that cannot settle must not park the chain, so it
   * is raced against this ceiling and the sweep moves on. The abandoned pass keeps
   * running in the background; writes are content-addressed, so a late write is a
   * duplicate, not a corruption.
   */
  const EMBED_SLICE_CEILING_MS = 180_000;

  /**
   * A session-shaped view over one persisted log.
   *
   * The log is inflated on first read and kept for the life of this view, so the
   * several slices a large corpus needs cost one inflate. `deriveEventMessage` is the
   * harness's own: an approximation writes text no search route looks up.
   * @param file - absolute path to `session.v4.jsonl.zstd`.
   * @param id - the session id this log belongs to.
   * @returns a session-shaped value `embedBackfill` accepts.
   */
  function logSession(file, id, stamp) {
    let cached;
    return {
      id,
      // Where this source came from, so the sweep can remember it was drained at
      // this revision. A live session passed in by a trigger has neither.
      file,
      stamp,
      snapshotEvents() {
        if (cached === undefined) cached = readLog(file) ?? [];
        return cached;
      },
      get seq() { return 0; },
      eventAt: () => undefined,
      deriveEventMessage
    };
  }

  /**
   * The queue one sweep walks: the triggering session first, then every log.
   * @param trigger - the session that fired the chain, if any.
   * @returns session-shaped sources in order.
   */
  function corpusQueue(trigger) {
    const queue = [];
    if (trigger !== undefined) queue.push(trigger);
    // A source that has not been written since it was last DRAINED cannot have new
    // text. Without this every walk re-derived and re-hashed all 290 logs (426 MB)
    // to find the handful of new messages, which is what held the host at ~1 core
    // with three rows a minute to show for it. Only a source that reported
    // `remaining === 0` is remembered, so an unfinished one is always retried.
    const seen = (file, stamp) => stamp !== undefined && seenFiles.get(file) === stamp;
    // The full sweep is bounded by a cooldown, not run on every trigger. Walking 290
    // logs means inflating them all — measured ~15 s of CPU for this deployment — and
    // a session that goes idle every turn would pay it every turn. Once per window is
    // enough: the corpus does not restock that fast, and a single sweep drains it.
    if (Date.now() - lastSweepAt < EMBED_SWEEP_COOLDOWN_MS) return queue;
    lastSweepAt = Date.now();
    let files = [];
    try { files = sessionFiles(); } catch { files = []; }
    for (const entry of files) {
      if (trigger !== undefined && entry.id === trigger.id) continue;
      if (seen(entry.file, entry.mtimeMs)) continue;
      queue.push(logSession(entry.file, entry.id, entry.mtimeMs));
    }
    return queue;
  }

  /**
   * Advance the corpus chain by one slice.
   *
   * A slice is one bounded `embedBackfill` pass on the current source; the source is
   * left in place while it still has work, and the chain moves on when it drains or
   * stops moving. The next slice is scheduled at `EMBED_DUTY_RATIO x` the wall clock
   * the last one took, and the timer is unref'd so a pending pass never holds the
   * process open.
   * @param trigger - the session that fired the chain, if any.
   */
  function driveEmbed(trigger) {
    if (resolved.enabled !== true) return;
    if (embedJob !== null) return;
    const job = { timer: null, stopped: false, queue: null, index: 0, embedded: 0, slices: 0, lastLogAt: Date.now(), at: Date.now() };
    embedJob = job;

    const schedule = (ms) => {
      job.timer = setTimeout(() => {
       // A rejected tick used to end the chain with nothing written anywhere: the boot
       // walk stopped after 90 texts with no `done` line and no log to read.
       tick().catch((error) => noteSweep("error " + String(error instanceof Error ? error.message : error)));
     }, ms);
      if (typeof job.timer.unref === "function") job.timer.unref();
    };

    const tick = async () => {
      job.timer = null;
      if (job.stopped) return;
      if (job.queue === null) {
        job.queue = corpusQueue(trigger?.session ?? trigger);
        noteSweep("start sources=" + job.queue.length);
      }
      const session = job.queue[job.index];
      if (session === undefined) {
        // A sweep always leaves one line, so silence can never again mean "it ran and
        // had nothing to do" as well as "it never ran".
        ctx.logger.info(
          `lcm-embed maintenance: corpus sweep done, embedded ${job.embedded} text(s) across ${job.slices} slice(s), ${job.queue.length} source(s)`
        );
        noteSweep("done embedded=" + job.embedded + " slices=" + job.slices + " sources=" + job.queue.length + " ms=" + (Date.now() - job.at));
        embedJob = null;
        return;
      }
      const started = Date.now();
      let report;
      let watchdog;
      try {
        ({ report } = await Promise.race([
          embedBackfill(session, resolved, { apply: true, limit: resolved.embedMaintenanceLimit }),
          new Promise((_resolve, reject) => {
            watchdog = setTimeout(
              () => reject(new Error("slice watchdog: no result in " + EMBED_SLICE_CEILING_MS + " ms")),
              EMBED_SLICE_CEILING_MS
            );
            if (typeof watchdog.unref === "function") watchdog.unref();
          })
        ]));
      } catch (error) {
        if (watchdog !== undefined) clearTimeout(watchdog);
        // No turn to fail: the cache is the state, so moving on loses nothing.
        ctx.logger.warn(`lcm-embed maintenance skipped ${String(session.id).slice(0, 24)}: ${error instanceof Error ? error.message : String(error)}`);
        job.index += 1;
        schedule(EMBED_MIN_REST_MS);
        return;
      }
      if (watchdog !== undefined) clearTimeout(watchdog);
      const active = Date.now() - started;
      job.slices += 1;
      job.embedded += report.embedded;
      if (report.embedded > 0) {
        ctx.logger.info(`lcm-embed maintenance: embedded ${report.embedded} text(s), ${report.remaining} remaining, ${active} ms`);
      } else if (report.failed > 0) {
        // A pass that embeds nothing used to log NOTHING, which is how every batch
        // timed out for two days without a single line to show for it.
        ctx.logger.warn(
          `lcm-embed maintenance: embedded 0, failed ${report.failed}` +
          `${report.stopped === undefined || report.stopped === "" ? "" : `, stopped on ${report.stopped}`}` +
          " — check vectorTimeoutMs against the endpoint's per-text latency"
        );
      }
      if (job.stopped) return;
      // A sweep over 290 sources runs for minutes and most of them have nothing to say,
      // so it reports its position on a clock. Without this the chain is silent until
      // it finishes, which is indistinguishable from a chain that died.
      if (Date.now() - job.lastLogAt >= 60_000) {
        job.lastLogAt = Date.now();
        ctx.logger.info(
          `lcm-embed maintenance: sweep ${job.index + 1}/${job.queue.length} sources, embedded ${job.embedded} text(s) over ${job.slices} slice(s)`
        );
      }
      // Drained, or this source stopped moving: advance. Retrying a no-progress pass
      // would spin on the same bytes forever. A source that drained at this revision
      // is remembered so the next walk skips the inflate entirely.
      // Drained OR stalled. A source that embedded nothing is "stopped moving" as far as
      // this walk is concerned, and the next walk would pay the same 0.6-6.7 s per
      // source for the same answer -- measured on 290 sources at 1.8 cores with zero
      // rows written. The pass still logs "embedded 0, failed N" when something breaks.
      if ((report.remaining === 0 || report.embedded === 0) && session.file !== undefined) {
        seenFiles.set(session.file, session.stamp);
      }
      if (report.remaining === 0 || report.embedded === 0) job.index += 1;
      if (job.index >= job.queue.length) {
        ctx.logger.info(
          `lcm-embed maintenance: corpus sweep done, embedded ${job.embedded} text(s) across ${job.slices} slice(s), ${job.queue.length} source(s)`
        );
        noteSweep("done embedded=" + job.embedded + " slices=" + job.slices + " sources=" + job.queue.length + " ms=" + (Date.now() - job.at));
        embedJob = null;
        return;
      }
      schedule(Math.max(EMBED_MIN_REST_MS, Math.round(EMBED_DUTY_RATIO * active)));
    };
    tick().catch((error) => noteSweep("error " + String(error instanceof Error ? error.message : error)));
  }
  // One sweep per activation, deferred so it never delays the row coming up.
  //
  // The chain also starts on `agent/status` and on a published checkpoint, but neither
  // is guaranteed to reach a freshly loaded row: a restart happens mid-turn, the phase
  // change already fired, and `agent/status` only announces CHANGES
  // (dsh-agent-loop:565). Measured: after a boot the row sat silent for 50 minutes
  // because no event ever arrived. Upstream has the same trigger and does not have this
  // hole, because its worker starts with the process rather than with an event.
  ctx.effect(() => {
    const timer = setTimeout(() => { driveEmbed(undefined); }, 5_000);
    if (typeof timer.unref === "function") timer.unref();
    return () => clearTimeout(timer);
  });
  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(defineRecallTool(resolved, "lcm_expand")),
      ctx.tools.register(defineSearchTool(resolved, "lcm_search")),
      // The read side of the rollup store: the pass wrote chronologies nothing could
      // reach, which made every idle's model calls unread output.
      ctx.tools.register(defineTimelineTool(resolved, "lcm_timeline")),
      // ── incremental embedding maintenance ────────────────────────────────
      // lcm-x triggers a bounded pass on session BIND and after a LEAF IS
      // PUBLISHED (`engine.py:3149`, `engine.py:3165`), not on an idle agent, and it
      // paces the chain with a duty cycle rather than a temporal gate. Both triggers
      // are reproduced here; `driveEmbed` owns the pacing.
      //
      // It belongs on THIS row because the engine row deliberately carries no vector
      // keys — nothing in the compaction path reads one, so the row that owns the
      // embedding configuration is the only one that can decide this.
      ctx.on("agent/status", ({ agent }) => {
        // BIND: the agent exists, so its compacted corpus is now addressable. This is
        // the closest analogue of lcm-x's bind-time trigger; it fires once per turn
        // boundary in practice and `driveEmbed` dedupes by session.
        const session = agent?.session;
        if (session === undefined) return;
        driveEmbed(session);
      }),
      ctx.on("session/event", (session, event) => {
        // PUBLICATION: a checkpoint is what makes new texts embeddable, and it is
        // lcm-x's primary trigger (`engine.py:3165`). Upstream filters to leaves
        // (`node.depth === 0`) because a condensation's body is derived from
        // checkpoints already embedded. This fires on both: telling them apart needs
        // the surface fold, and a condensation that yields nothing makes the pass
        // embed 0 and the chain stop, so the extra trigger costs one no-op.
        if (event?.type !== "compaction/summary") return;
        driveEmbed(session);
      })
    ];
    // The original backend's names stay available so anything already written
    // against `recall` / `search` keeps working after switching backends.
    if (resolved.legacyNames) {
      disposers.push(ctx.tools.register(defineRecallTool(resolved, "recall")));
      disposers.push(ctx.tools.register(defineSearchTool(resolved, "search")));
    }
    return () => {
      // A scheduled pass is a timer, not a registration, so unloading the row has to
      // stop it explicitly. Without this the chain outlives its own ctx and the next
      // slice writes through a disposed row.
      if (embedJob !== null) {
        embedJob.stopped = true;
        if (embedJob.timer !== null) clearTimeout(embedJob.timer);
        embedJob = null;
      }
      for (const dispose of disposers) dispose();
    };
  });

  // ── the read-only insight endpoints ──────────────────────────────────────
  // The browser half cannot read session logs, sidecars or the vector cache, and a
  // Session projection folds one session's committed events — not 267 logs plus
  // three directories. So the panel's data comes from here, over the same carrier
  // the meme gallery uses. Registration is an effect: unloading the row removes the
  // routes.
  // `webServer` is optional in practice: a headless or CLI-only profile composes the
  // tool row without a browser carrier, and the insight panel has nothing to serve
  // there. Registering unconditionally threw "Cannot read properties of undefined"
  // and took the WHOLE tool row down with it — every lcm tool, not just the panel.
  if (ctx.webServer !== undefined) {
    for (const route of insightRoutes(ctx, resolved)) {
      ctx.effect(() => ctx.webServer.register(route));
    }
    // Warm the report cache while nobody is looking. The first panel open after a
    // restart otherwise pays the cold sweep (~15 s on 279 logs), and the operator
    // spends it watching a spinner. Deferred one macrotask so activation itself is
    // not delayed, and failures are logged rather than surfaced: this is an
    // optimisation, and a broken cache must never keep the tools from loading.
    ctx.effect(() => {
      const timer = setTimeout(() => {
        warmReports(ctx, resolved).catch((error) => {
          ctx.logger?.warn?.("lcm insight prewarm failed: " + (error instanceof Error ? error.message : String(error)));
        });
      }, 0);
      // An unref'd timer cannot hold the process open on its own.
      if (typeof timer.unref === "function") timer.unref();
      return () => clearTimeout(timer);
    });
  }
}

export { Config, DEFAULT_MAX_RECALL_TOKENS, MAX_RECALL_TOKENS, RECALL_DESCRIPTION, SEARCH_DESCRIPTION, TIMELINE_DESCRIPTION, apply, defineRecallTool, defineSearchTool, defineTimelineTool, inject, insightRoutes, name, resolveConfig };
