/**
 * Human-facing `/lcm-search` command for `dsh-lcm`.
 *
 * Grep-based, like VCC's `--grep`: `/lcm-search <keyword|regex>` searches the
 * session's durable event log (including content elided or truncated by
 * compaction) and appends a `form: "lcm-search"` user message with the matching
 * events and their `(seq N)` pointers, so the next model turn sees them.
 * The log is append-only, so hits are always the original content.
 *
 * @module dsh-lcm/command
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { sessionEvents } from "./events.js";
import { DEFAULT_MAX_RECALL_TOKENS } from "./recall.js";
import { deriveDag } from "./summarize.js";
import { DEFAULT_MAX_SEARCH_HITS, InvalidSearchPatternError, searchSession } from "./search.js";

export const name = "command-lcm-search";
export const inject = ["commands"];
export const USAGE = "Usage: /lcm-search <keyword|regex>";

/** Validate and default the command plugin configuration. */
export function resolveConfig(config = {}) {
  const maxRecallTokens = config.maxRecallTokens ?? DEFAULT_MAX_RECALL_TOKENS;
  const maxSearchHits = config.maxSearchHits ?? DEFAULT_MAX_SEARCH_HITS;
  const legacyNames = config.legacyNames ?? true;
  const rank = config.rank ?? "density";
  if (typeof maxRecallTokens !== "number" || !Number.isInteger(maxRecallTokens) || maxRecallTokens <= 0) throw new Error("CommandRecallConfig: maxRecallTokens must be a positive integer");
  if (typeof maxSearchHits !== "number" || !Number.isInteger(maxSearchHits) || maxSearchHits <= 0) throw new Error("CommandRecallConfig: maxSearchHits must be a positive integer");
  if (typeof legacyNames !== "boolean") throw new Error("CommandRecallConfig: legacyNames must be a boolean");
  return { maxRecallTokens, maxSearchHits, legacyNames, rank };
}

/** Execute one grep-based recall request against the calling agent's session. */
async function executeRecall(invocation, resolved) {
  const pattern = invocation.rawInput.trim();
  if (pattern.length === 0) return {
    kind: "error",
    text: USAGE
  };
  let result;
  try {
    result = searchSession(invocation.agent.session, pattern, resolved);
  } catch (error) {
    if (error instanceof InvalidSearchPatternError) return {
      kind: "error",
      text: error.message
    };
    throw error;
  }
  if (result.totalMatches === 0) return {
    kind: "error",
    text: `No matching events for "${result.pattern}".`
  };
  let appended;
  try {
    appended = await invocation.agent.runMaintenance(() => {
      return invocation.agent.session.append("user/message", createUserMessage({
        content: [{ type: "text", text: result.text }],
        source: { kind: "plugin", plugin: "recall", form: "lcm-search" }
      }), {
        surfaceOp: "append",
        sourceEventSeqs: result.hits.map((hit) => hit.seq)
      });
    });
  } catch (error) {
    return {
      kind: "error",
      text: error instanceof Error ? error.message : String(error)
    };
  }
  return {
    kind: "success",
    text: `Found ${result.totalMatches} matching event(s) (~${result.tokens} tokens).`,
    sourceEventSeq: appended.seq
  };
}

/**
 * Build the `lcm-search` command definition (for tests and introspection).
 * @param resolved - validated `{ maxRecallTokens, maxSearchHits }`.
 * @returns a registry-ready CommandDefinition.
 */
export function defineRecallCommand(resolved, commandName = "lcm-search") {
  return {
    name: commandName,
    description: "Search earlier conversation history by keyword or regex",
    handler: (invocation) => executeRecall(invocation, resolved)
  };
}

/**
 * Register `/lcm-search` for every composed human-command adapter.
 * @param ctx - context carrying the command registry.
 * @param config - `{ maxRecallTokens?, maxSearchHits? }`.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  ctx.effect(() => {
    const disposers = [
      ctx.commands.register(defineRecallCommand(resolved, "lcm-search")),
      // G6.1: the state surface. A command, not a tool - it answers an operator's
      // question, and a tool would spend model attention on every request.
      ctx.commands.register(defineStatusCommand())
    ];
    // Keep the original backend's command name working too.
    if (resolved.legacyNames) disposers.push(ctx.commands.register(defineRecallCommand(resolved, "recall")));
    return () => {
      for (const dispose of disposers) dispose();
    };
  });
}

/**
 * `/lcm-status` — the state surface G6.1 asks for, without adding a tool.
 *
 * lcm-x exposes `lcm_status` / `lcm_inspect` for the same reason: after a
 * compaction the operator needs to see what the engine holds and what it saved,
 * and "compaction fired" is not an answer. Reading it off the log rather than
 * keeping counters in memory means the numbers survive a restart and describe the
 * session as persisted.
 * @param session - the calling agent's session.
 * @returns a human-readable status block, or a note when nothing is compacted.
 */
export function buildStatus(session) {
  const dag = deriveDag(session);
  const events = sessionEvents(session);
  const summaries = events.filter((event) => event.type === "compaction/summary");
  if (dag.checkpoints === 0) {
    return "lcm: no checkpoints in this session yet — nothing has been compacted. Surface: " + session.surface.nodes.length + " node(s).";
  }
  let shadowedTotal = 0;
  let keptTotal = 0;
  for (const summary of summaries) {
    shadowedTotal += summary.data?.shadowedTokenCount ?? 0;
    keptTotal += summary.data?.maxTokens ?? 0;
  }
  const ratio = keptTotal === 0 ? "n/a" : (shadowedTotal / keptTotal).toFixed(2) + ":1";
  const byDepth = new Map();
  for (const node of dag.nodeBySeq.values()) byDepth.set(node.depth, (byDepth.get(node.depth) ?? 0) + 1);
  const depths = [...byDepth.entries()].sort((a, b) => a[0] - b[0]).map(([depth, count]) => "d" + depth + "=" + count).join(" ");
  return [
    "lcm status",
    "  surface nodes: " + session.surface.nodes.length,
    "  checkpoints: " + dag.checkpoints + " (max depth " + dag.maxDepth + ")  " + depths,
    "  compactions: " + summaries.length,
    "  tokens: " + shadowedTotal + " shadowed -> " + keptTotal + " kept  (" + ratio + ")",
    "  saved: " + Math.max(0, shadowedTotal - keptTotal) + " tokens"
  ].join("\n");
}

/**
 * Build the `lcm-status` command definition (for tests and introspection).
 * @returns a registry-ready CommandDefinition.
 */
export function defineStatusCommand(commandName = "lcm-status") {
  return {
    name: commandName,
    description: "Show what this session has compacted: checkpoints, depth, tokens saved",
    handler: (invocation) => ({ kind: "success", text: buildStatus(invocation.agent.session) })
  };
}
