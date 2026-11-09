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
 * The exception is `/lcm-embed`, which does not search at all: it inspects and
 * fills the vector cache the `search` tool reads. Backfill is what makes the
 * semantic route useful on an existing log — a session that predates the layer
 * has no cached vectors, and every cold search pays for the same texts again.
 * Mirroring lcm-x's `/lcm embed backfill`, the default is a dry run: the count
 * is a preview until the operator types `--apply`.
 *
 * @module dsh-lcm/command
 */
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { estimateEntryTokens } from "./compiler.js";
import { sessionEvents } from "./events.js";
import { DEFAULT_MAX_RECALL_TOKENS } from "./recall.js";
import { deriveDag } from "./summarize.js";
import { DEFAULT_MAX_SEARCH_HITS, InvalidSearchPatternError, RANK_MODES, collectVectorItems, searchSession } from "./search.js";
import { MAX_EMBED_BATCH, VECTOR_TEXT_LIMIT, embedTextsTolerant, resolveVectorAuth, resolveVectorConfig, vectorCache, vectorCacheStats, vectorSearchBudgetMs } from "./vectors.js";

const name = "command-lcm-search";
const inject = ["commands"];
const USAGE = "Usage: /lcm-search <keyword|regex>";
const EMBED_NAME = "lcm-embed";
const EMBED_USAGE = "Usage: /lcm-embed status | /lcm-embed backfill [--apply] [--limit N]";

/**
 * lcm-x's backfill default. A pass is bounded because the cost is the texts,
 * not the call: an unbounded first run on a 24k-event log would embed thousands
 * of events before the operator sees a single line of output.
 */
const DEFAULT_BACKFILL_LIMIT = 200;

/**
 * Consecutive failed batches a backfill pass tolerates before it stops.
 *
 * A search has one deadline ({@link vectorSearchBudgetMs}); a backfill does not,
 * and must not: its row deliberately carries a long per-batch ceiling (240 s on
 * the shipped embed row) so an offline pass can ride out the endpoint's tail, and
 * shortening that with a pass deadline would throw away the tolerance the row was
 * configured for. What must not happen is a DEAD endpoint walking the whole
 * window at that ceiling — five batches of 240 s is twenty minutes of a blocked
 * command. Two consecutive batches that embed nothing is the lcm-x circuit
 * breaker's threshold, and the pass stops there: what was embedded is already on
 * disk, and the next run resumes from the cache.
 */
const BACKFILL_FAILURE_LIMIT = 2;

/**
 * Which command set one Loader row mounts.
 *
 * Command names are global in the registry and a duplicate name is a hard
 * error ("command ... is already registered"), so the two rows that share this
 * module cannot both register everything. `search` is the historical row (and
 * the default, so an existing patch keeps working untouched); `embed` is the
 * vector-cache row.
 */
const COMMAND_SETS = Object.freeze(["search", "embed"]);

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
  const commandSet = config.commandSet ?? "search";
  if (!COMMAND_SETS.includes(commandSet)) throw new Error("CommandRecallConfig: commandSet must be one of " + COMMAND_SETS.join(", "));
  // Spread, not nest: the embed handlers read `enabled`, `model`, `dim`,
  // `cacheDir` and the candidate bounds directly, the way the tool row does.
  return { maxRecallTokens, maxSearchHits, legacyNames, rank, commandSet, ...resolveVectorConfig(config) };
}

/**
 * Composition-time schema for this row — same contract as the tool row's, and
 * the same reason: without it the Loader skips validation, `apply` runs, and a
 * bad value is only caught by {@link resolveConfig} after the old instance is
 * already disposed. With it a DECLARED value is refused before the restart.
 *
 * The `rank` enum is the SCHEMA HALF of the lexical-only decision
 * {@link resolveConfig} states: `RANK_MODES` only, so `vector` / `hybrid` are
 * rejected here as well as there. Declaring the full rank set and relying on the
 * runtime check would put the two layers in disagreement — the schema accepting
 * what `apply` refuses — which is the defect class this schema removes.
 *
 * `commandSet` and the whole vector block ARE declared here, because this module
 * now mounts two different command families and `/lcm-embed` reads every one of
 * those keys. Leaving them undeclared was measured to be unsafe, not merely
 * loose: schemastery's `validate` keeps an unknown key, but `simplify` — the
 * function whose output a `fiber.update` re-route writes back through the
 * Loader — is a whitelist and drops it. Measured:
 *
 *   Config({rank:"density", commandSet:"embed", vectorEnabled:true})
 *     validate -> {rank, commandSet, vectorEnabled}      (kept)
 *     simplify -> {rank}                                 (dropped)
 *
 * So an undeclared `commandSet` survives until the operator changes any setting,
 * then silently reverts the embed row to the default `search` family — which
 * re-registers `lcm-search` and `lcm-status` on a row where the search row
 * already owns those names, and the command registry aborts on a duplicate. That
 * is the exact trap src/index.js documents for the engine row, and the reason
 * /lcm-search being lexical is expressed by the `rank` ENUM rather than by
 * omission.
 *
 * No `.default()` calls: see the tool row's schema for why (schemastery's
 * `simplify` would omit an explicitly-set value that equals the default).
 */
const Config = z.object({
  rank: z.union([...RANK_MODES]),
  maxSearchHits: z.number().step(1).min(1),
  maxRecallTokens: z.number().step(1).min(1),
  legacyNames: z.boolean(),
  commandSet: z.union([...COMMAND_SETS]),
  // The vector block: read by /lcm-embed, inert on a `search` row. `vectorApiKeyEnv`
  // is a variable NAME, so "" is legal (it means "send no Authorization header").
  vectorEnabled: z.boolean(),
  vectorBaseUrl: z.string().min(1),
  vectorModel: z.string().min(1),
  vectorDim: z.number().step(1).min(1),
  vectorTopK: z.number().step(1).min(1),
  vectorCandidateTokens: z.number().step(1).min(1),
  vectorCandidateLimit: z.number().step(1).min(1),
  vectorTimeoutMs: z.number().step(1).min(1),
  vectorCacheDir: z.string().min(1),
  vectorApiKeyEnv: z.string()
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
 * Register this row's commands for every composed human-command adapter.
 *
 * One row, one command family: `commandSet` decides which, because the two
 * rows that mount this module share one global registry and a duplicate name
 * aborts the second row. Default `search` keeps a patch written before
 * `/lcm-embed` existed working byte for byte.
 * @param ctx - context carrying the command registry.
 * @param config - `{ commandSet?, maxRecallTokens?, maxSearchHits?, vector* }`.
 */
function apply(ctx, config) {
  const resolved = resolveConfig(config);
  ctx.effect(() => {
    const disposers = [];
    if (resolved.commandSet === "embed") {
      disposers.push(ctx.commands.register(defineEmbedCommand(resolved)));
    } else {
      disposers.push(ctx.commands.register(defineRecallCommand(resolved, "lcm-search")));
      // G6.1: the state surface. A command, not a tool - it answers an operator's
      // question, and a tool would spend model attention on every request.
      disposers.push(ctx.commands.register(defineStatusCommand()));
      // Keep the original backend's command name working too.
      if (resolved.legacyNames) disposers.push(ctx.commands.register(defineRecallCommand(resolved, "recall")));
    }
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

/**
 * The texts one backfill pass may consider: surface-eligible events the model
 * cannot currently read.
 *
 * The rule is the search route's candidate window (src/search.js
 * `collectVectorItems`), and it has to be the same rule or the cache would be
 * warmed for events a search never asks about: message-producing types only
 * (plumbing was never compacted content), events off the session surface (the
 * visible tail is in context verbatim), newest first, priced in estimated
 * tokens rather than event count because the endpoint's cost tracks length.
 *
 * The text is the slice the search route embeds (`VECTOR_TEXT_LIMIT`), so the
 * cache key written here is the key a later search looks up. Empty text is
 * dropped: the endpoint answers HTTP 400 for "" and there is no key to write.
 *
 * @param session - the calling agent's session.
 * @param cfg - resolved vector settings (candidate bounds included).
 * @returns `[{ seq, text }]` in log order.
 */
function embedCandidates(session, cfg) {
  // The search route's own collector, not a copy.
  //
  // Which texts get embedded is decided by four interacting rules: message-
  // producing types only, nothing still on the surface, a token-priced window,
  // and the 4 000-character slice that IS the cache key. A second copy of those
  // rules would fill keys the search route never looks up — a backfill that
  // reports success and changes nothing. `collectVectorItems` is exported from
  // ./search.js for exactly this caller.
  const { items } = collectVectorItems(session, { events: cfg.candidateLimit, tokens: cfg.candidateTokens });
  return items
    .map((item) => ({ seq: item.seq, text: String(item.text ?? "").slice(0, VECTOR_TEXT_LIMIT) }))
    .filter((item) => item.text.trim().length > 0);
}

/**
 * Parse `/lcm-embed`'s raw input.
 *
 * No free-form input: the subcommand grammar is two verbs and two flags, and
 * anything else is a typo the operator wants to see rather than a pattern the
 * command would silently ignore.
 * @param rawInput - the text after `/lcm-embed`.
 * @returns `{ action, apply, limit }` or `{ error }`.
 */
function parseEmbedArgs(rawInput) {
  const tokens = String(rawInput ?? "").trim().split(/\s+/).filter((token) => token.length > 0);
  const action = tokens.shift();
  if (action === "status") {
    if (tokens.length > 0) return { error: EMBED_USAGE };
    return { action: "status", apply: false, limit: DEFAULT_BACKFILL_LIMIT };
  }
  if (action !== "backfill") return { error: EMBED_USAGE };
  let apply = false;
  let limit = DEFAULT_BACKFILL_LIMIT;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].toLowerCase();
    if (token === "--apply") {
      apply = true;
      continue;
    }
    if (token === "--limit") {
      const raw = tokens[index + 1];
      const value = Number(raw);
      if (raw === undefined || !Number.isInteger(value) || value < 1) return { error: "`--limit` must be a positive integer." };
      limit = value;
      index += 1;
      continue;
    }
    return { error: EMBED_USAGE };
  }
  return { action: "backfill", apply, limit };
}

/**
 * `/lcm-embed status` — what the cache holds and whether the layer is on.
 *
 * `dir` is reported even when it does not exist yet: the operator needs to know
 * where a backfill would write. `rank` is stated as not applicable instead of
 * invented — filling a cache never ranks anything, and the surface that does
 * rank is the `lcm_search` tool.
 * The cache totals alone cannot answer "is the semantic route warm for THIS
 * session": a cache with 900 files says nothing about whether the events this
 * session hides are among them. The window lines answer it from the calling
 * session, priced with the same collector the search route and the backfill use,
 * so `pending` is exactly what the next search must embed and what a `--apply`
 * would send. Read-only by construction: counting goes through the cache lookup
 * only, so a status call issues no provider request.
 *
 * @param cfg - resolved settings (raw config is accepted too).
 * @param session - optional calling session; absent (or a fixture without one)
 *   reports the window as zeros rather than guessing.
 * @returns the human-readable status block.
 */
async function buildEmbedStatus(cfg, session) {
  const stats = await vectorCacheStats(cfg);
  // Which source answers the bearer token is the ONE line that separates "the
  // layer is off" from "the layer is on and the gateway is refusing us" — the
  // difference between a 401 and an unset flag is otherwise invisible from here.
  const auth = await resolveVectorAuth(cfg);
  const window = await cacheWindowOf(cfg, session);
  return [
    "lcm-embed status",
    "  model: " + stats.model,
    "  dim: " + stats.dim,
    "  cache: " + stats.dir,
    "  files: " + stats.files,
    "  bytes: " + stats.bytes,
    "  candidates: " + window.candidates + " hidden text(s)",
    "  cached: " + window.cached,
    "  pending: " + window.pending + " (what one --apply would embed now)",
    "  search budget: " + vectorSearchBudgetMs(cfg) + " ms per search — the window is embedded newest-first until that deadline, then the search answers with what it has",
    "  rank: n/a — /lcm-embed only fills the cache; the lcm_search tool ranks",
    "  auth: " + describeAuth(auth.source, cfg.apiKeyEnv),
    cfg.enabled
      ? "  layer: enabled"
      : "  layer: disabled — vectorEnabled is false, so a backfill would embed nothing"
  ].join("\n");
}

/**
 * How warm the cache is for one session's candidate window.
 *
 * The window is the search route's own: `collectVectorItems` with this row's
 * `candidateLimit` / `candidateTokens`, which are the keys the search row reads
 * too. The time budget does not shrink that window — it decides how much of it
 * ONE search manages to embed — so the count answers "what would a search ask
 * for", and the `search budget` line says how much of it fits per call.
 *
 * `cached` counts window texts already on disk; `pending` is the rest, which is
 * what a `--apply` would send. Both are per candidate, like the backfill's own
 * counters, so a duplicate body counts twice here exactly as it does there.
 *
 * @param cfg - resolved settings (candidate bounds included).
 * @param session - optional calling session.
 * @returns `{ candidates, cached, pending }`, zeros without a session.
 */
async function cacheWindowOf(cfg, session) {
  if (session === undefined || session === null) return { candidates: 0, cached: 0, pending: 0 };
  const { items } = collectVectorItems(session, { events: cfg.candidateLimit, tokens: cfg.candidateTokens });
  const cache = vectorCache(cfg);
  let cached = 0;
  for (const item of items) {
    if (await cache.get(String(item.text ?? "").slice(0, VECTOR_TEXT_LIMIT)) !== null) cached += 1;
  }
  return { candidates: items.length, cached, pending: items.length - cached };
}

/**
 * One line describing where the bearer token comes from, never the token.
 *
 * `none` with a configured name is the interesting case: the layer is on, the
 * endpoint needs a key, and the name resolves to nothing — that is a 401 on the
 * wire and a lexical fallback in the search, and it must not look like a
 * configuration that is merely switched off.
 * @param source - "env" | "credential-store" | "none".
 * @param name - the configured environment-variable name ("" when unset).
 * @returns the human-readable line.
 */
function describeAuth(source, name) {
  if (typeof name !== "string" || name.length === 0) return "none (no vectorApiKeyEnv; keyless backend)";
  if (source === "env") return "env " + name;
  if (source === "credential-store") return "credential store " + name;
  return "none — " + name + " is set in neither the environment nor the credential store, so a hosted gateway will answer 401";
}

/**
 * One backfill pass: measure, and embed only when asked.
 *
 * Dry run is the default because the cost is real (one provider request per 32
 * texts) and the count is what an operator needs first. The cache is the
 * short-circuit: a text whose vector is already on disk is never sent again,
 * which is what makes a second `--apply` a no-op.
 *
 * @param session - the calling agent's session.
 * @param cfg - resolved vector settings.
 * @param options - `{ apply, limit }`.
 * @returns `{ report, text }` with `{ scanned, alreadyCached, embedded, failed, limit, applied }`.
 */
async function embedBackfill(session, cfg, options = {}) {
  const limit = options.limit ?? DEFAULT_BACKFILL_LIMIT;
  const apply = options.apply === true;
  const candidates = embedCandidates(session, cfg);
  // `--limit` keeps the NEWEST N of the window: recent-but-compacted is the
  // more likely answer, the order the search route ranks in as well.
  const selected = candidates.slice(Math.max(0, candidates.length - limit));
  const cache = vectorCache(cfg);
  const pending = [];
  let alreadyCached = 0;
  for (const candidate of selected) {
    if (await cache.get(candidate.text) !== null) alreadyCached += 1;
    else pending.push(candidate.text);
  }
  let embedded = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let stopped = "";
  if (apply && pending.length > 0) {
    // One batch at a time, writing as each returns.
    //
    // A single call over the whole pending set looked simpler and was wrong: the
    // vectors are only written AFTER it returns, so one stalled or refused batch
    // discarded every batch before it. Measured on a 76-event window against a
    // remote endpoint: one 65 s stall plus an HTTP 500 lost the entire pass. Per
    // batch, the work already paid for survives, and a re-run resumes from the
    // cache instead of starting over.
    for (let start = 0; start < pending.length; start += MAX_EMBED_BATCH) {
      const batch = pending.slice(start, start + MAX_EMBED_BATCH);
      let result;
      try {
        result = await embedTextsTolerant(cfg, batch);
        consecutiveFailures = 0;
      } catch (error) {
        // The endpoint refused the whole batch (auth, routing, a dead server).
        // Those texts stay uncached and are counted, not silently dropped. The
        // pass stops at the breaker rather than walking the window at this row's
        // long ceiling: nothing here is lost, because every earlier batch is
        // already on disk and a re-run resumes from the cache.
        failed += batch.length;
        consecutiveFailures += 1;
        if (consecutiveFailures >= BACKFILL_FAILURE_LIMIT) {
          stopped = "failures";
          break;
        }
        continue;
      }
      for (let index = 0; index < batch.length; index += 1) {
        const vector = result.vectors[index];
        if (vector === undefined) {
          failed += 1;
          continue;
        }
        // The cache file is the entire product of a backfill; a write that
        // silently vanished would report a pass that did not happen.
        await cache.set(batch[index], vector);
        embedded += 1;
      }
    }
  }
  const report = { scanned: selected.length, alreadyCached, embedded, failed, limit, applied: apply };
  return { report, text: renderEmbedBackfill(cfg, candidates.length, pending.length, report, cache.dir, stopped) };
}

/** Render one backfill report. */
function renderEmbedBackfill(cfg, windowSize, pending, report, dir, stopped = "") {
  const lines = [
    "lcm-embed backfill (" + (report.applied ? "apply" : "dry-run") + ")",
    "  model: " + cfg.model,
    "  cache: " + dir,
    "  candidates: " + windowSize + " hidden text(s)",
    "  scanned: " + report.scanned,
    "  already cached: " + report.alreadyCached
  ];
  if (report.applied) {
    lines.push("  embedded: " + report.embedded, "  failed: " + report.failed);
  } else {
    lines.push("  would embed: " + pending, "  note: preview only; no provider call was made");
  }
  lines.push("  limit: " + report.limit, "  applied: " + (report.applied ? "yes" : "no"));
  if (stopped === "failures") {
    lines.push(
      "  stopped: " + BACKFILL_FAILURE_LIMIT + " consecutive failed batch(es) — the endpoint is refusing these calls",
      "  resumed: nothing was lost; the embedded text(s) are cached, so re-running --apply continues from there"
    );
  }
  if (!report.applied && pending > 0) lines.push("  next: /lcm-embed backfill --apply  (embeds the " + pending + " pending text(s))");
  return lines.join("\n");
}

/**
 * Build the `lcm-embed` command definition (for tests and introspection).
 * @param resolved - validated config, vector settings spread in.
 * @returns a registry-ready CommandDefinition.
 */
function defineEmbedCommand(resolved, commandName = EMBED_NAME) {
  return {
    name: commandName,
    description: "Inspect and fill the vector cache for compacted events: status | backfill [--apply] [--limit N]",
    handler: async (invocation) => {
      const parsed = parseEmbedArgs(invocation.rawInput);
      if (parsed.error !== undefined) return { kind: "error", text: parsed.error };
      try {
        if (parsed.action === "status") return {
          kind: "success",
          text: await buildEmbedStatus(resolved, invocation.agent.session)
        };
        if (parsed.apply && !resolved.enabled) return {
          kind: "error",
          text: "lcm-embed: the vector layer is disabled (vectorEnabled: false) — enable it on the command-lcm-embed row, then retry --apply."
        };
        const result = await embedBackfill(invocation.agent.session, resolved, parsed);
        return { kind: "success", text: result.text };
      } catch (error) {
        return { kind: "error", text: error instanceof Error ? error.message : String(error) };
      }
    }
  };
}

export { Config, EMBED_USAGE, USAGE, apply, buildEmbedStatus, buildStatus, defineEmbedCommand, defineRecallCommand, defineStatusCommand, embedBackfill, inject, name, parseEmbedArgs, resolveConfig };
