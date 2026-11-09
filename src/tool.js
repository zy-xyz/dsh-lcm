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

const name = "tool-lcm-expand";
const inject = ["tools"];

/** Validate and default the tool plugin configuration. */
function resolveConfig(config = {}) {
  const maxRecallTokens = config.maxRecallTokens ?? DEFAULT_MAX_RECALL_TOKENS;
  const maxSearchHits = config.maxSearchHits ?? DEFAULT_MAX_SEARCH_HITS;
  const legacyNames = config.legacyNames ?? true;
  const rank = config.rank ?? "density";
  if (typeof maxRecallTokens !== "number" || !Number.isInteger(maxRecallTokens) || maxRecallTokens <= 0) throw new Error("ToolRecallConfig: maxRecallTokens must be a positive integer");
  if (typeof maxSearchHits !== "number" || !Number.isInteger(maxSearchHits) || maxSearchHits <= 0) throw new Error("ToolRecallConfig: maxSearchHits must be a positive integer");
  if (typeof legacyNames !== "boolean") throw new Error("ToolRecallConfig: legacyNames must be a boolean");
  if (typeof rank !== "string" || !RANK_MODES.includes(rank) && !HYBRID_RANK_MODES.includes(rank)) {
    throw new Error("ToolRecallConfig: rank must be one of " + [...RANK_MODES, ...HYBRID_RANK_MODES].join(", ") + " (vector/hybrid need vectorEnabled)");
  }
  // The vector keys ride along so the search handler can read them; they are
  // inert unless `vectorEnabled` is true and `rank` names a vector mode.
  return { maxRecallTokens, maxSearchHits, legacyNames, rank, ...resolveVectorConfig(config) };
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
  vectorCacheDir: z.string().min(1)
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
  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(defineRecallTool(resolved, "lcm_expand")),
      ctx.tools.register(defineSearchTool(resolved, "lcm_search"))
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
}

export { Config, DEFAULT_MAX_RECALL_TOKENS, MAX_RECALL_TOKENS, RECALL_DESCRIPTION, SEARCH_DESCRIPTION, apply, defineRecallTool, defineSearchTool, inject, name, resolveConfig };
