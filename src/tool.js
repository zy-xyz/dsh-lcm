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
import z from "@deepseek-ai/schemastery";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { DEFAULT_MAX_RECALL_TOKENS, MAX_RECALL_TOKENS, recallSession, resolveRecallBudget, resolveRecallReference } from "./recall.js";
import { DEFAULT_MAX_SEARCH_HITS, HYBRID_RANK_MODES, InvalidSearchPatternError, RANK_MODES, searchSessionHybrid } from "./search.js";
import { resolveVectorConfig } from "./vectors.js";
import { embedBackfill } from "./command.js";
import { insightRoutes } from "./insight.js";
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
  const resolved = resolveConfig(config);
  // Sessions with an incremental embedding pass in flight.
  const embedPasses = new Set();
  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(defineRecallTool(resolved, "lcm_expand")),
      ctx.tools.register(defineSearchTool(resolved, "lcm_search")),
      // The read side of the rollup store: the pass wrote chronologies nothing could
      // reach, which made every idle's model calls unread output.
      ctx.tools.register(defineTimelineTool(resolved, "lcm_timeline")),
      // ── incremental embedding maintenance ────────────────────────────────
      // lcm-x schedules one bounded pass per corpus in the background after a leaf
      // is published and on session bind, "active exactly when embeddings_enabled".
      // The gate here is the same switch that turns the semantic route on, and the
      // bound is `embedMaintenanceLimit` — one or two batches, not a corpus drain.
      //
      // Why it belongs on THIS row: the engine row deliberately carries no vector
      // keys (nothing in the compaction path reads them), so the row that owns the
      // embedding configuration is the only one that can decide this.
      //
      // Why idle: a pass embeds texts the search route may look up, and doing that
      // mid-turn would compete with the request for the endpoint.
      ctx.on("agent/status", ({ agent, status }) => {
        if (status !== "idle") return;
        // resolveVectorConfig renames the switch to `enabled` when it freezes the
        // record, so the resolved field is not `vectorEnabled`. Reading the wrong one
        // here would make the pass dead code that still logs nothing.
        if (resolved.enabled !== true) return;
        const session = agent?.session;
        if (session === undefined) return;
        if (embedPasses.has(session.id)) return;
        embedPasses.add(session.id);
        void (async () => {
          try {
            const { report } = await embedBackfill(session, resolved, { apply: true, limit: resolved.embedMaintenanceLimit });
            if (report.embedded > 0) {
              ctx.logger.info(`lcm-embed maintenance: embedded ${report.embedded} text(s), ${report.remaining} remaining`);
            } else if (report.failed > 0) {
              // A pass that embeds nothing used to log NOTHING, which is how every
              // batch timed out for two days without a single line to show for it.
              // "Nothing to do" and "nothing worked" must not look the same.
              ctx.logger.warn(
                `lcm-embed maintenance: embedded 0, failed ${report.failed}` +
                `${report.stopped === undefined || report.stopped === "" ? "" : `, stopped on ${report.stopped}`}` +
                ` — check vectorTimeoutMs against the endpoint's per-text latency`
              );
            }
          } catch (error) {
            // No turn to fail: the next idle tries again, and the cache is the state.
            ctx.logger.warn(`lcm-embed maintenance skipped: ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            embedPasses.delete(session.id);
          }
        })();
      })
    ];
    // The original backend's names stay available so anything already written
    // against `recall` / `search` keeps working after switching backends.
    if (resolved.legacyNames) {
      disposers.push(ctx.tools.register(defineRecallTool(resolved, "recall")));
      disposers.push(ctx.tools.register(defineSearchTool(resolved, "search")));
    }
    return () => {
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
  }
}

export { Config, DEFAULT_MAX_RECALL_TOKENS, MAX_RECALL_TOKENS, RECALL_DESCRIPTION, SEARCH_DESCRIPTION, TIMELINE_DESCRIPTION, apply, defineRecallTool, defineSearchTool, defineTimelineTool, inject, insightRoutes, name, resolveConfig };
