// ── a real Session has no `events` property ────────────────────────────────
// The rollup and assertion passes read the log through `sessionEvents`, which
// prefers `snapshotEvents()`. Reading `session.events` directly returns
// undefined on every real session and made both passes silent no-ops.
import assert from "node:assert/strict";
import test from "node:test";

import { sessionEvents } from "../src/events.js";
import { planDayRollups } from "../src/rollup.js";
import { unminedCheckpoints } from "../src/assertion.js";

const DAY = 86400000;
const T0 = Date.parse("2026-11-13T10:00:00Z");

/** A session shaped like a real dsh Session: a frozen snapshot, no `events`. */
function snapshotSession(events) {
  const frozen = Object.freeze(events.slice());
  return {
    id: "real-shape",
    snapshotEvents: () => frozen,
    eventAt: (seq) => events.find((event) => event.seq === seq),
    deriveEventMessage: (event) => event?.data?.message ?? null,
    requestHeader: () => ({ config: { provider: "p", model: "m" }, tools: [] })
  };
}

function checkpoint(seq, time, text) {
  return { type: "compaction/summary", seq, time, data: { summary: [{ type: "text", text }] } };
}

test("sessionEvents reads a real Session through snapshotEvents()", () => {
  const events = [checkpoint(1, T0, "a".repeat(400))];
  const session = snapshotSession(events);
  assert.equal("events" in session, false, "a real Session has no `events` property");
  assert.deepEqual(sessionEvents(session), events, "the accessor finds the log anyway");
});

test("sessionEvents keeps the fixture path working", () => {
  const events = [checkpoint(1, T0, "a".repeat(400))];
  assert.deepEqual(sessionEvents({ events }), events, "an `events` array still wins");
  assert.deepEqual(sessionEvents({ log: events }), events, "an append-only `log` is the last resort");
  assert.deepEqual(sessionEvents({}), [], "and a value with none is empty, not undefined");
  assert.deepEqual(sessionEvents(null), [], "null is empty too");
});

test("the rollup planner sees a real-shaped session, which `session.events` would not", () => {
  const events = [checkpoint(1, T0, "a".repeat(400)), checkpoint(2, T0 + DAY, "b".repeat(400))];
  const session = snapshotSession(events);

  // The defect: this is what the pass used to read.
  assert.equal(planDayRollups(session.events ?? []).length, 0, "`session.events` plans nothing");
  // The fix.
  assert.equal(planDayRollups(sessionEvents(session)).length, 2, "the accessor plans both days");
});

test("the assertion planner sees a real-shaped session too", () => {
  const events = [checkpoint(1, T0, "a".repeat(400))];
  const session = snapshotSession(events);
  assert.equal(unminedCheckpoints(session.events ?? [], new Set()).length, 0, "the defect");
  assert.equal(unminedCheckpoints(sessionEvents(session), new Set()).length, 1, "the fix");
});
