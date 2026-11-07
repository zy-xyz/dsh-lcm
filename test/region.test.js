/**
 * region.js — the durable compaction transaction.
 *
 * These tests exist because an audit found the plugin had **never successfully
 * compacted**: `commitCompactionBody` emitted `{op, start, end}` while the
 * harness requires exactly `{op, startSeq, endSeq}`, so every commit threw
 * *after* `compaction/start` and `compaction/summary` had landed — stranding an
 * orphan summary and leaving the surface unable to shrink.
 *
 * The fixture below replays every appended event through the harness's own
 * `foldSurface`, so a malformed surfaceOp fails here instead of in production.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { compactSurfaceRegion, selectCompactableRange, assertNoActiveCompaction } from "../src/region.js";

let foldSurface;
try {
  ({ foldSurface } = await import("@deepseek-ai/dsh-session/surface"));
} catch {
  foldSurface = null;
}

const skip = foldSurface === null;

// ── fixture ────────────────────────────────────────────────────────────────

/**
 * Minimal session that can actually be compacted: append assigns a monotonic
 * seq, records surfaceOp/sourceEventSeqs, and every append is replayed through
 * the harness's fold so an invalid surfaceOp throws immediately.
 */
/** The harness's surface-eligible event types require an `append` marker. */
const SURFACE_TYPES = new Set(["system/message", "developer/message", "user/message", "assistant/message", "tool/result"]);

/** Normalize one seeded event to the marker the canonical fold expects. */
function withMarker(event) {
  if (SURFACE_TYPES.has(event.type)) {
    return event.surfaceOp === undefined ? { ...event, surfaceOp: "append" } : event;
  }
  const { surfaceOp, sourceEventSeqs, ...rest } = event;
  return rest;
}

function makeSession(events) {
  const list = events.map(withMarker);
  const session = {
    id: "s1",
    events: list,
    get surface() {
      const folded = foldSurface(list);
      return { nodes: folded.nodes, replaceGeneration: folded.replaceGeneration ?? 0 };
    },
    eventAt: (seq) => list.find((e) => e.seq === seq),
    deriveEventMessage: (event) => event.message ?? event.data?.message ?? null,
    requestHeader: () => ({ config: { provider: "p", model: "m" }, tools: [] }),
    append(type, data, metadata) {
      const event = withMarker({ type, seq: list.length, time: 1_790_000_000_000 + list.length, data, ...(metadata ?? {}) });
      // Replay the whole log through the canonical fold on every append: this is
      // the assertion that would have caught the wrong surfaceOp shape.
      foldSurface([...list, event]);
      list.push(event);
      return event;
    }
  };
  return session;
}

/** A turn of user/assistant/tool messages, no compaction. */
function plainEvents(turns = 3) {
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
      data: { content: [{ type: "text", text: `question ${turn} ${"x".repeat(200)}` }] }
    });
    events.push({
      type: "assistant/message",
      seq: seq++,
      time: 1,
      data: { turn, step: 1, message: { role: "assistant", content: [{ type: "text", text: `answer ${turn} ${"y".repeat(200)}` }] } }
    });
    events.push({ type: "turn/end", seq: seq++, time: 1, data: { turn } });
  }
  return events;
}

/** Dependencies: a meter that prices each node equally, plus a stub compile. */
function makeDeps(overrides = {}) {
  const compile = overrides.compile ?? (async (prepared) => ({
    entries: [{ seq: prepared.shadowedSeqs[0], text: "## 目标与约束\n- summarized", kind: "checkpoint" }],
    stats: { nodes: prepared.shadowedSeqs.length, entries: 1, toolCalls: 0, toolResults: 0, images: 0,
             documents: 0, reasoningElided: 0, noiseElided: 0, checkpoints: 1, tokens: 8,
             elidedToolRows: 0, elidedRows: 0 },
    capped: false,
    provider: "p",
    model: "m",
    maxTokens: 1024
  }));
  return {
    meter: {
      measure: (session) => ({ nodes: session.surface.nodes.map((seq) => ({ seq, tokens: 100 })), totalTokens: session.surface.nodes.length * 100 }),
      estimateMessage: () => 10
    },
    compile,
    ...overrides
  };
}

// ── R1: the surfaceOp shape the harness actually accepts ───────────────────

test("commit writes a positional replacement the canonical fold accepts", { skip }, async () => {
  const session = makeSession(plainEvents(3));
  const nodes = session.surface.nodes;
  const deps = makeDeps();

  // Node 0 is the system head; the harness rejects a replace that covers it, so
  // selection never includes it and this test starts at node 1.
  const result = await compactSurfaceRegion(deps, session, nodes[1], nodes[nodes.length - 2], { session }, { owner: null, stability: "selected-span" });

  assert.deepEqual(result.shadowedRange, { start: nodes[1], end: nodes[nodes.length - 2] });
  assert.ok(session.surface.nodes.length < nodes.length, "the surface must actually shrink");

  // The replacement event is exactly {op, startSeq, endSeq}.
  const replacement = session.events.find((e) => e.surfaceOp?.op === "replace");
  assert.ok(replacement, "a replace event must exist");
  assert.deepEqual(Object.keys(replacement.surfaceOp).sort(), ["endSeq", "op", "startSeq"]);

  // Contract adjacency: the summary event is immediately followed by the replacement.
  const summaryIndex = session.events.findIndex((e) => e.type === "compaction/summary");
  assert.equal(session.events[summaryIndex + 1], replacement, "summary must be immediately followed by its replacement");

  // The system head survives compaction untouched.
  assert.ok(session.surface.nodes.includes(nodes[0]), "node 0 must remain on the surface");

  // Bracketing: exactly one start and one end, in that order.
  const starts = session.events.filter((e) => e.type === "compaction/start");
  const ends = session.events.filter((e) => e.type === "compaction/end");
  assert.equal(starts.length, 1);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].data.error, undefined);
});

// ── R3: the shrink guard must throw, not silently land ─────────────────────

test("a checkpoint that does not shrink the span is rejected", { skip }, async () => {
  const session = makeSession(plainEvents(3));
  const nodes = session.surface.nodes;
  // Every node prices at 100 tokens; a 10-token estimate per message means the
  // framed replacement is tiny — so make the meter inflate the replacement instead.
  const deps = makeDeps({ meter: { measure: (s) => ({ nodes: s.surface.nodes.map((seq) => ({ seq, tokens: 1 })), totalTokens: s.surface.nodes.length }), estimateMessage: () => 10_000 } });

  await assert.rejects(
    compactSurfaceRegion(deps, session, nodes[1], nodes[nodes.length - 2], { session }, { owner: null, stability: "selected-span" }),
    (error) => {
      const chain = [error, error.cause, error.cause?.cause].filter(Boolean).map((e) => String(e.message));
      assert.ok(
        chain.some((message) => /not smaller than the shadowed content/.test(message)),
        `shrink guard message missing from chain: ${chain.join(" | ")}`
      );
      return true;
    }
  );
  const ends = session.events.filter((e) => e.type === "compaction/end");
  assert.equal(ends.length, 1, "a failed attempt still closes its marker exactly once");
  assert.equal(typeof ends[0].data.error, "string", "the failure is recorded as a string");
});

// ── R4: a compile failure closes the marker and releases the lock ──────────

test("a compile failure writes one compaction/end and releases the lock", { skip }, async () => {
  const session = makeSession(plainEvents(3));
  const nodes = session.surface.nodes;
  const deps = makeDeps({ compile: async () => { throw new Error("summarizer exploded"); } });

  await assert.rejects(
    compactSurfaceRegion(deps, session, nodes[0], nodes[nodes.length - 2], { session }, { owner: null, stability: "selected-span" })
  );
  const ends = session.events.filter((e) => e.type === "compaction/end");
  assert.equal(ends.length, 1);
  assert.match(String(ends[0].data.error), /summarizer exploded/);
  // The lock is free again, so a second attempt is allowed to start.
  assert.doesNotThrow(() => assertNoActiveCompaction(session, "second attempt"));
  assert.equal(session.events.filter((e) => e.type === "compaction/summary").length, 0, "no orphan summary");
});

// ── R7: compaction never splits a tool-call/result pair ────────────────────

test("selection refuses a cut that would split a tool pair", { skip }, async () => {
  const events = plainEvents(2);
  let seq = events.length;
  events.push({ type: "turn/start", seq: seq++, time: 1, data: { turn: 3 } });
  events.push({ type: "user/message", seq: seq++, time: 1, data: { content: [{ type: "text", text: "run it" }] } });
  // The balance counter reads tool-call blocks off assistant messages.
  events.push({
    type: "assistant/message",
    seq: seq++,
    time: 1,
    data: { turn: 3, step: 1, message: { role: "assistant", content: [{ type: "tool-call", id: "call-1", name: "run", arguments: "{}" }] } }
  });
  events.push({ type: "tool/call", seq: seq++, time: 1, data: { turn: 3, step: 1, callId: "call-1", name: "run", arguments: "{}" } });
  events.push({
    type: "tool/result",
    seq: seq++,
    time: 1,
    data: {
      turn: 3,
      step: 1,
      message: {
        role: "tool",
        source: { kind: "tool", callId: "call-1" },
        toolCallId: "call-1",
        content: [{ type: "text", text: "ok" }]
      }
    }
  });
  events.push({ type: "turn/end", seq: seq++, time: 1, data: { turn: 3 } });

  const session = makeSession(events);
  const measurement = { nodes: session.surface.nodes.map((s) => ({ seq: s, tokens: 100 })), totalTokens: session.surface.nodes.length * 100 };
  const range = selectCompactableRange(session, measurement, 0);
  assert.ok(range !== null, "a range must exist");
  // The cut must land on a balanced boundary: no tool/call without its result inside the span.
  const span = session.surface.nodes.slice(
    session.surface.nodes.indexOf(range.start),
    session.surface.nodes.indexOf(range.end) + 1
  );
  const callIds = new Set(span.filter((s) => session.eventAt(s)?.type === "tool/call").map((s) => session.eventAt(s).data.callId));
  const resultIds = new Set(span.filter((s) => session.eventAt(s)?.type === "tool/result").map((s) => session.eventAt(s).data.toolCallId));
  for (const id of callIds) assert.ok(resultIds.has(id), `cut split tool pair ${id}`);
});

// ── selection basics ──────────────────────────────────────────────────────

test("selection keeps the trailing tail and never includes the system head", { skip }, async () => {
  const session = makeSession(plainEvents(4));
  const measurement = { nodes: session.surface.nodes.map((s) => ({ seq: s, tokens: 100 })), totalTokens: session.surface.nodes.length * 100 };
  const range = selectCompactableRange(session, measurement, 200);
  assert.ok(range !== null);
  assert.notEqual(range.start, session.surface.nodes[0], "the system head is never compacted");
});
// ── R2: manual /compact must actually run ─────────────────────────────────

test("compactNow compacts an idle session and returns a durable result", { skip }, async () => {
  const { default: Engine } = await import("../src/index.js");
  const session = makeSession(plainEvents(3));
  const engine = Object.create(Engine.prototype);

  // A real /compact used to throw ReferenceError (an out-of-scope `spec`) that
  // the catch-all then rewrote as ManualCompactionError("busy"), so manual
  // compaction was 100% broken while looking like a lock contention.
  engine.config = { auto: false };
  engine.ctx = {
    tokenMeter: {
      measure: (s) => ({ nodes: s.surface.nodes.map((seq) => ({ seq, tokens: 100 })), totalTokens: s.surface.nodes.length * 100 }),
      estimateMessage: () => 10
    },
    sessions: { flush: async () => {} },
    get: () => undefined,
    logger: { warn: () => {}, info: () => {} }
  };
  engine.compile = async (prepared) => ({
    entries: [{ seq: prepared.shadowedSeqs[0], text: "## 目标与约束\n- manual", kind: "checkpoint" }],
    stats: { nodes: prepared.shadowedSeqs.length, entries: 1, toolCalls: 0, toolResults: 0, images: 0, documents: 0,
             reasoningElided: 0, noiseElided: 0, checkpoints: 1, tokens: 8, elidedToolRows: 0, elidedRows: 0 },
    capped: false, provider: "p", model: "m", maxTokens: 512
  });

  const agent = {
    session,
    options: {},
    runMaintenance: (task) => task(new AbortController().signal)
  };

  const before = session.surface.nodes.length;
  const result = await engine.compactNow(agent, new AbortController().signal, undefined);

  assert.ok(result !== null, "manual compaction must produce a result");
  assert.ok(session.surface.nodes.length < before, "the surface must shrink");
  assert.equal(result.shadowedSeqs.length > 0, true);
  assert.equal(session.events.filter((e) => e.type === "compaction/end").length, 1);
});
