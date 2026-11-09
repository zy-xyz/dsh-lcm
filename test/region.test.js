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
let snapshotJsonValue;
try {
  ({ foldSurface } = await import("@deepseek-ai/dsh-session/surface"));
  ({ snapshotJsonValue } = await import("@deepseek-ai/dsh-util-values"));
} catch {
  foldSurface = null;
  snapshotJsonValue = undefined;
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
      // The payload rule the real `Session.append` enforces, and the one that made
      // the deterministic rung uncommittable: `snapshotJsonValue` returns `undefined`
      // for any object holding an `undefined` value, and the harness then throws
      // 'session event "<type>" carries non-JSON-serializable data'. Reproducing it
      // here is what turns the fixture from "shape-plausible" into "accepts exactly
      // what the log accepts".
      if (snapshotJsonValue(data) === undefined) throw new Error(`session event "${type}" carries non-JSON-serializable data`);
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
    maxTokens: 4096
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
    capped: false, provider: "p", model: "m", maxTokens: 4096
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

// ── R8: a payload field that is `undefined` cannot strand the commit ──────────

test("an undefined payload field is omitted instead of stranding the transaction", { skip }, async () => {
  // The measured defect: the deterministic rung returned no provider/model, the
  // payload carried `provider: undefined`, `snapshotJsonValue` rejected the whole
  // payload, and the append threw AFTER `compaction/start` had landed - so the
  // transaction died as ManualCompactionError("commit") and the surface never
  // shrank. The rung whose documented property is "guaranteed convergence" was
  // the one rung that could not finish.
  //
  // The guard now omits undefined members, because convergence is what that rung
  // is for and a missing optional member is recoverable where a stranded lock is
  // not. This stub compile reproduces the shape with no fix at the source.
  const session = makeSession(plainEvents(3));
  const nodes = session.surface.nodes;
  const deps = makeDeps({
    compile: async (prepared) => ({
      entries: [{ seq: prepared.shadowedSeqs[0], text: "## 目标与约束\n- summarized", kind: "checkpoint" }],
      stats: { nodes: prepared.shadowedSeqs.length, entries: 1, toolCalls: 0, toolResults: 0, images: 0,
               documents: 0, reasoningElided: 0, noiseElided: 0, checkpoints: 1, tokens: 8,
               elidedToolRows: 0, elidedRows: 0 },
      capped: false,
      provider: undefined,
      model: "m",
      maxTokens: undefined
    })
  });

  const result = await compactSurfaceRegion(deps, session, nodes[1], nodes[nodes.length - 2], { session }, { owner: null, stability: "selected-span" });

  assert.ok(session.events.some((event) => event.type === "compaction/summary"), "the summary record must land");
  assert.ok(session.events.some((event) => event.type === "compaction/end" && event.data.error === undefined), "and the transaction must close cleanly");
  assert.ok(session.surface.nodes.length < nodes.length, "the surface must actually shrink");
  const summary = session.events.find((event) => event.type === "compaction/summary");
  assert.equal("provider" in summary.data, false, "the undefined member is omitted, not committed");
  assert.equal("maxTokens" in summary.data, false, "and so is an undefined cap");
  assert.equal(summary.data.model, "m", "every defined member survives untouched");
  assert.equal(result.summarySeq, summary.seq);
});

// ── R9: the leaf cap bounds PRESSURE leaves, never overflow recovery ─────────

/** A priced measurement over the fixture's real folded surface. */
function measurementOf(session, each) {
  const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: each, heuristicTokens: each }));
  return { nodes, totalTokens: nodes.length * each };
}

/** The surface span one selected range covers, priced at `each` per node. */
function spanTokens(session, range, each) {
  const nodes = session.surface.nodes;
  return (nodes.indexOf(range.end) - nodes.indexOf(range.start) + 1) * each;
}

test("overflow recovery is not capped by leafSpanTokens; pressure still is", { skip }, async () => {
  // Measured on a 60 725-token / 81-node session: dsh-compaction-basic selected
  // 59 961 tokens (79 nodes) and landed the request under the window in one pass,
  // while this engine's leaf cap (24 000) held it to 24 288 tokens (32 nodes). With
  // the default maxOverflowRetries of 1, that recovery can hand the provider a
  // request that is STILL over the window where the reference backend would fit.
  // The cap exists so a PRESSURE compaction produces bounded leaves that condense
  // into a DAG; an overflow recovery is not that case, it must remove whatever the
  // measurement needs.
  const { default: Engine } = await import("../src/index.js");
  const { resolveConfig } = await import("../src/config.js");
  const EACH = 4_000;
  const session = makeSession(plainEvents(20)); // 41 surface nodes, 164 000 tokens
  const measurement = measurementOf(session, EACH);
  const config = resolveConfig({});
  const unlimited = selectCompactableRange(session, measurement, 0, config.summaryFloorTokens, 0, config.condensationFanin);
  const capped = selectCompactableRange(session, measurement, 0, config.summaryFloorTokens, config.leafSpanTokens, config.condensationFanin);
  assert.ok(unlimited !== null && capped !== null);
  assert.ok(spanTokens(session, capped, EACH) <= config.leafSpanTokens + EACH, "the ceiling really binds this fixture");
  assert.ok(spanTokens(session, unlimited, EACH) > config.leafSpanTokens * 2, "and the uncapped span is far larger, so the two are distinguishable");

  /** One prototype-only engine whose compaction is captured, not performed. */
  function captureEngine(overrides = {}) {
    const engine = Object.create(Engine.prototype);
    engine.config = config;
    engine.stallBySession = new Map();
    engine.pressureConfigFaults = new Map();
    engine.compactRegion = async (start, end) => {
      throw Object.assign(new Error("CAPTURED"), { range: { start, end } });
    };
    engine.ctx = {
      tokenMeter: { measure: () => measurement, estimateMessage: () => 10 },
      get: () => undefined,
      ...overrides
    };
    return engine;
  }

  const agent = { session, options: {} };

  // Overflow: the whole compactable prefix, exactly the selector's uncapped result.
  const overflow = captureEngine();
  await assert.rejects(overflow.compactIfNeeded(agent, "context-overflow", undefined), (error) => {
    assert.deepEqual(error.range, unlimited, "overflow must select without the pressure leaf cap");
    assert.ok(spanTokens(session, error.range, EACH) > config.leafSpanTokens, "so it can remove more than one leaf's worth");
    return true;
  });

  // Pressure: unchanged. Same window, same retain policy, and the leaf cap binds.
  const pressure = captureEngine({
    llm: { async resolveModelInfo() { return { context: { contextWindow: 200_000 }, defaultMaxTokens: 4096 }; } }
  });
  await assert.rejects(pressure.compactPressure(agent, agent.session.requestHeader(), undefined, false), (error) => {
    assert.deepEqual(error.range, capped, "the pressure path keeps the leaf cap it has today");
    return true;
  });
});
