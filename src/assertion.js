/**
 * Assertion extraction — lcm-x's `assertion_extraction_enabled`, off by default.
 *
 * A checkpoint is prose. An assertion is the same fact as a triple: who/what, what
 * it did or is, and the seq it can be traced back to. The reference materialises
 * them into `lcm_assertions` / `lcm_assertion_relations` and feeds them to an
 * answerer-driven retrieval controller, so a question like "which host did we
 * flash" resolves against typed rows instead of re-reading checkpoints.
 *
 * Why it is off by default: it costs a model call per checkpoint, the store is
 * derived data that has to be kept in step with the log, and lcm-x ships both of
 * its switches (`assertions_enabled`, `assertion_extraction_enabled`) as `False`.
 * Nothing else in this engine depends on it — `lcm_search` and `lcm_expand` work
 * whether or not a single assertion has ever been extracted.
 *
 * The store is a JSONL sidecar, same as rollups and for the same reason: an
 * assertion committed as a session event would become a surface node and be
 * compacted again.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** How many checkpoints one extraction pass may read. lcm-x ships 4. */
const DEFAULT_ASSERTION_MAX_SOURCES_PER_PASS = 4;
/** Wall-clock budget for one pass, seconds. lcm-x ships 30. */
const DEFAULT_ASSERTION_TIMEOUT_SECONDS = 30;

/** The three fields every extracted row carries. */
const ASSERTION_FIELDS = ["subject", "predicate", "object"];

/**
 * Identity of one assertion: its triple plus the seq it came from.
 *
 * Seq is part of the identity on purpose — the same sentence asserted on two
 * different days is two claims with two citations, and collapsing them would lose
 * which checkpoint to expand.
 * @param assertion - `{ subject, predicate, object, seq }`.
 * @returns a hex digest.
 */
export function assertionKey(assertion) {
  const hash = createHash("sha256");
  hash.update(String(assertion.subject) + "\u0000");
  hash.update(String(assertion.predicate) + "\u0000");
  hash.update(String(assertion.object) + "\u0000");
  hash.update(String(assertion.seq) + "\u0000");
  return hash.digest("hex");
}

/** @param dir - the assertion directory. @param sessionId - one file per session. */
function assertionPath(dir, sessionId) {
  return path.join(dir, String(sessionId).replace(/[^\w.-]/gu, "_") + ".jsonl");
}

/**
 * Where the mined-seq ledger lives.
 *
 * Separate from the rows on purpose. A checkpoint that yielded NO assertions is a
 * real answer, and without recording it every pass would pay a model call to
 * re-learn the same nothing. The obvious shortcut — a sentinel row in the same
 * file — would put a fake fact in the store and surface it in every search, so the
 * ledger is its own file.
 * @param dir - the assertion directory.
 * @param sessionId - whose ledger.
 * @returns the ledger path.
 */
function minedPath(dir, sessionId) {
  return path.join(dir, String(sessionId).replace(/[^\w.-]/gu, "_") + ".mined.jsonl");
}

/**
 * Read the assertions stored for a session, de-duplicated by {@link assertionKey}.
 * @param dir - the assertion directory.
 * @param sessionId - whose file to read.
 * @returns `[{ subject, predicate, object, seq }]`, newest first.
 */
export function readAssertions(dir, sessionId) {
  let raw;
  try {
    raw = fs.readFileSync(assertionPath(dir, sessionId), "utf8");
  } catch {
    return [];
  }
  const seen = new Map();
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record?.subject !== "string" || typeof record?.predicate !== "string" || typeof record?.object !== "string") continue;
    if (!Number.isSafeInteger(record.seq)) continue;
    // Last write wins, and Map preserves insertion order, so re-reading a file whose
    // tail was appended to keeps the newest ordering without a sort.
    seen.set(assertionKey(record), record);
  }
  return [...seen.values()].reverse();
}

/**
 * Append one pass's assertions.
 * @param dir - the assertion directory.
 * @param sessionId - whose file to append to.
 * @param assertions - rows already validated by {@link parseAssertions}.
 */
export function appendAssertions(dir, sessionId, assertions) {
  if (assertions.length === 0) return;
  fs.mkdirSync(dir, { recursive: true });
  const body = assertions.map((assertion) => JSON.stringify(assertion)).join("\n");
  fs.appendFileSync(assertionPath(dir, sessionId), body + "\n");
}

/**
 * Read the seqs already mined for a session.
 *
 * The ledger is what makes a pass idempotent: a checkpoint that yielded no
 * assertions is recorded as mined, so the next idle does not pay for the same
 * nothing. Rows and ledger are separate files, so a sentinel never leaks into
 * search results.
 * @param dir - the assertion directory.
 * @param sessionId - whose ledger.
 * @returns the mined seq set.
 */
export function readMined(dir, sessionId) {
  let raw;
  try {
    raw = fs.readFileSync(minedPath(dir, sessionId), "utf8");
  } catch {
    return new Set();
  }
  const mined = new Set();
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (Number.isSafeInteger(record?.seq)) mined.add(record.seq);
  }
  return mined;
}

/**
 * Record one checkpoint as mined, with how many assertions it yielded.
 * @param dir - the assertion directory.
 * @param sessionId - whose ledger.
 * @param seq - the checkpoint.
 * @param count - rows written for it; 0 is a real answer and still worth recording.
 */
export function markMined(dir, sessionId, seq, count) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(minedPath(dir, sessionId), JSON.stringify({ seq, count, at: new Date().toISOString() }) + "\n");
}

/**
 * Which checkpoints have not been mined yet.
 * @param events - the session's event list.
 * @param mined - the seq set from {@link readMined}.
 * @returns the unmined `compaction/summary` events, oldest first so a backlog
 *   drains in the order it accumulated.
 */
export function unminedCheckpoints(events, mined) {
  return events
    .filter((event) => event?.type === "compaction/summary" && Number.isSafeInteger(event.seq) && !mined.has(event.seq))
    .sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
}

/**
 * The instruction one extraction call sends.
 * @param seq - the checkpoint being mined.
 * @returns the instruction block.
 */
export function buildAssertionInstruction(seq) {
  return [
    "Extract the durable facts from the checkpoint below as a JSON array.",
    "",
    "Each element is exactly:",
    '  { "subject": "...", "predicate": "...", "object": "..." }',
    "",
    "Rules:",
    "- One fact per element. No sentences, no prose outside the JSON array.",
    "- subject: the thing the fact is about (a host, file, device, build, person, service).",
    "- predicate: a short verb phrase (was flashed to, contains, failed with, is configured as).",
    "- object: the value, path, identifier, version, IP, or outcome.",
    "- Copy identifiers and paths exactly. Do not translate them.",
    "- Skip anything that will be stale in an hour (progress, counts of work in flight).",
    "- An empty array is a valid answer when the checkpoint holds no durable fact.",
    "",
    "The checkpoint is seq " + String(seq) + "."
  ].join("\n");
}

/**
 * Parse a model answer into assertion rows.
 *
 * A fenced block is accepted because models fence JSON whether or not they are
 * asked to. Anything unparseable yields `[]` rather than throwing: this is derived
 * data, and a malformed answer must not fail the pass that produced it.
 * @param text - the model's answer.
 * @param seq - the checkpoint the answer describes, stamped onto every row.
 * @returns validated rows.
 */
export function parseAssertions(text, seq) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const body = (fenced === null ? text : fenced[1]).trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rows = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const fields = ASSERTION_FIELDS.map((field) => (typeof item[field] === "string" ? item[field].trim() : ""));
    if (fields.some((value) => value.length === 0)) continue;
    rows.push({ subject: fields[0], predicate: fields[1], object: fields[2], seq });
  }
  return rows;
}

/**
 * Filter stored assertions by a literal query.
 *
 * Case-insensitive substring over the triple, which is what an operator actually
 * types ("which host", "trustcache", an IP). Assertions are few and short, so a
 * scan is honest where an index would be ceremony.
 * @param assertions - from {@link readAssertions}.
 * @param query - the literal to look for; empty matches everything.
 * @param limit - maximum rows to return.
 * @returns the matching rows, newest first.
 */
export function searchAssertions(assertions, query, limit) {
  const needle = String(query ?? "").trim().toLowerCase();
  const hits = [];
  for (const assertion of assertions) {
    if (hits.length >= limit) break;
    if (needle.length === 0) {
      hits.push(assertion);
      continue;
    }
    const haystack = (assertion.subject + " " + assertion.predicate + " " + assertion.object).toLowerCase();
    if (haystack.includes(needle)) hits.push(assertion);
  }
  return hits;
}

export {
  ASSERTION_FIELDS,
  DEFAULT_ASSERTION_MAX_SOURCES_PER_PASS,
  DEFAULT_ASSERTION_TIMEOUT_SECONDS
};
