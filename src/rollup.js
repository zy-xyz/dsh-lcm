/**
 * Temporal rollups — lcm-x's `temporal_rollups_enabled`, on by default.
 *
 * A rollup answers a question the checkpoint DAG cannot: "what happened on the
 * 11th". A leaf checkpoint is a view over a SPAN of the log, and its seq range
 * says nothing about when the work happened; a rollup is a view over a TIME
 * SLICE, built from every checkpoint that landed inside it.
 *
 * The reference stores these in SQLite (`lcm_rollups`: period_kind, period_start,
 * scope, summary, status, source_fingerprint, lease) and rebuilds a period when
 * its source fingerprint changes. There is no database here, so the store is a
 * JSONL sidecar per session — durable, and outside the session log for the reason
 * that matters: a rollup committed AS a session event would become a surface node
 * and be compacted again, which is a loop that grows the thing it is supposed to
 * compress. One record per period, rewritten in place: see {@link appendRollup}.
 *
 * Only day periods are built. lcm-x also has week and month aggregates
 * (`lcm_rollup_sources` feeds them), and they exist to keep a year of history
 * queryable in one call. This engine has `lcm_search` over the whole log, so the
 * aggregate layer would be a second index answering what the first already does.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { estimateEntryTokens } from "./compiler.js";

/** How many rollups one maintenance pass may build. lcm-x ships 2. */
const DEFAULT_ROLLUP_BUILDS_PER_PASS = 2;
/** Wall-clock budget for one maintenance pass. lcm-x ships 5 000 ms. */
const DEFAULT_ROLLUP_BUDGET_MS = 5000;
/** Target size of one day rollup. lcm-x ships 5 000. */
const DEFAULT_ROLLUP_TARGET_TOKENS = 5000;
/** Hard bound on one day rollup. lcm-x ships 15 000. */
const DEFAULT_ROLLUP_MAX_TOKENS = 15000;

/** The one period kind this engine builds. */
const PERIOD_KIND = "day";

/**
 * The UTC day an event belongs to.
 * @param time - milliseconds since the epoch, as the session log records it.
 * @returns `YYYY-MM-DD`.
 */
export function utcDay(time) {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * Digest of the checkpoints a rollup covers.
 *
 * Changes when the covered set changes, which is the only thing that makes a
 * stored rollup stale. Seq alone is not enough: a checkpoint can be replaced by a
 * deeper one on the same seqs, and the rollup would then describe text that no
 * longer exists at that address.
 * @param entries - `[{ seq, tokens }]` for the day.
 * @returns a hex digest.
 */
export function rollupFingerprint(entries) {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(String(entry.seq) + ":" + String(entry.tokens) + "\u0000");
  }
  return hash.digest("hex");
}

/**
 * Group the log's checkpoints by UTC day.
 *
 * Only `compaction/summary` events count: they are the durable record of what was
 * summarised and when. A rollup built from raw messages instead would duplicate
 * the leaf layer and cost as much as compaction itself.
 * @param events - the session's event list.
 * @returns `[{ periodStart, entries, tokens }]`, oldest day first.
 */
export function planDayRollups(events) {
  const byDay = new Map();
  for (const event of events) {
    if (event?.type !== "compaction/summary") continue;
    if (!Number.isSafeInteger(event.seq) || typeof event.time !== "number") continue;
    const day = utcDay(event.time);
    const body = (event.data?.summary ?? []).map((block) => block.text ?? "").join("");
    const tokens = estimateEntryTokens(body);
    if (tokens <= 0) continue;
    const bucket = byDay.get(day);
    if (bucket === undefined) byDay.set(day, [{ seq: event.seq, tokens }]);
    else bucket.push({ seq: event.seq, tokens });
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([periodStart, entries]) => ({
      periodKind: PERIOD_KIND,
      periodStart,
      entries,
      tokens: entries.reduce((total, entry) => total + entry.tokens, 0)
    }));
}

/** @param dir - the rollup directory. @param sessionId - one file per session. */
function rollupPath(dir, sessionId) {
  return path.join(dir, String(sessionId).replace(/[^\w.-]/gu, "_") + ".jsonl");
}

/**
 * Read the rollups already stored for a session.
 *
 * A malformed line is skipped rather than fatal: this file is derived data, and a
 * truncated last line after a crash must not stop the next pass from building.
 * @param dir - the rollup directory.
 * @param sessionId - the session whose file to read.
 * @returns `[{ periodKind, periodStart, fingerprint, tokens }]`.
 */
export function readRollups(dir, sessionId) {
  const file = rollupPath(dir, sessionId);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const latest = new Map();
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record?.periodStart !== "string" || typeof record?.fingerprint !== "string") continue;
    // Last write wins: the file is append-only, so a rebuild appends rather than
    // rewriting, and the newest record for a period is the current one.
    latest.set(record.periodStart, record);
  }
  return [...latest.values()];
}

/**
 * Write one built rollup, replacing any earlier body for the same period.
 *
 * Append-only was wrong and the first real run proved it: the same day was written
 * twice (17:16:45 with 1 330 tokens, 17:17:24 with 2 652) and BOTH bodies stayed in
 * the file. `readRollups` kept the last, so the reader was right and the file was
 * not — the superseded 1 330-token body was dead weight nobody would ever see.
 *
 * Rewriting the file keeps one record per period, which is what the format claims
 * (`readRollups` dedupes by periodStart, so a duplicate was never meaningful).
 *
 * A period is at most a day, so the file is small and a whole-file rewrite is
 * cheaper than the bookkeeping a log-structured store would need. Writes go to a
 * temp file and rename, so a crash mid-write leaves the previous file intact.
 * @param dir - the rollup directory.
 * @param sessionId - the session being indexed.
 * @param record - what {@link buildRollupRecord} produced.
 */
export function appendRollup(dir, sessionId, record) {
  fs.mkdirSync(dir, { recursive: true });
  const file = rollupPath(dir, sessionId);
  const kept = [];
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // First write for this session: nothing to preserve.
  }
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let existing;
    try {
      existing = JSON.parse(line);
    } catch {
      continue;
    }
    // Drop the period being rewritten, and any malformed row with it.
    if (existing?.periodStart === record.periodStart) continue;
    kept.push(line);
  }
  kept.push(JSON.stringify(record));
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, kept.join("\n") + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Which days still need building.
 *
 * A day is pending when no rollup exists for it, or when the stored fingerprint no
 * longer matches the checkpoints it claimed to cover. That is lcm-x's `stale`
 * status, computed instead of stored: the fingerprint is the status.
 * @param planned - from {@link planDayRollups}.
 * @param stored - from {@link readRollups}.
 * @returns the pending days, oldest first.
 */
export function pendingRollups(planned, stored) {
  const known = new Map(stored.map((record) => [record.periodStart, record]));
  return planned.filter((day) => {
    const record = known.get(day.periodStart);
    return record === undefined || record.fingerprint !== rollupFingerprint(day.entries);
  });
}

/**
 * The instruction one rollup summarisation sends.
 *
 * Shorter than the leaf contract on purpose: a rollup is a chronology, not a
 * recovery surface. Anything it omits is still reachable through `lcm_search` and
 * through the checkpoints it names, so the text does not have to be exhaustive —
 * it has to say what happened, in order, with the seq of each step.
 * @param periodStart - the UTC day being summarised.
 * @param targetTokens - how long the answer should be.
 * @returns the instruction block.
 */
export function buildRollupInstruction(periodStart, targetTokens) {
  return [
    "Write a chronology of " + periodStart + " (UTC) from the checkpoint bodies below.",
    "",
    "Output format: one line per distinct piece of work, oldest first. Each line is",
    "  (seq N) <what was done>",
    "where N is the seq of the checkpoint the fact came from. Nothing else: no",
    "heading, no introduction, no closing paragraph, no blank lines between entries.",
    "",
    "The first character of your answer must be \"(\". A reply that begins with any",
    "sentence about the task, the bodies, or what you are about to do is wrong and",
    "will be rejected — begin directly with the first chronology line.",
    "",
    "Length: about " + targetTokens + " tokens. Fewer is fine; do not pad.",
    "Keep exact identifiers: paths, commands, host names, versions, error strings, numbers.",
    "If the bodies contain nothing durable, answer with the single line: (seq 0) nothing durable"
  ].join("\n");
}

/**
 * Whether a model answer is a chronology rather than talk about one.
 *
 * Measured failure this rejects: a 3 070-token day came back as the single
 * sentence "I'll start by locating the checkpoint bodies." — the model describing
 * the task instead of doing it. Fourteen tokens against a 5 000-token target, and
 * nothing in the pipeline noticed.
 *
 * The test is structural, not stylistic: a chronology line starts with `(seq`.
 * Anything else is not the requested shape, whatever it says.
 * @param text - the model's answer.
 * @returns true when the body is shaped like a chronology.
 */
export function isChronology(text) {
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  const shaped = lines.filter((line) => /^\(seq \d+\)/u.test(line));
  // At least one well-formed line and a STRICT majority of them: a body that is
  // mostly prose with one stray citation is still prose, and `>=` would have let
  // "Here is the timeline:\n(seq 1) did a thing" through as a chronology.
  return shaped.length > 0 && shaped.length * 2 > lines.length;
}

/**
 * Assemble the durable record for one built day.
 * @param day - a planned day from {@link planDayRollups}.
 * @param text - the summarised body.
 * @returns the record {@link appendRollup} writes.
 */
export function buildRollupRecord(day, text) {
  return {
    periodKind: day.periodKind,
    periodStart: day.periodStart,
    fingerprint: rollupFingerprint(day.entries),
    seqs: day.entries.map((entry) => entry.seq),
    sourceTokens: day.tokens,
    tokens: estimateEntryTokens(text),
    builtAt: new Date().toISOString(),
    text
  };
}

export {
  DEFAULT_ROLLUP_BUILDS_PER_PASS,
  DEFAULT_ROLLUP_BUDGET_MS,
  DEFAULT_ROLLUP_MAX_TOKENS,
  DEFAULT_ROLLUP_TARGET_TOKENS,
  PERIOD_KIND
};
