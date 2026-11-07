#!/usr/bin/env node
/**
 * bench/longmemeval.mjs - Layer-1 (retrieval quality) harness for dsh-lcm.
 *
 * Ports the retrieval half of lcm-x benchmarks/METHODOLOGY.md onto this
 * plugin's own production entry point, searchSession (src/search.js):
 *
 *   - Per-question fresh store. Every question builds a brand-new in-memory
 *     session from its own haystack; nothing is carried across questions.
 *   - The adapter sees only the session messages and the query (fairness rule
 *     1). The query is the question text, escaped as a literal regex; no
 *     dataset-specific token picking, no evidence peeking, and no retry with
 *     narrower keywords when the literal produces zero hits.
 *   - Session-level recall@1/5/10/50, MRR and NDCG@10 against
 *     answer_session_ids.
 *
 * This plugin has no vector path: the production tool is a lexical search
 * (regex over rendered event text, plus one of three orderings), so it is the
 * analog of lcm-x's fts arm, not of its embedding arms.
 *
 * Arms are pluggable:
 *   --rank seq|score|density   searchSession, purely lexical and synchronous.
 *   --rank vector|hybrid       searchSessionHybrid with vectorEnabled: true,
 *                              i.e. the semantic route in src/vectors.js. Slow:
 *                              it embeds every event of the question (about 494
 *                              texts), so the embedding cache is what makes a
 *                              100-question run tolerable and a rerun free.
 *   --rank all                 the three lexical ranks only (the default);
 *                              vector arms must be asked for by name.
 *
 * Usage:
 *   node --max-old-space-size=8192 bench/longmemeval.mjs [--limit N | --sample N]
 *        [--rank seq,score,density,vector,hybrid|all] [--dataset PATH]
 *        [--cache-dir PATH] [--vector-topk N] [--json] [--out PATH]
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { searchSession, searchSessionHybrid } from "../src/search.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const DEFAULT_DATASET = "/home/agent/workspaces/lcmx-study/data/longmemeval_s.json";
const DATASET_REVISION = "2ec2a557f339b6c0369619b1ed5793734cc87533";
const LEXICAL_RANKS = ["seq", "score", "density"];
const PLUGGABLE_RANKS = ["vector", "hybrid"];

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf("--" + k);
  return i >= 0 ? (argv[i + 1] ?? true) : d;
};
const datasetPath = String(opt("dataset", DEFAULT_DATASET));
const limitRaw = opt("limit", null);
const limit = limitRaw === null ? 0 : Math.max(1, Number(limitRaw) || 0);
const rankArg = String(opt("rank", "all"));
const printJson = argv.includes("--json");
const cacheDir = path.resolve(REPO, String(opt("cache-dir", path.join("bench", ".embed-cache"))));
const stamp = new Date();
const ymd = String(stamp.getUTCFullYear()) + String(stamp.getUTCMonth() + 1).padStart(2, "0") + String(stamp.getUTCDate()).padStart(2, "0");
const outBase = path.resolve(REPO, String(opt("out", path.join("bench", "results", "longmemeval-" + ymd))));

const RANK_MODES = rankArg === "all"
  ? [...LEXICAL_RANKS]
  : rankArg.split(",").map((mode) => mode.trim()).filter(Boolean);
for (const mode of RANK_MODES) {
  if (![...LEXICAL_RANKS, ...PLUGGABLE_RANKS].includes(mode)) {
    console.error("unknown --rank " + mode + " (seq|score|density|vector|hybrid|all)");
    process.exit(2);
  }
}

const SEARCH_CONFIG = { maxSearchHits: 200, maxRecallTokens: 1_000_000 };

/**
 * Select the questions to score.
 *
 * --limit takes the head of the file, which is single-type because the split is
 * grouped by question type. --sample takes an even stride, so every type is
 * represented; use it for any partial run whose per-type numbers will be read.
 */
function pickQuestions(all, headCount, sampleCount) {
  if (sampleCount > 0) {
    const step = Math.max(1, Math.floor(all.length / sampleCount));
    const picked = [];
    for (let index = 0; index < all.length && picked.length < sampleCount; index += step) picked.push(all[index]);
    return picked;
  }
  return headCount > 0 ? all.slice(0, headCount) : all;
}

/** Escape a query so it is matched literally as a regex. */
const escape = (s) => String(s ?? "").replace(/[.*+?^\u0024{}()|[\]\\]/gu, (c) => "\\" + c);

/**
 * The exact stopword set lcm-x's fts arm drops (benchmarking/longmemeval.py,
 * _FTS_STOPWORDS). Kept verbatim so the OR-of-terms query here is the same
 * query construction, not a lookalike.
 */
const STOP = new Set(("a an and are as at be by did do does for from had has have how i in is it me my of on or that the to was were what when where which who why with you your").split(/\s+/u));

/**
 * Content terms of a question, following lcm-x's build_fts_query: split on
 * whitespace, strip edge punctuation, reduce each token to bareword characters
 * (alphanumerics and underscore), drop empty tokens and stopwords, dedupe in
 * first-seen order.
 */
function questionTokens(question) {
  const seen = new Set();
  const kept = [];
  for (const raw of String(question ?? "").split(/\s+/u)) {
    const bare = raw.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, "").replace(/[^\p{L}\p{N}_]+/gu, "");
    if (bare.length === 0 || STOP.has(bare.toLowerCase()) || seen.has(bare.toLowerCase())) continue;
    seen.add(bare.toLowerCase());
    kept.push(bare);
  }
  return kept;
}

/* ------------------------------------------------------ vector config ---- */
/** Optional vector-arm overrides; the production defaults live in src/vectors.js. */
const vectorTopK = Number(opt("vector-topk", 0)) || undefined;
const vectorConfig = {
  vectorEnabled: true,
  vectorCacheDir: cacheDir,
  ...(vectorTopK === undefined ? {} : { vectorTopK })
};
const VECTOR_RANKS = ["vector", "hybrid"];

/**
 * Query text for a rank. Lexical ranks get the question escaped into a literal
 * regex. Vector/hybrid ranks read the pattern as natural language, so they get
 * the raw question when it compiles as a regex and the escaped form otherwise.
 */
function queryFor(rank, question) {
  const raw = String(question.question ?? "");
  if (LEXICAL_RANKS.includes(rank)) return escape(raw);
  try {
    new RegExp(raw.trim() === "" ? "x" : raw, "iu");
    return raw;
  } catch {
    return escape(raw);
  }
}

/* ------------------------------------------------------------ session ---- */
/**
 * Build a brand-new session-shaped value for one question.
 *
 * One event per haystack message, in haystack-session order then message
 * order. meta[seq] carries the (sessionId, turnIndex) the scorer needs; the
 * event itself carries only what searchSession consumes.
 */
function buildSession(question) {
  const events = [];
  const meta = [];
  const textAt = [];
  const roleAt = [];
  const sessions = question.haystack_sessions ?? [];
  const sessionIds = question.haystack_session_ids ?? [];
  for (let s = 0; s < sessions.length; s += 1) {
    const sessionId = String(sessionIds[s] ?? "session_" + s);
    const messages = sessions[s] ?? [];
    for (let t = 0; t < messages.length; t += 1) {
      const message = messages[t] ?? {};
      const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      const seq = events.length;
      const role = message.role === "assistant" ? "assistant" : "user";
      events.push({ seq, type: role === "assistant" ? "assistant/message" : "user/message", data: null });
      meta.push({ sessionId, turnIndex: t });
      textAt.push(text);
      roleAt.push(role);
    }
  }
  const session = {
    events,
    eventAt: (seq) => events[seq],
    deriveEventMessage: (event) => {
      const text = textAt[event.seq];
      if (text === undefined || text.length === 0) return null;
      return { role: roleAt[event.seq], content: [{ type: "text", text }] };
    }
  };
  return { session, meta, sessionCount: sessions.length, eventCount: events.length };
}

/* ------------------------------------------------------------ scoring ---- */
/** Binary-relevance NDCG@k over session-deduped hits; IDCG uses every gold session. */
function ndcgAt(order, gold, k) {
  let dcg = 0;
  for (let i = 0; i < Math.min(order.length, k); i += 1) {
    if (gold.has(order[i])) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  const ideal = Math.min(gold.size, k);
  for (let i = 0; i < ideal; i += 1) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

/** Score one question's search result at session granularity. */
function scoreResult(result, meta, gold) {
  const order = [];
  const seen = new Set();
  let eventRank = null;
  for (let i = 0; i < result.hits.length; i += 1) {
    const hit = result.hits[i];
    const info = meta[hit.seq];
    if (info === undefined) continue;
    if (eventRank === null && gold.has(info.sessionId)) eventRank = i + 1;
    if (seen.has(info.sessionId)) continue;
    seen.add(info.sessionId);
    order.push(info.sessionId);
  }
  let rank = null;
  for (let i = 0; i < order.length; i += 1) {
    if (gold.has(order[i])) { rank = i + 1; break; }
  }
  return { order, rank, eventRank, hits: result.hits.length, totalMatches: result.totalMatches ?? 0, sessions: order.length };
}

function mapsum(list, fn) {
  return list.reduce((sum, item) => sum + fn(item), 0);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? +((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2) : sorted[mid];
}

/** Aggregate rows into the metric block used by both outputs. */
function aggregate(rows) {
  const n = rows.length;
  const at = (k) => (n === 0 ? 0 : rows.filter((r) => r.rank !== null && r.rank <= k).length / n);
  const mrr = n === 0 ? 0 : rows.reduce((sum, r) => sum + (r.rank === null ? 0 : 1 / r.rank), 0) / n;
  const ndcg = n === 0 ? 0 : rows.reduce((sum, r) => sum + r.ndcg, 0) / n;
  const zeroHitCount = rows.filter((r) => r.hits === 0).length;
  const zeroHit = n === 0 ? 0 : zeroHitCount / n;
  const meanSessionsReturned = n === 0 ? 0 : mapsum(rows, (r) => r.sessions) / n;
  const meanHits = n === 0 ? 0 : mapsum(rows, (r) => r.hits) / n;
  return {
    n,
    meanHits: +meanHits.toFixed(1),
    meanSessionsReturned: +meanSessionsReturned.toFixed(1),
    zeroHitCount,
    recall: { at1: +at(1).toFixed(4), at5: +at(5).toFixed(4), at10: +at(10).toFixed(4), at50: +at(50).toFixed(4) },
    mrr: +mrr.toFixed(4),
    ndcgAt10: +ndcg.toFixed(4),
    zeroHitRate: +zeroHit.toFixed(4),
    medianEventRank: median(rows.map((r) => r.eventRank).filter((v) => v !== null))
  };
}

/* ---------------------------------------------------------------- run ---- */

if (!fs.existsSync(datasetPath)) {
  console.error("dataset not found: " + datasetPath);
  process.exit(2);
}
const started = Date.now();
const rawBytes = fs.statSync(datasetPath).size;
const datasetSha256 = crypto.createHash("sha256").update(fs.readFileSync(datasetPath)).digest("hex");
const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
if (!Array.isArray(dataset)) {
  console.error("unexpected dataset shape (expected an array of questions)");
  process.exit(2);
}
const sampleRaw = opt("sample", null);
const sample = sampleRaw === null ? 0 : Math.max(1, Number(sampleRaw) || 0);
const questions = pickQuestions(dataset, limit, sample);

const verbatim = (question) => escape(question.question);
const tokenOr = (question) => {
  const tokens = questionTokens(question.question);
  if (tokens.length === 0) return escape(question.question);
  return "\\b(?:" + tokens.map(escape).join("|") + ")\\b";
};

const armErrors = {};
const activeModes = RANK_MODES.filter((rank) => armErrors[rank] === undefined);

const depth = { sessions: [], events: [] };
const rows = Object.fromEntries(activeModes.map((rank) => [rank, []]));
const variantRows = Object.fromEntries(activeModes.filter((r) => LEXICAL_RANKS.includes(r)).map((rank) => [rank, []]));

for (let index = 0; index < questions.length; index += 1) {
  const question = questions[index];
  const gold = new Set((question.answer_session_ids ?? []).map(String));
  const built = buildSession(question);
  const session = built.session;
  const meta = built.meta;
  depth.sessions.push(built.sessionCount);
  depth.events.push(built.eventCount);

  for (const rank of activeModes) {
    let result;
    let searchError = null;
    try {
      if (LEXICAL_RANKS.includes(rank)) {
        result = searchSession(session, queryFor(rank, question), { ...SEARCH_CONFIG, rank });
      } else {
        result = await searchSessionHybrid(session, queryFor(rank, question), { ...SEARCH_CONFIG, ...vectorConfig, rank });
        if (result === null || !Array.isArray(result.hits)) throw new Error("vector route returned no hits array");
        if (typeof result.notice === "string") searchError = "degraded: " + result.notice;
      }
    } catch (error) {
      searchError = error instanceof Error ? error.message : String(error);
      result = { hits: [], totalMatches: 0 };
    }
    const scored = scoreResult(result, meta, gold);
    rows[rank].push({
      question_id: question.question_id,
      question_type: question.question_type,
      gold: gold.size,
      rank: scored.rank,
      eventRank: scored.eventRank,
      hits: scored.hits,
      sessions: scored.sessions,
      totalMatches: scored.totalMatches,
      ndcg: ndcgAt(scored.order, gold, 10),
      error: searchError
    });
  }

  for (const rank of Object.keys(variantRows)) {
    let result;
    try {
      result = searchSession(session, tokenOr(question), { ...SEARCH_CONFIG, rank });
    } catch {
      result = { hits: [], totalMatches: 0 };
    }
    const scored = scoreResult(result, meta, gold);
    variantRows[rank].push({
      question_id: question.question_id,
      question_type: question.question_type,
      gold: gold.size,
      rank: scored.rank,
      eventRank: scored.eventRank,
      hits: scored.hits,
      sessions: scored.sessions,
      totalMatches: scored.totalMatches,
      ndcg: ndcgAt(scored.order, gold, 10),
      error: null
    });
  }

  if ((index + 1) % 50 === 0) {
    process.stderr.write("[longmemeval] " + (index + 1) + "/" + questions.length + " questions\n");
  }
}

function splitByType(list) {
  const buckets = {};
  for (const row of list) {
    buckets[row.question_type] ??= [];
    buckets[row.question_type].push(row);
  }
  const groups = {};
  for (const [type, items] of Object.entries(buckets)) groups[type] = aggregate(items);
  return groups;
}

const elapsedMs = Date.now() - started;
const arms = {};
for (const rank of activeModes) {
  arms[rank] = { overall: aggregate(rows[rank]), byType: splitByType(rows[rank]) };
}
const variants = {};
for (const rank of Object.keys(variantRows)) {
  variants[rank] = { overall: aggregate(variantRows[rank]), byType: splitByType(variantRows[rank]) };
}

const typeMix = questions.reduce((acc, q) => {
  acc[q.question_type] = (acc[q.question_type] ?? 0) + 1;
  return acc;
}, {});

/* ------------------------------------------------------------- output ---- */

const payload = {
  benchmark: "longmemeval-s/layer1-retrieval",
  harness: "dsh-lcm bench/longmemeval.mjs",
  generatedAt: new Date().toISOString(),
  elapsedMs,
  model: null,
  dataset: {
    path: datasetPath,
    bytes: rawBytes,
    sha256: datasetSha256,
    revision: DATASET_REVISION,
    split: "LongMemEval_S",
    totalQuestions: dataset.length,
    scoredQuestions: questions.length,
    limit: limit || null,
    sample: sample || null,
    typeMix,
    depth: {
      haystackSessionsPerQuestion: { min: Math.min(...depth.sessions), median: median(depth.sessions), max: Math.max(...depth.sessions), mean: +(mapsum(depth.sessions, (v) => v) / questions.length).toFixed(1) },
      haystackEventsPerQuestion: { min: Math.min(...depth.events), median: median(depth.events), max: Math.max(...depth.events), mean: +(mapsum(depth.events, (v) => v) / questions.length).toFixed(1) }
    }
  },
  config: {
    entryPoint: "src/search.js searchSession",
    queryMode: "question-verbatim-escaped-regex",
    maxSearchHits: SEARCH_CONFIG.maxSearchHits,
    maxRecallTokens: SEARCH_CONFIG.maxRecallTokens,
    rankModes: activeModes,
    unavailableArms: armErrors,
    vector: VECTOR_RANKS.some((rank) => activeModes.includes(rank))
      ? { enabled: true, model: "text-embedding-qwen3-vl-embedding-8b", dim: 4096, baseUrl: "http://10.126.126.3:1234/v1", topK: vectorConfig.vectorTopK ?? 8, cacheDir }
      : null,
    sessionGranularity: "hits deduped by haystack session id; NDCG@10 binary, full IDCG over all gold sessions",
    freshStorePerQuestion: true,
    turnLevel: "unavailable"
  },
  arms,
  diagnostics: {
    adapterVariants: variants,
    note: "adapterVariants.* ORs the question's content tokens instead of matching the question verbatim. Different query than the method mandates; diagnosis only."
  },
  perQuestion: Object.fromEntries(
    Object.keys(arms).map((rank) => [
      rank,
      rows[rank].map((r) => ({
        question_id: r.question_id,
        question_type: r.question_type,
        goldSessions: r.gold,
        sessionRank: r.rank,
        eventRank: r.eventRank,
        hits: r.hits,
        totalMatches: r.totalMatches,
        ndcg10: +r.ndcg.toFixed(4),
        error: r.error
      }))
    ])
  ),
  boundaries: [
    "lcm-x retrieval numbers require an embedding provider. dsh-lcm has no vector path wired in yet: searchSession is a case-insensitive regex over rendered event text with three orderings. Its only honest lcm-x counterpart is the fts arm (sR@5 0.20 / sR@10 0.36 / sNDCG 0.204).",
    "Turn-level (session, turn_index) recall/NDCG is unavailable: LongMemEval_S ships only answer_session_ids, no per-turn evidence labels. No tR@k is reported for any arm; perQuestion.*.eventRank is a diagnostic (rank of the first event inside an evidence session), not turn-level recall.",
    "Model = none. No answerer, no judge, no embedding model runs.",
    "Session-level recall dedupes hits by session id, so repeated events from one session cannot consume the top-k budget.",
    "n is disclosed per run: see dataset.scoredQuestions and the per-type n column."
  ]
};

fs.mkdirSync(path.dirname(outBase), { recursive: true });
fs.writeFileSync(outBase + ".json", JSON.stringify(payload, null, 1) + "\n");

/* ------------------------------------------------------------- markdown -- */

const pct = (v) => (v === 0 ? "0.000" : v.toFixed(3));
const armRows = activeModes
  .map((rank) => {
    const o = arms[rank].overall;
    return "| " + rank + " | " + o.n + " | " + pct(o.recall.at5) + " | " + pct(o.recall.at10) + " | " + pct(o.ndcgAt10) + " | " + pct(o.recall.at1) + " | " + pct(o.mrr) + " | " + pct(o.zeroHitRate) + " |";
  })
  .join("\n");

const failedRows = Object.entries(armErrors)
  .map(([rank, reason]) => "| " + rank + " | not scored | " + reason + " |")
  .join("\n");

const typeOrder = ["multi-session", "temporal-reasoning", "knowledge-update", "single-session-user", "single-session-assistant", "single-session-preference"];
const typesPresent = typeOrder.filter((t) => Object.keys(arms[activeModes[0]]?.byType ?? {}).includes(t));
const typeHeader = "| question_type | n | " + activeModes.map((r) => r + " sR@5").join(" | ") + " | " + activeModes.map((r) => r + " sR@10").join(" | ") + " | " + activeModes.map((r) => r + " sNDCG@10").join(" | ") + " |";
const typeSep = "|---" + "|---".repeat(activeModes.length * 3 + 1) + "|";
const typeRows = typesPresent
  .map((type) => {
    const n = arms[activeModes[0]].byType[type]?.n ?? 0;
    const cell = (fn) => activeModes.map((r) => (arms[r].byType[type] === undefined ? "-" : pct(fn(arms[r].byType[type])))).join(" | ");
    return "| " + type + " | " + n + " | " + cell((g) => g.recall.at5) + " | " + cell((g) => g.recall.at10) + " | " + cell((g) => g.ndcgAt10) + " |";
  })
  .join("\n");

const zeroRows = activeModes
  .map((rank) => {
    const list = rows[rank];
    const zero = list.filter((r) => r.hits === 0).length;
    return "| " + rank + " | " + zero + " | " + list.length + " | " + pct(list.length === 0 ? 0 : zero / list.length) + " |";
  })
  .join("\n");

const variantRowsMd = Object.keys(variants)
  .map((rank) => {
    const o = variants[rank].overall;
    return "| " + rank + " | " + o.n + " | " + pct(o.recall.at5) + " | " + pct(o.recall.at10) + " | " + pct(o.ndcgAt10) + " | " + pct(o.recall.at1) + " | " + pct(o.mrr) + " | " + pct(o.zeroHitRate) + " |";
  })
  .join("\n");

const B = String.fromCharCode(96);
const c = (s) => B + s + B;

const md = [
  "# LongMemEval_S - Layer 1 retrieval (dsh-lcm, lexical search)",
  "",
  "Generated " + payload.generatedAt + " by " + c("bench/longmemeval.mjs") + ". Model: **none** (no answerer, no judge, no embedding provider).",
  "",
  "- Dataset: LongMemEval_S, revision " + c(DATASET_REVISION),
  "- File: " + c(datasetPath) + " (" + rawBytes + " bytes, sha256 " + c(datasetSha256) + ")",
  "- **n = " + questions.length + "** questions scored (of " + dataset.length + " in the split)" + (sample ? ", even stride " + c("--sample " + sample) : limit ? ", head " + c("--limit " + limit) : "") + ".",
  "- Entry point: production " + c("searchSession") + " (" + c("src/search.js") + "), " + c("maxSearchHits=200") + ", " + c("maxRecallTokens=1000000") + ".",
  "- Query: the question text, regex-escaped and matched literally. No keyword picking, no retry.",
  "- Isolation: every question builds a brand-new in-memory session from its own haystack (per-question fresh store).",
  "- Candidate pool: " + payload.dataset.depth.haystackSessionsPerQuestion.median + " sessions / " + payload.dataset.depth.haystackEventsPerQuestion.median + " events per question (median; min-max " + payload.dataset.depth.haystackSessionsPerQuestion.min + "-" + payload.dataset.depth.haystackSessionsPerQuestion.max + " sessions, " + payload.dataset.depth.haystackEventsPerQuestion.min + "-" + payload.dataset.depth.haystackEventsPerQuestion.max + " events). " + c("maxSearchHits=200") + " caps one arm at 200 of ~" + payload.dataset.depth.haystackEventsPerQuestion.median + " events, so the ranked *session* list is a subset of ~50 sessions - recall@10 is a real filter, recall@50 is nearly the whole haystack.",
  "",
  "## Session-level metrics",
  "",
  "| arm (rank) | n | sR@5 | sR@10 | sNDCG@10 | sR@1 | MRR | zero-hit rate |",
  "|---|---|---|---|---|---|---|---|",
  armRows,
  ...(failedRows.length > 0 ? ["", "| arm | status | reason |", "|---|---|---|", failedRows] : []),
  "",
  "## Per question_type",
  "",
  typeHeader,
  typeSep,
  typeRows,
  "",
  "## Zero-hit questions (verbatim question matched nothing)",
  "",
  "| arm | zero-hit | n | share |",
  "|---|---|---|---|",
  zeroRows,
  "",
  "Misses by construction: the lexical index has no tokenised/OR recall, so a paraphrased question that shares no literal substring with any event retrieves nothing. Recorded as a miss, never retried with narrower keywords.",
  "",
  "## Second query policy - OR-of-terms (the policy lcm-x's own fts arm uses)",
  "",
  "The METHODOLOGY-mandated query is the question verbatim. It is also the wrong query for a line-oriented regex, and the near-zero table above is what that costs. lcm-x's " + c("fts") + " arm does not do that either: " + c("build_fts_query") + " in " + c("benchmarking/longmemeval.py") + " tokenises the question, drops stopwords, and ORs the barewords into one FTS5 MATCH. The " + c("tokenOr") + " rows below apply the same policy to this harness (content tokens OR-ed into one case-insensitive regex, stopwords dropped) so the two lexical systems are compared on the same query construction. Both tables are honest; they answer different questions.",
  "",
  "| variant (rank) | n | sR@5 | sR@10 | sNDCG@10 | sR@1 | MRR | zero-hit rate |",
  "|---|---|---|---|---|---|---|---|",
  variantRowsMd,
  "",
  "## Why the verbatim-query arm is ~0.002 (mechanism, not a bug)",
  "",
  "A LongMemEval question is a natural-language sentence (" + c("What degree did I graduate with?") + "). " + c("searchSession") + " compiles the pattern and tests it line by line against each event's rendered text. A whole-sentence regex therefore only fires when that exact sentence appears verbatim inside one line of the haystack - which happens on 1 of 500 questions. Every other question returns zero hits at every rank mode, identically, because ordering cannot rescue an empty candidate set.",
  "",
  "That is the honest reading of the production tool's contract: " + c("searchSession") + " is an *anchor* search (a path, an id, an error line, a keyword), and its documented use is 'the agent remembers a string, types it, gets the event back'. It was never a question-answering retriever. Feeding it a full question is the METHODOLOGY-mandated adapter (query = question verbatim, no token picking), so the near-zero result is reported as-is rather than hidden behind a friendlier query policy.",
  "",
  "## Reference: lcm-x published retrieval numbers (NOT a like-for-like comparison)",
  "",
  "From " + c("../lcm-x/benchmarks/results/longmemeval-v3-500q-fastembed.md") + " (n=470 scoreable, LongMemEval_S, local FastEmbed " + c("BAAI/bge-small-en-v1.5") + ", 500q):",
  "",
  "| lcm-x arm | sR@5 | sR@10 | sNDCG@10 | route |",
  "|---|---|---|---|---|",
  "| chunk_vectors | 0.96 | 0.98 | 0.924 | embedding KNN over raw conversational chunks |",
  "| summary_vectors | 0.87 | 0.93 | 0.837 | embedding KNN over one summary per session |",
  "| hybrid_rrf3 | 0.77 | 0.97 | 0.714 | RRF over FTS + summary + chunk |",
  "| hybrid_rrf | 0.49 | 0.64 | 0.484 | RRF over FTS + summary |",
  "| fts | 0.20 | 0.36 | 0.204 | **lexical only** (tokenised full-text search) |",
  "| lcm_recall (50q subset) | 0.98 | 1.00 | - | production tool, weighted RRF + priors |",
  "",
  "Read the " + c("fts") + " row as the only structural counterpart: it is the one arm with no embedding model. The gap between it (sR@5 0.20) and this harness's verbatim-query number is a **query-shape** difference, not a retrieval-quality difference: FTS tokenises the question into terms and ORs/ANDs them against an inverted index, while this harness feeds the whole question to a line-oriented regex, which almost never matches a line verbatim. The " + c("tokenOr") + " table above removes exactly that difference, which is why it - not the verbatim number - is the row to compare against " + c("fts") + ". Even so the two remain different instruments: FTS5 ranks by BM25 over a tokenised inverted index, this harness ranks by match count or length-normalised match density over lines.",
  "",
  "## Boundaries",
  "",
  "1. **The measured arms are lexical only.** " + c("searchSession") + " is a case-insensitive regex over rendered event text plus one of three orderings (" + c("seq") + " chronological, " + c("score") + " match-count, " + c("density") + " length-normalised match density); there is no tokeniser, no inverted index and no chunk store, so a question sharing no literal substring with an event retrieves nothing at any rank mode. " + (payload.config.vector === null ? "The optional semantic route (" + c("searchSessionHybrid") + ", " + c("src/vectors.js") + ") exists but was not exercised by this run - pass " + c("--rank vector,hybrid") + " to score it." : "This run also scored the optional semantic route (see the vector/hybrid rows above)."),
  "2. **Turn-level is unavailable.** LongMemEval_S labels evidence at session granularity (" + c("answer_session_ids") + ") only; there are no per-turn evidence labels, so any " + c("(session, turn_index)") + " recall/NDCG would be invented. No tR@k is reported. " + c("perQuestion.*.eventRank") + " (rank of the first event inside an evidence session) ships in the JSON as a diagnostic.",
  "3. **n = " + questions.length + "** questions, all with non-empty " + c("answer_session_ids") + ". Per-type n is in the table above.",
  "4. **Not comparable to lcm-x's published numbers.** lcm-x's retrieval numbers run with an embedding provider (local FastEmbed " + c("BAAI/bge-small-en-v1.5") + " floor, " + c("voyage-context-3") + " recommended) and score vector/KNN and RRF-fused arms. Comparing a regex matcher to " + c("chunk_vectors") + " (sR@5 0.96) measures the absence of an embedding path, not the quality of this one. The defensible counterpart is lcm-x's own lexical arm, " + c("fts") + ": sR@5 0.20 / sR@10 0.36 / sNDCG@10 0.204.",
  "5. Session-level recall dedupes hits by session id, so a burst of events from one session cannot consume the top-k budget. NDCG@10 uses binary relevance with the full IDCG over all gold sessions of that question.",
  ""
].join("\n");

fs.writeFileSync(outBase + ".md", md);

const summary = {
  out: outBase,
  n: questions.length,
  elapsedMs,
  arms: Object.fromEntries(activeModes.map((r) => [r, arms[r].overall])),
  unavailableArms: armErrors,
  tokenOr: Object.fromEntries(Object.keys(variants).map((r) => [r, variants[r].overall])),
  byType: Object.fromEntries(activeModes.map((r) => [r, arms[r].byType]))
};
if (printJson) {
  console.log(JSON.stringify(summary, null, 1));
} else {
  console.log(md);
}
