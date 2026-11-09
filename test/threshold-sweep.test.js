/**
 * The threshold full sweep: a crossing condenses until the raw prefix is drained,
 * not until the threshold is merely re-cleared.
 *
 * This is lcm-x's `threshold_full_sweep_enabled` (default True there). The defect it
 * removes was measured on a real 1M-window session: crossing at 807 187 tokens
 * (80.7%) released ONE 24 000-token leaf and landed at 783 136 (78.3%), which is
 * below the 800 000 threshold, so the loop returned. The next crossing released
 * another single leaf. The session sat welded to the threshold, paying a full
 * model call per 2.4% of window and never getting real headroom.
 *
 * lcm-x's semantics are "crossing = sweep": `max_leaf_passes` becomes 12, the loop
 * runs while the raw backlog outside the fresh tail remains, and a sweep that runs
 * out of budget records a PARTIAL stop so the next turn continues rather than
 * reporting a failure.
 *
 * Run with: node --test test/threshold-sweep.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfig } from "../src/config.js";
import { LcmCompactionEngine } from "../src/index.js";

// ── fixtures ───────────────────────────────────────────────────────────────

/**
 * A session-shaped value over alternating user/assistant nodes, priced flat.
 *
 * The pressure pass calls the REAL `selectCompactableRange` against this, so the
 * loop's willingness to keep going is what is under test — not a stubbed selector.
 *
 * @param nodeCount - surface nodes, excluding the system head.
 * @param each - tokens per node.
 * @returns the session plus a meter over it.
 */
function sessionOf(nodeCount, each) {
  // The harness's own tool-pairing fold reads `event.data.message`, so the fixture
  // must use the real event shape rather than a flattened one.
  const events = [{ seq: 0, type: "system/message", data: { message: { role: "system", content: [{ type: "text", text: "sys" }] } } }];
  let seq = 1;
  for (let i = 0; i < nodeCount; i += 1) {
    const role = i % 2 === 0 ? "user" : "assistant";
    events.push({ seq: seq++, type: role === "user" ? "user/message" : "assistant/message", data: { message: { role, content: [{ type: "text", text: "node " + i }] } } });
  }
  let events_ = events.map((e) => ({ ...e }));
  let generation = 1;
  const bySeq = () => new Map(events_.map((e) => [e.seq, e]));
  const session = {
    id: "sweep-test",
    get events() { return events_; },
    get surface() {
      return { nodes: events_.map((e) => e.seq), replaceGeneration: generation };
    },
    eventAt: (s) => bySeq().get(s),
    deriveEventMessage: (e) => e?.data?.message ?? null,
    requestHeader: () => ({ config: { provider: "p", model: "m" }, tools: [] })
  };
  const meter = {
    measure() {
      const nodes = events_.map((e) => ({ seq: e.seq, tokens: each, heuristicTokens: each }));
      return { nodes, totalTokens: nodes.reduce((a, b) => a + b.tokens, 0), baseline: { kind: "estimated", tokens: 0 }, surfaceDeltaTokens: 0 };
    }
  };
  return { session, meter, removeNextLeaf: () => {
    // Drop the oldest non-system nodes, the way a leaf would.
    const keep = events_.filter((e) => e.type === "system/message");
    const rest = events_.filter((e) => e.type !== "system/message");
    const drop = Math.min(4, rest.length);
    events_ = [...keep, ...rest.slice(drop)];
    generation += 1;
  } };
}

/**
 * An engine over that session whose `compactRegion` removes one leaf per call.
 * @param opts - config overrides and the initial surface size.
 * @returns `{ engine, calls }`.
 */
function sweepEngine(opts = {}) {
  const each = opts.each ?? 1000;
  const { session, meter, removeNextLeaf } = sessionOf(opts.nodeCount ?? 200, each);
  const config = resolveConfig({
    leafSpanTokens: 4000,
    retainTokens: 1000,
    thresholdRatio: 0.8,
    thresholdFullSweep: true,
    fullSweepMaxPasses: 12,
    fullSweepMaxSeconds: 120,
    ...(opts.config ?? {})
  });
  const engine = Object.create(LcmCompactionEngine.prototype);
  engine.config = config;
  engine.stallBySession = new Map();
  engine.pressureConfigFaults = new Map();
  engine.overflowRetries = new WeakMap();
  engine.overflowAgents = new WeakMap();
  const calls = [];
  engine.ctx = {
    tokenMeter: meter,
    get: () => undefined,
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: opts.window ?? 400000 }, defaultMaxTokens: 1000 }) }
  };
  engine.compactRegion = async (start, end) => {
    calls.push({ start, end });
    removeNextLeaf();
    return { shadowedSeqs: [start], shadowedTokenCount: each * 4 };
  };
  return { engine, calls, session };
}

/** A minimal agent-shaped value the pressure pass reads from. */
function agentOf(session) {
  return { session, options: { provider: "p", model: "m" } };
}

const HEADER = { config: { provider: "p", model: "m" }, tools: [] };

// ── the sweep ──────────────────────────────────────────────────────────────

test("a crossing keeps condensing after it drops below the threshold", async () => {
  // 200 nodes x 1000 = 200 000 tokens against a 320 000 threshold... so shrink the
  // window instead: threshold = window*0.8. At 400 000 that is 320 000, and the
  // session is below it. Use a window the session CROSSES.
  const { engine, calls, session } = sweepEngine({ nodeCount: 400, window: 400000 });
  // 400 nodes x 1000 = 400 000 tokens >= 320 000 threshold: over.
  const result = await engine.compactPressure(agentOf(session), HEADER, undefined, false);
  assert.ok(result !== null, "the sweep returns the last checkpoint it wrote");
  // One leaf is 4 nodes = 4000 tokens. Dropping from 400k to 320k needs 20 leaves,
  // which exceeds the 12-pass budget, so the budget is what stops it -- and it must
  // release far more than one.
  assert.ok(calls.length > 1, `a sweep releases more than one leaf (released ${calls.length})`);
  assert.equal(calls.length, 12, "and stops at the pass budget, not at the first leaf below the threshold");
});

test("the sweep stops at its pass budget and reports a partial, not a failure", async () => {
  const { engine, calls, session } = sweepEngine({ nodeCount: 400, window: 400000, config: { fullSweepMaxPasses: 3 } });
  const result = await engine.compactPressure(agentOf(session), HEADER, undefined, false);
  assert.equal(calls.length, 3, "exactly the pass budget");
  assert.ok(result !== null, "a budget stop is partial progress, not a thrown failure");
});

test("one leaf is released when the sweep is off", async () => {
  // 322 nodes x 1000 = 322 000 against a 320 000 threshold: one 4-node leaf (4 000)
  // lands at 318 000, strictly below the line. The historical loop returns right
  // there. (323 would not: 319 000 is below too, but the equality case matters —
  // the loop's test is `< threshold`, so a leaf landing exactly on the threshold
  // does not stop it.)
  const { engine, calls, session } = sweepEngine({ nodeCount: 322, window: 400000, config: { thresholdFullSweep: false } });
  const result = await engine.compactPressure(agentOf(session), HEADER, undefined, false);
  assert.ok(result !== null);
  assert.equal(calls.length, 1, "the historical one-leaf-per-crossing behaviour is the fallback");
});

test("when the sweep is off, the retry budget is what runs out, and it fails loud", async () => {
  // Same shape as the defect, sweep disabled: every leaf stays above the threshold,
  // so the loop spends compactionRetries+1 attempts and then reports, rather than
  // silently returning as if it had succeeded.
  const { engine, calls, session } = sweepEngine({ nodeCount: 400, window: 400000, config: { thresholdFullSweep: false, compactionRetries: 1 } });
  await assert.rejects(
    engine.compactPressure(agentOf(session), HEADER, undefined, false),
    /still above threshold after 2 compaction attempts/u
  );
  assert.equal(calls.length, 2, "compactionRetries 1 means two attempts, not a sweep");
});

test("the sweep's time budget stops it even with passes left", async () => {
  const { engine, session } = sweepEngine({ nodeCount: 400, window: 400000, config: { fullSweepMaxPasses: 12, fullSweepMaxSeconds: 1 } });
  const original = engine.compactRegion;
  let released = 0;
  engine.compactRegion = async (start, end) => {
    released += 1;
    const until = Date.now() + 400;
    while (Date.now() < until) { /* burn 400ms per pass */ }
    return original(start, end);
  };
  const result = await engine.compactPressure(agentOf(session), HEADER, undefined, false);
  assert.ok(result !== null, "a time-budget stop is partial progress");
  assert.ok(released < 12, `the wall clock stops it before the pass budget (released ${released})`);
});

// ── the configuration surface ──────────────────────────────────────────────

test("the sweep is on by default, like lcm-x", () => {
  const config = resolveConfig({});
  assert.equal(config.thresholdFullSweep, true, "lcm-x's threshold_full_sweep_enabled defaults True");
  assert.equal(config.fullSweepMaxPasses, 12, "lcm-x's _THRESHOLD_FULL_SWEEP_MAX_PASSES");
  assert.equal(config.fullSweepMaxSeconds, 120, "lcm-x's _THRESHOLD_FULL_SWEEP_MAX_SECONDS");
});

test("the sweep keys are typed identically in both configuration layers", () => {
  const cases = [["thresholdFullSweep", "no"], ["fullSweepMaxPasses", 1.5], ["fullSweepMaxSeconds", 0]];
  for (const [key, bad] of cases) {
    assert.throws(() => resolveConfig({ [key]: bad }), new RegExp(key, "u"), `config.js must refuse ${key}=${JSON.stringify(bad)}`);
    assert.throws(() => LcmCompactionEngine.Config({ [key]: bad }), `the composition schema must refuse ${key}=${JSON.stringify(bad)} too`);
  }
});
