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
import { DEFAULT_MAX_RECALL_TOKENS } from "./recall.js";
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
    const disposers = [ctx.commands.register(defineRecallCommand(resolved, "lcm-search"))];
    // Keep the original backend's command name working too.
    if (resolved.legacyNames) disposers.push(ctx.commands.register(defineRecallCommand(resolved, "recall")));
    return () => {
      for (const dispose of disposers) dispose();
    };
  });
}
