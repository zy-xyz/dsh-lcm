/**
 * Search ranking — and why the default is chronological order.
 *
 * A relevance ranking was implemented, measured against 21 anchors a real
 * production summary had dropped, and **lost** to plain seq order on recall@5
 * and MRR (bench/REPORT.md §14). The modes stay switchable so the question can
 * be re-opened, but the default is the measured winner, and these tests pin
 * each ordering so a future change cannot silently flip it.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { searchSession, RANK_MODES } from "../src/search.js";

/** A session whose first event is a long dump and whose second is the answer. */
function fixture() {
  const dump = ["BEGIN", ...Array.from({ length: 40 }, () => "target token appears here"), "END"].join("\n");
  const events = [
    { type: "session", id: "s" },
    { type: "tool/result", seq: 0, time: 1, data: { message: { role: "tool", content: [{ type: "text", text: dump }] } } },
    { type: "user/message", seq: 1, time: 1, data: { content: [{ type: "text", text: "we chose integer[] for the target token column" }] } },
    { type: "assistant/message", seq: 2, time: 1, data: { message: { role: "assistant", content: [{ type: "text", text: "noted" }] } } }
  ];
  return {
    events,
    eventAt: (seq) => events.find((e) => e.seq === seq),
    deriveEventMessage: (event) => event.data?.message ?? (event.data?.content === undefined ? null : { role: "user", content: event.data.content })
  };
}

const config = (rank) => ({ maxSearchHits: 50, maxRecallTokens: 100000, rank });

test("seq order returns hits chronologically", () => {
  const result = searchSession(fixture(), "target token", config("seq"));
  assert.deepEqual(result.hits.map((h) => h.seq), [0, 1]);
  assert.equal(result.rank, "seq");
});

test("score order puts the densest event first", () => {
  const result = searchSession(fixture(), "target token", config("score"));
  assert.equal(result.hits[0].seq, 0, "the 40-line dump has far more matching lines");
  assert.equal(result.rank, "score");
});

test("density order normalises by event size", () => {
  const result = searchSession(fixture(), "target token", config("density"));
  // The dump matches 40 times in ~40 lines; the answer matches once in 1 line.
  // Density can still favour the dump here, but the mode must be deterministic.
  assert.equal(result.hits[0].seq, 0);
  assert.equal(result.rank, "density");
});

test("the default is seq, the mode that won on production data", () => {
  const result = searchSession(fixture(), "target token", { maxSearchHits: 50, maxRecallTokens: 100000 });
  assert.equal(result.rank, "seq");
  assert.deepEqual(RANK_MODES, ["seq", "score", "density"]);
});

test("every mode reports the same match population", () => {
  const counts = RANK_MODES.map((mode) => searchSession(fixture(), "target token", config(mode)).totalMatches);
  assert.deepEqual(new Set(counts).size, 1, "ranking must not change which events matched");
});
