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
 * JSONL sidecar per session — durable, append-only, and outside the session log
 * for the reason that matters: a rollup committed AS a session event would become
 * a surface node and be compacted again, which is a loop that grows the thing it
 * is supposed to compress.
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
 * Append one built rollup.
 * @param dir - the rollup directory.
 * @param sessionId - the session being indexed.
 * @param record - what {@link buildRollupRecord} produced.
 */
export function appendRollup(dir, sessionId, record) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(rollupPath(dir, sessionId), JSON.stringify(record) + "\n");
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
    "Summarize the checkpoint bodies below into a chronology of " + periodStart + " (UTC).",
    "",
    "Rules:",
    "- About " + targetTokens + " tokens. Fewer is fine; do not pad.",
    "- One line per distinct piece of work, in the order it happened.",
    "- Start each line with the seq of the checkpoint it came from, as (seq N).",
    "- Keep exact identifiers: paths, commands, host names, versions, error strings, numbers.",
    "- No preamble, no closing summary, no praise of the work."
  ].join("\n");
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
