/**
 * Keyword/regex search over the durable session log for `dsh-compaction-lcm`.
 *
 * The retrieval counterpart of compaction: the append-only session log is the
 * full transcript, so this module scans every event's projected content and
 * returns the matching events with their `(seq N)` pointers. An agent (or the
 * `/recall` command) can then call recall with any pointer to restore the exact
 * original tokens.
 *
 * Nothing is modified, nothing is elided — only the rendered hit lines are
 * bounded, by the shared `maxRecallTokens` budget and a per-hit line cap.
 *
 * @module dsh-compaction-lcm/search
 */
import { estimateEntryTokens, sanitize, truncateTokens } from "./compiler.js";
import { resolveEventAt } from "./events.js";
import { projectMessageText } from "./recall.js";

/** Default cap on the number of matching events shown in one result. */
export const DEFAULT_MAX_SEARCH_HITS = 50;
/** Default cap on shown matching lines per hit event. */
export const MAX_LINES_PER_HIT = 10;

/**
 * How one result set is ordered.
 *
 * `density` is the default because it won on production data: measured against
 * the anchors real summaries had dropped, length-normalised density beat plain
 * chronological order on recall@1 (0.71 vs 0.38), MRR (0.79 vs 0.58) and
 * NDCG@10 (0.83 vs 0.67), with recall@5 tied. An earlier measurement said the
 * opposite; that instrument had an off-by-one in the rank it recorded, and the
 * correction is recorded in bench/REPORT.md §14.
 */
export const RANK_MODES = Object.freeze(["seq", "score", "density"]);

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

/** One search hit: the durable seq, its kind, and the rendered matched lines. */
export function searchSession(session, patternSource, config) {
  const pattern = compileSearchPattern(patternSource);
  const maxHits = config.maxSearchHits;
  const maxTokens = config.maxRecallTokens;
  const rankMode = config.rank ?? "density";
  const events = session.events;
  const collected = [];
  let totalMatches = 0;
  let lastSeq = 0;
  for (let seq = 0; seq < events.length; seq += 1) {
    const event = resolveEventAt(session, seq);
    if (event === undefined || event.seq !== seq) continue;
    lastSeq = seq;
    const message = typeof session.deriveEventMessage === "function" ? session.deriveEventMessage(event) : null;
    const body = message !== null
      ? projectMessageText(message)
      : "[" + event.type + "]\n" + JSON.stringify(event.data ?? null);
    const lines = body.split("\n");
    const matched = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (pattern.test(lines[index])) matched.push({ line: index + 1, text: sanitize(lines[index]) });
    }
    if (matched.length === 0) continue;
    totalMatches += 1;
    collected.push({
      seq,
      kind: message !== null ? message.role : event.type,
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
  const hits = [];
  let budget = maxTokens;
  let truncated = false;
  for (const candidate of collected) {
    if (hits.length >= maxHits || budget <= 0) {
      truncated = true;
      continue;
    }
    const header = "[seq " + candidate.seq + ": " + candidate.kind + "]";
    const shown = candidate.matched.slice(0, MAX_LINES_PER_HIT);
    const more = candidate.matched.length - shown.length;
    const block = [
      header,
      ...shown.map((match) => "  " + match.line + ": " + match.text),
      ...(more > 0 ? ["  ...(" + more + " more matching lines in this event)"] : [])
    ].join("\n");
    const kept = truncateTokens(block, budget, "search budget");
    budget -= estimateEntryTokens(kept.text);
    if (kept.truncated) truncated = true;
    hits.push({ seq: candidate.seq, kind: candidate.kind, text: kept.text });
  }
  const omitted = totalMatches - hits.length;
  const lines = [
    '[search "' + pattern.source + '": ' + totalMatches + " matching event(s)]",
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
    tokens: hits.reduce((total, hit) => total + estimateEntryTokens(hit.text), 0),
    text
  };
}
