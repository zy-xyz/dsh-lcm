// ── a real Session has no `events` property ────────────────────────────────
// The rollup and assertion passes read the log through `sessionEvents`, which
// prefers `snapshotEvents()`. Reading `session.events` directly returns
// undefined on every real session and made both passes silent no-ops.
import assert from "node:assert/strict";
import test from "node:test";

import { deriveEventMessage, sessionEvents } from "../src/events.js";
import { collectVectorItems } from "../src/search.js";
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
    // The harness's rules, shared with src so a fixture cannot drift from them.
    deriveEventMessage,
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

test("the vector collector reads a real-shaped session, and the fixture shape agrees", () => {
  // An audit flagged the vector matrix files for building sessions out of an `events`
  // array. That fixture path is supported on purpose (events.js keeps it first so
  // older callers work), but it means those files never exercise `snapshotEvents()`
  // — a real Session has no `events` property at all. This pins the parity once, so
  // the collector's real path is covered without rewriting eight fixtures.
  const events = [
    { seq: 0, type: "user/message", data: { content: [{ type: "text", text: "alpha note" }] } },
    { seq: 1, type: "user/message", data: { content: [{ type: "text", text: "beta note" }] } }
  ];
  const bounds = { events: Number.MAX_SAFE_INTEGER, tokens: Number.MAX_SAFE_INTEGER };
  const real = snapshotSession(events);
  const fixture = { ...real, events, snapshotEvents: undefined };

  const fromReal = collectVectorItems(real, bounds).items;
  const fromFixture = collectVectorItems(fixture, bounds).items;
  assert.equal(fromReal.length, 2, "the real accessor yields both candidates");
  assert.deepEqual(
    fromReal.map((item) => item.text),
    fromFixture.map((item) => item.text),
    "both session shapes must rank the same bytes"
  );
});

test("the panel counts the same corpus embedding writes, user messages included", async () => {
  // coverageCandidates synthesises a session from a bare event array, so it must
  // supply the harness's own projection. With an approximate one
  // (`event?.data?.message ?? null`) every user/message derived nothing,
  // renderEventBody fell back to a JSON dump, and those candidates hashed to text no
  // embedding ever writes: measured, 1 337 phantom "pending" rows on one 79 884-event
  // log, which is why the panel's pending count never reached zero.
  const { coverageCandidates } = await import("../src/insight.js");
  const { createHash } = await import("node:crypto");
  const events = [
    { seq: 0, type: "user/message", data: { role: "user", id: "u0", content: [{ type: "text", text: "alpha note" }] } },
    { seq: 1, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "beta note" }] } } }
  ];
  const panel = coverageCandidates(events, {});
  // What embedding writes: the host's derive on the same events.
  const host = collectVectorItems(snapshotSession(events), { events: Number.MAX_SAFE_INTEGER, tokens: Number.MAX_SAFE_INTEGER }).items;
  const hostDigests = host.map((item) => createHash("sha256").update(String(item.text).slice(0, 4000), "utf8").digest("hex"));

  assert.equal(panel.length, hostDigests.length, "same candidate count");
  const panelSet = new Set(panel);
  for (const digest of hostDigests) {
    assert.ok(panelSet.has(digest), "every text embedding writes is counted by the panel");
  }
});
