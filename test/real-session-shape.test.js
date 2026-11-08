/**
 * The session shape a real dsh `Session` actually has.
 *
 * A real session exposes an append-only `log`, a frozen `snapshotEvents()`
 * accessor and `eventAt(seq)`, and it has **no** `events` property. Every reader
 * in this plugin used to index `session.events`, so on the first real session it
 * met the engine died inside compaction with
 * `Cannot read properties of undefined (reading 'length')` — the plugin had never
 * compacted once in production, and the `events`-carrying fixtures hid it.
 *
 * These tests therefore build a fixture that deliberately omits `events`. Any
 * reader that regresses to `session.events` fails here instead of in a live
 * session.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { sessionEvents } from "../src/events.js";
import { assertNoActiveCompaction, compactSurfaceRegion } from "../src/region.js";
import { findCheckpointSeqs, recallSession } from "../src/recall.js";
import { searchSession } from "../src/search.js";
import { deriveDag } from "../src/summarize.js";

let foldSurface;
try {
  ({ foldSurface } = await import("@deepseek-ai/dsh-session/surface"));
} catch {
  foldSurface = null;
}

const skip = foldSurface === null;

// ── fixture: a real session shape, no `events` property ────────────────────

/** The harness's surface-eligible event types require an `append` marker. */
const SURFACE_TYPES = new Set(["system/message", "developer/message", "user/message", "assistant/message", "tool/result"]);

function withMarker(event) {
  if (SURFACE_TYPES.has(event.type)) {
    return event.surfaceOp === undefined ? { ...event, surfaceOp: "append" } : event;
  }
  const { surfaceOp, sourceEventSeqs, ...rest } = event;
  return rest;
}

/**
 * Build a session with the real accessor surface only:
 * `log` + `snapshotEvents()` + `eventAt()` + `deriveEventMessage()` + `append()`.
 * `snapshotEvents()` returns a frozen copy, exactly like the harness.
 * @param events - seeded log records.
 * @returns the session and a counter of snapshot calls.
 */
function realSessionShape(events) {
  const list = events.map(withMarker);
  let snapshotCalls = 0;
  const session = {
    id: "real-shape-1",
    log: list,
    snapshotEvents() {
      snapshotCalls += 1;
      return Object.freeze([...list]);
    },
    get surface() {
      const folded = foldSurface(list);
      return { nodes: folded.nodes, replaceGeneration: folded.replaceGeneration ?? 0 };
    },
    eventAt: (seq) => list.find((event) => event.seq === seq),
    deriveEventMessage: (event) => event.data?.message ?? event.message ?? null,
    requestHeader: () => ({ config: { provider: "p", model: "m" }, tools: [] }),
    append(type, data, metadata) {
      const event = withMarker({ type, seq: list.length, time: 1_790_000_000_000 + list.length, data, ...(metadata ?? {}) });
      // Replay through the canonical fold: an invalid surfaceOp throws here.
      foldSurface([...list, event]);
      list.push(event);
      return event;
    }
  };
  return { session, snapshotCalls: () => snapshotCalls };
}

/** One open turn of user/assistant messages, no compaction. */
function openTurnEvents(turns = 3) {
  const events = [
    { type: "system/message", seq: 0, time: 1, data: { message: { role: "system", content: [{ type: "text", text: "sys" }] } } }
  ];
  let seq = 1;
  for (let turn = 1; turn <= turns; turn += 1) {
    events.push({ type: "turn/start", seq: seq++, time: 1, data: { turn } });
    events.push({
      type: "user/message",
      seq: seq++,
      time: 1,
      data: { message: { role: "user", content: [{ type: "text", text: `question ${turn} NEEDLE_${turn} ${"x".repeat(200)}` }] } }
    });
    events.push({
      type: "assistant/message",
      seq: seq++,
      time: 1,
      data: { message: { role: "assistant", content: [{ type: "text", text: `answer ${turn} ZZZ_TOKEN_XYZ ${"y".repeat(200)}` }] }, turn, step: 1 }
    });
  }
  return events;
}

/** Dependencies: an equal-price meter and a deterministic compile stub. */
function makeDeps() {
  return {
    meter: {
      measure: (session) => ({ nodes: session.surface.nodes.map((seq) => ({ seq, tokens: 100 })), totalTokens: session.surface.nodes.length * 100 }),
      estimateMessage: () => 10
    },
    compile: async (prepared) => ({
      entries: [{ seq: prepared.shadowedSeqs[0], text: "## 目标与约束\n- summarized", kind: "checkpoint" }],
      stats: { nodes: prepared.shadowedSeqs.length, entries: 1, toolCalls: 0, toolResults: 0, images: 0,
               documents: 0, reasoningElided: 0, noiseElided: 0, checkpoints: 1, tokens: 8,
               elidedToolRows: 0, elidedRows: 0 },
      capped: false,
      provider: "p",
      model: "m",
      maxTokens: 1024
    })
  };
}

// ── the accessor ───────────────────────────────────────────────────────────

test("the fixture has no events property, and sessionEvents reads the real accessors", { skip }, () => {
  const { session, snapshotCalls } = realSessionShape(openTurnEvents(1));
  assert.equal("events" in session, false, "the fixture must not expose events — that is the bug shape");
  assert.equal(session.events, undefined);
  assert.ok(Array.isArray(session.log));

  const events = sessionEvents(session);
  assert.equal(events.length, session.log.length);
  assert.notEqual(events, session.log, "snapshotEvents() wins over the raw log");
  assert.ok(Object.isFrozen(events), "the harness returns a frozen snapshot");
  assert.equal(snapshotCalls(), 1);
  assert.deepEqual(sessionEvents(null), []);
  assert.deepEqual(sessionEvents({}), []);
});

// ── the three readers on the real shape ────────────────────────────────────

test("inspectCompactionEntryState, searchSession and recallSession work without session.events", { skip }, () => {
  const { session, snapshotCalls } = realSessionShape(openTurnEvents(3));

  // region.js: the entry-state read must not throw on a session with no events.
  assert.doesNotThrow(() => assertNoActiveCompaction(session, "step compaction"));

  // search.js: the hit must point at the event that actually carries the token.
  const found = searchSession(session, "NEEDLE_2", { maxSearchHits: 5, maxRecallTokens: 4000 });
  assert.ok(found.totalMatches >= 1, "search must find the seeded token on the real shape");
  const hitSeq = found.hits[0].seq;
  assert.equal(session.eventAt(hitSeq).type, "user/message");
  assert.match(found.text, /NEEDLE_2/);

  // recall.js: the same seq must restore the original content, not "not found".
  const recalled = recallSession(session, [{ start: hitSeq, end: hitSeq }], { maxRecallTokens: 4000 });
  assert.equal(recalled.missing, 0, "recall must resolve the seq on the real shape");
  assert.ok(recalled.recalled >= 1);
  assert.match(recalled.text, /NEEDLE_2/);
  assert.doesNotMatch(recalled.text, /not found in this session/);

  // recall.js findCheckpointSeqs reads the whole log through the accessor.
  assert.deepEqual(findCheckpointSeqs(session), []);

  // The frozen snapshot is taken once per reader, never once per event.
  assert.ok(snapshotCalls() <= 4, `each reader takes one snapshot, not one per event (took ${snapshotCalls()})`);
});

// ── compile → commit actually lands on the real shape ──────────────────────

test("a full compile→commit lands on the real shape and shrinks the surface", { skip }, async () => {
  const { session } = realSessionShape(openTurnEvents(3));
  const deps = makeDeps();
  const nodes = session.surface.nodes;
  const start = nodes[1];
  const end = nodes[nodes.length - 2];

  const result = await compactSurfaceRegion(deps, session, start, end, { session }, { owner: "current-turn", stability: "whole-surface" });

  // The transaction returned a committed result with all three marker seqs.
  assert.deepEqual(result.shadowedRange, { start, end });
  assert.ok(Number.isSafeInteger(result.startSeq));
  assert.ok(Number.isSafeInteger(result.summarySeq));
  assert.ok(Number.isSafeInteger(result.endSeq));
  assert.ok(result.startSeq < result.summarySeq && result.summarySeq < result.endSeq);

  // The durable log really carries start / summary / end, in order, once each.
  const typeCount = (type) => session.log.filter((event) => event.type === type).length;
  assert.equal(typeCount("compaction/start"), 1);
  assert.equal(typeCount("compaction/summary"), 1);
  assert.equal(typeCount("compaction/end"), 1);
  assert.equal(session.log[result.startSeq].type, "compaction/start");
  assert.equal(session.log[result.summarySeq].type, "compaction/summary");
  assert.equal(session.log[result.endSeq].type, "compaction/end");

  // The positional replacement contract landed: a checkpoint user/message whose
  // surfaceOp is exactly {op, startSeq, endSeq}.
  const replacement = session.log.find((event) => event.type === "user/message" && event.surfaceOp?.op === "replace");
  assert.ok(replacement !== undefined, "the checkpoint replacement must be on the log");
  assert.deepEqual(Object.keys(replacement.surfaceOp).sort(), ["endSeq", "op", "startSeq"]);
  assert.deepEqual(replacement.surfaceOp, { op: "replace", startSeq: start, endSeq: end });

  // The surface actually shrank, and the checkpoint is now a node on it.
  assert.ok(session.surface.nodes.length < nodes.length, "the surface must shrink");
  assert.ok(session.surface.nodes.includes(replacement.seq), "the checkpoint must be a live surface node");

  // Post-commit reads work on the same real-shape session.
  assert.doesNotThrow(() => assertNoActiveCompaction(session, "after commit"));
  const checkpoints = findCheckpointSeqs(session);
  assert.equal(checkpoints.length, 1, "the landed checkpoint is discoverable through the log accessor");
  assert.equal(checkpoints[0], replacement.seq);

  // The summary DAG derives one depth-1 node from the durable log alone.
  const dag = deriveDag(session);
  assert.equal(dag.checkpoints, 1);
  assert.equal(dag.maxDepth, 1);
  assert.ok(dag.nodeBySeq.has(replacement.seq));

  // And the checkpoint body is searchable / recallable through the real shape.
  const found = searchSession(session, "summarized", { maxSearchHits: 5, maxRecallTokens: 4000 });
  assert.ok(found.totalMatches >= 1, "the committed checkpoint must be searchable");
  const recalled = recallSession(session, [{ start: result.summarySeq, end: result.summarySeq }], { maxRecallTokens: 4000 });
  assert.equal(recalled.missing, 0);
  assert.equal(session.log.length, result.endSeq + 1, "start + summary + replacement + end are the only new records");
});
