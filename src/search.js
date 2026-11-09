/**
 * Keyword/regex search over the durable session log for dsh-lcm.
 *
 * The retrieval counterpart of compaction: the append-only session log is the
 * full transcript, so this module scans every event's projected content and
 * returns the matching events with their (seq N) pointers. An agent (or the
 * /recall command) can then call recall with any pointer to restore the exact
 * original tokens.
 *
 * Nothing is modified, nothing is elided — only the rendered hit lines are
 * bounded, by the shared maxRecallTokens budget and a per-hit line cap.
 *
 * Two entry points share one collection step:
 *
 *   - searchSession — lexical only, synchronous, the default;
 *   - searchSessionHybrid — lexical, then optionally the semantic route from
 *     ./vectors.js (order changed, output shape unchanged). With
 *     vectorEnabled: false it *is* searchSession.
 *
 * @module dsh-lcm/search
 */
import { isSurfaceEligibleType } from "@deepseek-ai/dsh-session/surface";
import { estimateEntryTokens, renderEventBody, sanitize, truncateTokens } from "./compiler.js";
import { resolveEventAt, sessionEvents } from "./events.js";
import { RRF_K, VECTOR_TEXT_LIMIT, hybridRank, rankByVector, resolveVectorConfig } from "./vectors.js";

/** Default cap on the number of matching events shown in one result. */
export const DEFAULT_MAX_SEARCH_HITS = 50;
/** Default cap on shown matching lines per hit event. */
export const MAX_LINES_PER_HIT = 10;

/**
 * How one result set is ordered.
 *
 * density is the default because it won on production data: measured against
 * the anchors real summaries had dropped, length-normalised density beat plain
 * chronological order on recall@1 (0.71 vs 0.38), MRR (0.79 vs 0.58) and
 * NDCG@10 (0.83 vs 0.67), with recall@5 tied. An earlier measurement said the
 * opposite; that instrument had an off-by-one in the rank it recorded, and the
 * correction is recorded in bench/REPORT.md section 14.
 */
export const RANK_MODES = Object.freeze(["seq", "score", "density"]);

/**
 * Ranks that need the optional vector layer.
 *
 * Kept out of RANK_MODES on purpose: those three are pure lexical orderings
 * that searchSession implements synchronously, and folding an asynchronous
 * rank into that contract would make every caller pay for a feature it never
 * asked for.
 */
export const HYBRID_RANK_MODES = Object.freeze(["vector", "hybrid"]);

/** The lexical ordering the hybrid routes start from (the measured default). */
const LEXICAL_BASE_RANK = "density";

/** A search pattern that cannot be compiled into a regular expression. */
export class InvalidSearchPatternError extends Error {
  /**
   * @param source - the raw pattern the user supplied.
   * @param reason - the regex compiler's message.
   */
  constructor(source, reason) {
    super("invalid search pattern " + JSON.stringify(String(source)) + ": " + reason);
    this.source = String(source);
  }
}

/**
 * Compile one search pattern: case-insensitive, Unicode-aware, treated as a
 * regular expression (grep semantics) so keywords work as-is and regexes work
 * when escaped.
 * @param source - raw pattern text.
 * @returns the compiled pattern.
 * @throws InvalidSearchPatternError when empty or not compilable.
 */
export function compileSearchPattern(source) {
  const trimmed = String(source ?? "").trim();
  if (trimmed.length === 0) throw new InvalidSearchPatternError(source, "pattern is empty");
  try {
    return new RegExp(trimmed, "iu");
  } catch (error) {
    throw new InvalidSearchPatternError(source, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Score one candidate hit for relevance ranking.
 *
 * A seq-ordered scan is chronological, not relevant: an agent that remembers a
 * string wants the event that is *about* it, and the earliest mention is often
 * an incidental reference. Score ranks by match density first (more matching
 * lines in one event means the event is about the string), then by recency (a
 * later event is more likely to be the one still in play).
 * @param candidate - one collected hit.
 * @param lastSeq - highest seq seen, for recency normalisation.
 * @returns the ranking score.
 */
function scoreOf(candidate, lastSeq) {
  const recency = lastSeq > 0 ? candidate.seq / lastSeq : 0;
  return candidate.count * 1000 + recency;
}

/**
 * Length-normalised match density: how much of one event is about the match.
 *
 * Raw match count favours long dumps (a 500-line log matches everything many
 * times), which pushed the real answer down in measurement. Dividing by the
 * event's size asks a better question: which event is *mostly* about this?
 * @param candidate - one collected hit.
 * @param lastSeq - highest seq seen, for a small recency tiebreak.
 * @returns the ranking score.
 */
function densityOf(candidate, lastSeq) {
  const recency = lastSeq > 0 ? candidate.seq / lastSeq : 0;
  const size = Math.max(1, candidate.estimate);
  return (candidate.count * 1000) / size + recency * 0.001;
}

/**
 * Project one event into the text a search (or an embedding) sees.
 *
 * Both routes read the event through this, so a vector hit and a lexical hit
 * are hits on the same bytes: deriveEventMessage is the session's own
 * projection, and the raw-event fallback is the one lexical search always used.
 * @param session - session-shaped value.
 * @param event - one resolved event.
 * @returns the rendered body and the kind label shown in a hit header.
 */
function eventBody(session, event) {
  return renderEventBody(session, event);
}

/**
 * Collect and order the lexical hits for one pattern. Not exported: the hit
 * set is an internal step that both entry points share.
 * @param session - session-shaped value with events.
 * @param pattern - compiled search pattern.
 * @param rankMode - one of RANK_MODES; unknown values keep log order.
 * @returns the ordered candidates, the match population, and the last seq.
 */
function collectHits(session, pattern, rankMode) {
  const events = sessionEvents(session);
  const collected = [];
  let totalMatches = 0;
  let lastSeq = 0;
  for (let seq = 0; seq < events.length; seq += 1) {
    const event = resolveEventAt(session, seq);
    if (event === undefined || event.seq !== seq) continue;
    lastSeq = seq;
    const { body, kind } = eventBody(session, event);
    const lines = body.split("\n");
    const matched = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (pattern.test(lines[index])) matched.push({ line: index + 1, text: sanitize(lines[index]) });
    }
    if (matched.length === 0) continue;
    totalMatches += 1;
    collected.push({
      seq,
      kind,
      matched,
      count: matched.length,
      estimate: estimateEntryTokens(body)
    });
  }
  if (rankMode === "score") {
    collected.sort((a, b) => scoreOf(b, lastSeq) - scoreOf(a, lastSeq) || b.seq - a.seq);
  } else if (rankMode === "density") {
    collected.sort((a, b) => densityOf(b, lastSeq) - densityOf(a, lastSeq) || b.seq - a.seq);
  }
  return { collected, totalMatches, lastSeq };
}

/**
 * Render ordered candidates into hits under the shared hit and token budgets.
 * @param candidates - ordered candidates with seq, kind and matched lines.
 * @param maxHits - per-result hit cap.
 * @param maxTokens - per-result token budget.
 * @returns the rendered hits and whether anything was cut.
 */
function renderHits(candidates, maxHits, maxTokens) {
  const hits = [];
  let budget = maxTokens;
  let truncated = false;
  for (const candidate of candidates) {
    if (hits.length >= maxHits || budget <= 0) {
      truncated = true;
      continue;
    }
    const header = "[seq " + candidate.seq + ": " + candidate.kind + "]" + (candidate.headerSuffix ?? "");
    const shown = candidate.matched.slice(0, MAX_LINES_PER_HIT);
    const more = candidate.matched.length - shown.length;
    const block = [
      header,
      ...shown.map((match) => "  " + match.line + ": " + match.text),
      ...(more > 0 ? [candidate.moreNote ?? "  ...(" + more + " more matching lines in this event)"] : [])
    ].join("\n");
    const kept = truncateTokens(block, budget, "search budget");
    budget -= estimateEntryTokens(kept.text);
    if (kept.truncated) truncated = true;
    hits.push({ seq: candidate.seq, kind: candidate.kind, text: kept.text });
  }
  return { hits, truncated };
}

/** Total priced tokens of one hit set. */
function tokensOf(hits) {
  return hits.reduce((total, hit) => total + estimateEntryTokens(hit.text), 0);
}

/** Why a pattern that reads fine to a human still matches nothing. */
const ZERO_HIT_REASON = "a sentence, an adjacent phrase or an escaped metacharacter is one literal string here";

/** Shortest token worth suggesting as a standalone query. */
const HINT_MIN_TOKEN = 3;
/** Token boundaries for the suggestion; non-word characters never enter a hint. */
const HINT_TOKEN_SPLIT = /[^\p{L}\p{N}_]+/u;

/**
 * The one-line next step shown when a search matched nothing.
 *
 * A model's default move is to paste the question it was asked, and the log is
 * matched line by line as one literal phrase, so that move returns zero hits
 * (499 of LongMemEval_S's 500 questions, measured). The hint is advice only:
 * the pattern is never rewritten and never re-run behind the model's back, so a
 * result set stays a function of what was actually asked for.
 * @param patternSource - the raw pattern that matched nothing.
 * @returns one line naming the usual cause and two concrete alternatives.
 */
export function zeroHitHint(patternSource) {
  const source = String(patternSource ?? "");
  const words = [];
  for (const token of source.split(HINT_TOKEN_SPLIT)) {
    if (token.length >= HINT_MIN_TOKEN && !words.includes(token)) words.push(token);
  }
  // The longest tokens are the most distinctive, so they make the better example.
  const [first, second] = words.slice().sort((a, b) => b.length - a.length);
  // A pattern that already uses | needs no lesson about |.
  const either = second !== undefined && !source.includes("|")
    ? ' or either/or ("' + first + "|" + second + '")'
    : "";
  const retry = first === undefined
    ? ' Retry one distinctive word, or either/or ("timeout|ETIMEDOUT").'
    : ' Retry one distinctive word ("' + first + '")' + either + ".";
  return "[" + ZERO_HIT_REASON + "." + retry + "]";
}

/**
 * Search one session with the lexical ranking only.
 * @param session - session-shaped value with events.
 * @param patternSource - keyword or regular expression.
 * @param config - maxSearchHits, maxRecallTokens and rank.
 * @returns the ordered hit set and its rendered text.
 */
export function searchSession(session, patternSource, config) {
  const pattern = compileSearchPattern(patternSource);
  const maxHits = config.maxSearchHits;
  const maxTokens = config.maxRecallTokens;
  const rankMode = config.rank ?? "density";
  const { collected, totalMatches } = collectHits(session, pattern, rankMode);
  const { hits, truncated } = renderHits(collected, maxHits, maxTokens);
  const omitted = totalMatches - hits.length;
  const lines = [
    '[search "' + pattern.source + '": ' + totalMatches + " matching event(s)]",
    ...(totalMatches === 0 ? [zeroHitHint(pattern.source)] : []),
    ...hits.map((hit) => hit.text),
    ...(omitted > 0 ? ["[" + omitted + " more matching event(s) omitted — narrow the pattern or use recall]"] : []),
    ...(truncated ? ["[search budget exhausted; some hits were cut]"] : [])
  ];
  if (hits.length > 0) {
    lines.push("[use recall with a (seq N) pointer to restore any hit's full original content]");
  }
  const text = lines.join("\n\n");
  return {
    pattern: pattern.source,
    totalMatches,
    hits,
    omitted,
    truncated,
    rank: rankMode,
    tokens: tokensOf(hits),
    text
  };
}

/**
 * Search one session with the lexical ranking, plus the optional semantic one.
 *
 * rank decides the route, and only these values consult the vector layer:
 *
 *   - "vector" — rank the session's events by cosine similarity to the pattern
 *     text, which is read as a question rather than as a regex. There is no
 *     matching population on this route, so totalMatches is hits.length and the
 *     result carries mode: "vector" to make that unambiguous.
 *   - "hybrid" — the lexical ranking and the vector ranking fused with RRF, both
 *     routes keeping their own ranks. totalMatches keeps its lexical meaning
 *     (how many events matched the pattern) and mode: "hybrid" marks the order.
 *
 * Every other rank value, and every configuration with vectorEnabled: false,
 * delegates to searchSession unchanged: no request, no extra cost, and output
 * that is byte-for-byte the lexical result.
 *
 * An unreachable or failing backend never fails the call: the lexical result is
 * returned with a notice field and the same sentence appended to its text.
 *
 * @param session - session-shaped value with events.
 * @param patternSource - keyword, regex, or natural-language question.
 * @param config - maxSearchHits, maxRecallTokens, rank and the vector keys.
 * @param signal - optional caller abort signal for the embedding request.
 * @returns the shape searchSession returns, plus mode or notice when set.
 */
export async function searchSessionHybrid(session, patternSource, config, signal) {
  const rankMode = config.rank ?? "density";
  const vectorConfig = resolveVectorConfig(config);
  if (!vectorConfig.enabled || !HYBRID_RANK_MODES.includes(rankMode)) {
    // A mode that asked for vectors while the layer is off still gets a sane
    // lexical order rather than the unsorted log order an unknown rank yields.
    const lexicalRank = HYBRID_RANK_MODES.includes(rankMode) ? LEXICAL_BASE_RANK : rankMode;
    return searchSession(session, patternSource, { ...config, rank: lexicalRank });
  }
  const pattern = compileSearchPattern(patternSource);
  const lexical = collectHits(session, pattern, LEXICAL_BASE_RANK);
  const { items, tokens: candidateTokens, hidden } = collectVectorItems(session, {
    events: vectorConfig.candidateLimit,
    tokens: vectorConfig.candidateTokens
  });
  let ranked;
  try {
    // In vector mode every candidate is ranked and top-K is the answer; in
    // hybrid mode the vector route contributes its top-K ranks only.
    ranked = await rankByVector(vectorConfig, items, pattern.source, signal);
  } catch (error) {
    return degradeToLexical(session, patternSource, config, error);
  }
  const scores = new Map(ranked.map((entry) => [entry.seq, entry.score]));
  const lexicalBySeq = new Map(lexical.collected.map((candidate) => [candidate.seq, candidate]));
  const order = rankMode === "vector"
    ? ranked.map((entry) => entry.seq)
    : hybridRank(vectorConfig, lexical.collected, ranked, RRF_K).map((entry) => entry.seq);
  const candidates = [];
  for (const seq of order) {
    const suffix = scores.has(seq) ? " (cosine " + scores.get(seq).toFixed(3) + ")" : "";
    const known = lexicalBySeq.get(seq);
    if (known !== undefined) {
      candidates.push({ ...known, headerSuffix: suffix });
      continue;
    }
    const candidate = bodyHeadCandidate(session, seq);
    if (candidate !== null) candidates.push({ ...candidate, headerSuffix: suffix });
  }
  const { hits, truncated } = renderHits(candidates, config.maxSearchHits, config.maxRecallTokens);
  const tokens = tokensOf(hits);
  // What the window actually covered, stated as measured: the compacted region
  // when the session exposes a surface, plain candidates when it cannot.
  const scope = hidden === null
    ? items.length + " candidate event(s)"
    : items.length + " newest compacted event(s) of " + hidden;
  if (rankMode === "vector") {
    const lines = [
      '[vector "' + pattern.source + '": ' + hits.length + " event(s) by cosine similarity (top " + vectorConfig.topK + " of " + scope + ", " + candidateTokens + " tokens, seq >= " + (items[0]?.seq ?? "-") + ")]",
      ...(items.length === 0 ? ["[nothing is compacted yet — the session surface shows every event, so there is nothing for the semantic route to reach]"] : []),
      ...hits.map((hit) => hit.text),
      ...(truncated ? ["[search budget exhausted; some hits were cut]"] : [])
    ];
    if (hits.length > 0) {
      lines.push("[use recall with a (seq N) pointer to restore any hit's full original content]");
    }
    return {
      pattern: pattern.source,
      // No matching population exists on this route; the hits are the answer.
      totalMatches: hits.length,
      hits,
      omitted: 0,
      truncated,
      rank: rankMode,
      tokens,
      text: lines.join("\n\n"),
      mode: "vector"
    };
  }
  const shownLexical = hits.filter((hit) => lexicalBySeq.has(hit.seq)).length;
  const omitted = Math.max(0, lexical.totalMatches - shownLexical);
  const lines = [
    '[hybrid "' + pattern.source + '": ' + lexical.totalMatches + " lexical match(es) + " + ranked.length + " vector candidate(s) from the " + scope + " (" + candidateTokens + " tokens, seq >= " + (items[0]?.seq ?? "-") + "), RRF k=" + RRF_K + "]",
    ...hits.map((hit) => hit.text),
    ...(omitted > 0 ? ["[" + omitted + " more matching event(s) omitted — narrow the pattern or use recall]"] : []),
    ...(truncated ? ["[search budget exhausted; some hits were cut]"] : [])
  ];
  if (hits.length > 0) {
    lines.push("[use recall with a (seq N) pointer to restore any hit's full original content]");
  }
  return {
    pattern: pattern.source,
    totalMatches: lexical.totalMatches,
    hits,
    omitted,
    truncated,
    rank: rankMode,
    tokens,
    text: lines.join("\n\n"),
    mode: "hybrid"
  };
}

/**
 * The events the model cannot read without a tool call: surface-eligible content
 * the session surface no longer shows.
 *
 * That set, not recency, is what the semantic route is for. Events still on the
 * surface are in the context verbatim, so embedding them costs time to rank text
 * the model can already read — on a real 24013-event session 19800 of them were
 * still visible and only 4213 were compacted, so a newest-first window over the
 * whole log spent its entire budget on the visible half and left the compacted
 * half 1.6% covered.
 *
 * "Not visible" alone is not the set: most of the log never was visible. Only
 * the five message-producing types can join the surface (the harness's own fold,
 * {@link isSurfaceEligibleType}), and everything else — step/start, tool/call,
 * tool/ptc-dispatch, plugin:translator/request, job/*, turn/start — is plumbing.
 * Measured on the live 26265-event session: 25831 events sat outside the ~471
 * surface nodes but only 4207 of them were message-like; the newest 380
 * candidates were 100% plumbing, so the route embedded noise and its top hit was
 * a PTC dispatch record (cosine 0.718) above any real content.
 *
 * Within that set the order stays newest-first (recent-but-compacted is the more
 * likely answer), and the window is priced in estimated tokens rather than in
 * events, because the endpoint's cost tracks length: 32 texts at
 * 40/200/800/2000/4000 characters cost 27/33/60/119/230 ms per text, i.e.
 * roughly `18 ms per text + 0.23 ms per estimated token`. A count ceiling stays
 * alongside it for logs whose events are one-line turn markers.
 *
 * The residual loss is real and stated: compacted events older than the budget
 * remain unreachable by similarity, and only a lexical pattern reaches them.
 * `rank: "hybrid"` keeps those lexical hits in the answer.
 *
 * Exported because `/lcm-embed backfill` must warm EXACTLY the texts this route
 * later looks up. Two copies of this rule would drift — surface eligibility, the
 * visible-set skip, the token pricing and the 4 000-character slice all decide
 * which cache key is written — and a drifted copy would fill keys no search ever
 * reads, which looks like a working backfill and changes nothing.
 *
 * @param session - session-shaped value with events, optionally a surface.
 * @param bounds - `{ events, tokens }` ceilings (positive integers).
 * @returns `[{ seq, text }]` in log order, plus the priced window and the
 *   hidden-event count (`null` when the session exposes no surface).
 */
export function collectVectorItems(session, bounds) {
  const visible = visibleSeqs(session);
  const maxEvents = Number.isSafeInteger(bounds.events) ? bounds.events : Number.POSITIVE_INFINITY;
  const maxTokens = Number.isSafeInteger(bounds.tokens) ? bounds.tokens : Number.POSITIVE_INFINITY;
  const events = sessionEvents(session);
  const items = [];
  let tokens = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (items.length >= maxEvents || tokens >= maxTokens) break;
    const event = events[index];
    if (!Number.isSafeInteger(event?.seq)) continue;
    // Never on the surface in the first place, so never compacted content:
    // embedding log plumbing ranks records the model never read.
    if (!isSurfaceEligibleType(event.type)) continue;
    // Already in the model's context: ranking it would buy nothing.
    if (visible !== null && visible.has(event.seq)) continue;
    const { body } = eventBody(session, event);
    if (body.length === 0) continue;
    // Price the bytes that are actually embedded, not the whole event.
    const text = body.slice(0, VECTOR_TEXT_LIMIT);
    const cost = estimateEntryTokens(text);
    if (tokens + cost > maxTokens) break;
    tokens += cost;
    items.push({ seq: event.seq, text: body });
  }
  items.reverse();
  return { items, tokens, hidden: visible === null ? null : hiddenCount(events, visible) };
}

/**
 * How many surface-eligible events sit outside the surface (the compacted
 * region). Counted over the same set {@link collectVectorItems} draws from, so
 * the header's "of N" cannot claim plumbing as compacted content.
 */
function hiddenCount(events, visible) {
  let hidden = 0;
  for (const event of events) {
    if (!Number.isSafeInteger(event?.seq) || !isSurfaceEligibleType(event.type)) continue;
    if (!visible.has(event.seq)) hidden += 1;
  }
  return hidden;
}

/**
 * The seqs the session surface currently shows, or null when the value carries
 * no surface at all (a fixture or an older caller) — in which case every event
 * is treated as unread, so nothing is silently excluded.
 * @param session - session-shaped value.
 * @returns the visible seq set, or null.
 */
function visibleSeqs(session) {
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes)) return null;
  const visible = new Set();
  for (const node of nodes) {
    const seq = typeof node === "number" ? node : node?.seq;
    if (Number.isSafeInteger(seq)) visible.add(seq);
  }
  return visible;
}

/** A vector-only hit: the head of an event the pattern never matched. */
function bodyHeadCandidate(session, seq) {
  const event = resolveEventAt(session, seq);
  if (event === undefined) return null;
  const { body, kind } = eventBody(session, event);
  const lines = body.split("\n");
  const shown = Math.min(lines.length, MAX_LINES_PER_HIT);
  return {
    seq,
    kind,
    matched: lines.slice(0, shown).map((text, index) => ({ line: index + 1, text: sanitize(text) })),
    moreNote: lines.length > shown ? "  ...(" + (lines.length - shown) + " more line(s) in this event)" : undefined
  };
}

/** Return the lexical ranking unchanged, with one notice about the backend. */
function degradeToLexical(session, patternSource, config, error) {
  const reason = error instanceof Error ? error.message : String(error);
  const notice = "vector backend unreachable: " + reason + "; fell back to lexical";
  const result = searchSession(session, patternSource, { ...config, rank: LEXICAL_BASE_RANK });
  return { ...result, notice, text: result.text + "\n\n[" + notice + "]" };
}
