/**
 * Human-facing `/lcm-search` command for `dsh-lcm`.
 *
 * Grep-based, like VCC's `--grep`: `/lcm-search <keyword|regex>` searches the
 * session's durable event log (including content elided or truncated by
 * compaction) and appends a `form: "lcm-search"` user message with the matching
 * events and their `(seq N)` pointers, so the next model turn sees them.
 * The log is append-only, so hits are always the original content.
 *
 * Lexical on purpose, not by omission: the semantic route lives on the
 * `search` tool (see `resolveConfig` for the measured reason).
 *
 * @module dsh-lcm/command
 */
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { estimateEntryTokens } from "./compiler.js";
import { sessionEvents } from "./events.js";
import { DEFAULT_MAX_RECALL_TOKENS } from "./recall.js";
import { deriveDag } from "./summarize.js";
import { DEFAULT_MAX_SEARCH_HITS, InvalidSearchPatternError, RANK_MODES, searchSession } from "./search.js";

const name = "command-lcm-search";
const inject = ["commands"];
const USAGE = "Usage: /lcm-search <keyword|regex>";

/**
 * Why /lcm-search has no per-call budget argument — decided, not overlooked.
 *
 * `lcm_expand` grew a `maxTokens` argument because the model cannot retype: it
 * commits one call, the harness spends it, and a truncated answer with no knob
 * is a dead end inside that turn. A human at a prompt has the opposite shape —
 * they read the truncated hits and retype with a narrower pattern for free. There
 * is also no syntax slot for it: `rawInput` is the pattern itself, so a second
 * number in the same box would be ambiguous with a numeric search of the log.
 * The rendering budget for one command is already the configured
 * `maxRecallTokens` (src/search.js); an operator who wants more of every hit
 * raises that, which is a config question rather than a per-invocation one.
 */

/** Validate and default the command plugin configuration. */
function resolveConfig(config = {}) {
  const maxRecallTokens = config.maxRecallTokens ?? DEFAULT_MAX_RECALL_TOKENS;
  const maxSearchHits = config.maxSearchHits ?? DEFAULT_MAX_SEARCH_HITS;
  const legacyNames = config.legacyNames ?? true;
  const rank = config.rank ?? "density";
  if (typeof maxRecallTokens !== "number" || !Number.isInteger(maxRecallTokens) || maxRecallTokens <= 0) throw new Error("CommandRecallConfig: maxRecallTokens must be a positive integer");
  if (typeof maxSearchHits !== "number" || !Number.isInteger(maxSearchHits) || maxSearchHits <= 0) throw new Error("CommandRecallConfig: maxSearchHits must be a positive integer");
  if (typeof legacyNames !== "boolean") throw new Error("CommandRecallConfig: legacyNames must be a boolean");
  // /lcm-search is deliberately lexical, and says so instead of accepting a
  // vector rank it would ignore: it is the operator's grep, typed at a prompt
  // and answered inline. The semantic arm costs ~88 ms per candidate text on
  // the measured endpoint (44.0 s cold for the 500-event window, src/vectors.js),
  // and that is a stall a human feels in the UI. The `search` tool owns the
  // vector route, where the model's wording is the thing that needs help.
  if (!RANK_MODES.includes(rank)) {
    throw new Error("CommandRecallConfig: rank must be one of " + RANK_MODES.join(", ") + " — /lcm-search is lexical; set a vector rank on the lcm_search tool row instead");
  }
  return { maxRecallTokens, maxSearchHits, legacyNames, rank };
}

/**
 * Composition-time schema for this row — same contract as the tool row's, and
 * the same reason: without it the Loader skips validation, `apply` runs, and a
 * bad value is only caught by {@link resolveConfig} after the old instance is
 * already disposed. With it the value is refused before the restart.
 *
 * The `rank` enum is the SCHEMA HALF of the lexical-only decision
 * {@link resolveConfig} states: `RANK_MODES` only, so `vector` / `hybrid` are
 * rejected here as well as there. Declaring the full rank set and relying on the
 * runtime check would put the two layers in disagreement — the schema accepting
 * what `apply` refuses — which is the defect class this schema removes.
 *
 * The vector keys are deliberately absent: this row reads none of them, so
 * declaring them would advertise configuration that does nothing. schemastery
 * cannot reject an unknown KEY (an object resolver re-merges undeclared keys
 * into its output), so an operator's stray `vectorEnabled` is ignored here
 * instead of failing — the rank enum is the part that must fail.
 *
 * No `.default()` calls: see the tool row's schema for why (schemastery's
 * `simplify` would omit an explicitly-set value that equals the default).
 */
const Config = z.object({
  rank: z.union([...RANK_MODES]),
  maxSearchHits: z.number().step(1).min(1),
  maxRecallTokens: z.number().step(1).min(1),
  legacyNames: z.boolean()
});

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
function defineRecallCommand(resolved, commandName = "lcm-search") {
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
function apply(ctx, config) {
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
 * Tokens of the checkpoint body one `compaction/summary` event actually produced.
 *
 * `maxTokens` on that event is the summary TARGET the instruction asked the model
 * to aim for — `summarize.js` returns its `budgetTokens`, and `region.js` commits
 * it under the contract's field name. Summing it reported the request as if it
 * were the result: on a real session the surface claimed "16384 kept, 22.68:1,
 * 355241 saved" for a checkpoint whose body is 6183 tokens (15832 chars), where
 * the measured answer is "6183 kept, 60.10:1, 365442 saved".
 *
 * The measurement is the event's own `summary` blocks, sized with
 * `estimateEntryTokens` — the estimator the engine states its shrink guarantee
 * and its budgets in, so the two sides of the ratio stay estimator-to-estimator.
 * @param summary - one `compaction/summary` event.
 * @returns the produced body size in estimated tokens (0 when nothing was recorded).
 */
function keptTokensOf(summary) {
  const blocks = summary.data?.summary;
  if (!Array.isArray(blocks)) return 0;
  return estimateEntryTokens(blocks.map((block) => (block.type === "text" ? block.text ?? "" : "")).join("\n"));
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
function buildStatus(session) {
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
    keptTotal += keptTokensOf(summary);
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
function defineStatusCommand(commandName = "lcm-status") {
  return {
    name: commandName,
    description: "Show what this session has compacted: checkpoints, depth, tokens saved",
    handler: (invocation) => ({ kind: "success", text: buildStatus(invocation.agent.session) })
  };
}

export { Config, USAGE, apply, buildStatus, defineRecallCommand, defineStatusCommand, inject, name, resolveConfig };
