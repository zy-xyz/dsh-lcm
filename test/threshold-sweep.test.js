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
    // These tests are about the sweep clocks and the pass budget, not about the
    // span floor. The shipping floor is 2 000 (lcm-x leaf_target_min_tokens), and
    // the selector refuses a span at or below TWICE it — which is exactly this
    // fixture's 4 000-token leaf. Pin the old floor so the fixture keeps measuring
    // what its name says.
    summaryFloorTokens: 512,
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

test("the sweep is on by default, and its clocks are the arithmetic this backend needs", () => {
  const config = resolveConfig({});
  assert.equal(config.thresholdFullSweep, true, "lcm-x's threshold_full_sweep_enabled defaults True");
  assert.equal(config.fullSweepMaxPasses, 12, "lcm-x's _THRESHOLD_FULL_SWEEP_MAX_PASSES");
  // These are NOT lcm-x's numbers, and the difference is measured, not stylistic.
  // lcm-x's 120 s was sized for its own leaf cost and its own target. Here the
  // target is 0.25 x 750 000 = 187 500 tokens, one leaf reclaims ~22 200, so
  // reaching it costs 9 leaves — ~180 s at the measured 19.9 s median.
  assert.equal(config.fullSweepMaxSeconds, 300, "9 median leaves plus one slow one plus the reserve");
  // 0 DISABLES the soft stop, and that is the fix for a measured failure: a 72.9 s
  // leaf against a 60 s soft target ended the sweep after ONE leaf, leaving a
  // 187 500-token target untouched. A clock that can end a sweep before its target
  // is reachable is the binding constraint, not a backstop.
  assert.equal(config.fullSweepSoftSeconds, 0, "0 = bounded by the target and the hard clock only");
  assert.equal(config.fullSweepReserveSeconds, 10, "midpoint of lcm-x's 5..20 finalize reserve");
  // The budget must still be able to hold the leaves the target implies, which is
  // the property the old 120/60 pair silently failed.
  const leavesForTarget = Math.ceil((750000 * config.fullSweepTargetShare) / 22200);
  assert.ok(config.fullSweepMaxSeconds - config.fullSweepReserveSeconds >= leavesForTarget * 19.9,
    `the hard budget must admit the ${leavesForTarget} leaves the target implies`);
  assert.equal(config.leafEstimateFloorSeconds, 15, "lcm-x's _THRESHOLD_FULL_SWEEP_MIN_CALL_SECONDS");
});

test("the sweep keys are typed identically in both configuration layers", () => {
  const cases = [["thresholdFullSweep", "no"], ["fullSweepMaxPasses", 1.5], ["fullSweepMaxSeconds", 0], ["fullSweepSoftSeconds", 0], ["fullSweepReserveSeconds", -1], ["leafEstimateFloorSeconds", 1.5]];
  for (const [key, bad] of cases) {
    assert.throws(() => resolveConfig({ [key]: bad }), new RegExp(key, "u"), `config.js must refuse ${key}=${JSON.stringify(bad)}`);
    assert.throws(() => LcmCompactionEngine.Config({ [key]: bad }), `the composition schema must refuse ${key}=${JSON.stringify(bad)} too`);
  }
});

// ── the idle continuation ──────────────────────────────────────────────────

/**
 * An engine over a session that never drops below the threshold, so only a clock
 * or the idle hook can be what stops a pass.
 * @param opts - `{ softSeconds, hardSeconds, reserveSeconds, leafMs }`.
 * @returns the engine, its session, and live counters.
 */
function idleEngine(opts = {}) {
  const nodes = Array.from({ length: 40 }, (_, i) => ({ seq: i, tokens: 22500, heuristicTokens: 22500 }));
  const events = nodes.map((n, i) => ({
    type: i % 2 === 0 ? "user/message" : "assistant/message",
    seq: n.seq,
    time: 1,
    data: { message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: "n" + i }] } }
  }));
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  // The node list SHRINKS with each leaf, the way a real surface does. Leaving it
  // fixed while only the scalar total drops makes the selector keep finding
  // compactable ranges forever, and the pass then runs to its pass budget.
  const live = nodes.slice();
  const state = { total: 900000, leaves: 0, infos: [] };
  const session = {
    id: "idle-probe",
    events,
    get seq() { return events.length; },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => event?.data?.message ?? null,
    get surface() { return { nodes: live.map((node) => node.seq), replaceGeneration: 1 }; },
    requestHeader: () => ({ config: { provider: "p", model: "m" }, tools: [] })
  };
  const engine = Object.create(LcmCompactionEngine.prototype);
  engine.config = resolveConfig({
    fullSweepMaxPasses: 999,
    fullSweepMaxSeconds: opts.hardSeconds ?? 600,
    fullSweepSoftSeconds: opts.softSeconds ?? 300,
    fullSweepReserveSeconds: opts.reserveSeconds ?? 10,
    leafEstimateFloorSeconds: 1
  });
  engine.stallBySession = new Map();
  engine.pressureConfigFaults = new Map();
  engine.overflowRetries = new WeakMap();
  engine.overflowAgents = new WeakMap();
  engine.idlePasses = new Set();
  engine.ctx = {
    logger: { info: (line) => state.infos.push(line), warn: () => {} },
    tokenMeter: { measure: () => ({ totalTokens: state.total, nodes: live, baseline: { kind: "estimated", tokens: 0 }, surfaceDeltaTokens: 0 }) },
    get: () => undefined,
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1000000 }, defaultMaxTokens: 65536 }) }
  };
  engine.compactRegion = async () => {
    state.leaves += 1;
    await new Promise((resolve) => setTimeout(resolve, opts.leafMs ?? 200));
    // Drop the nodes the leaf consumed, and the tokens they carried, so the next
  };
  return { engine, session, state };
}

test("the idle hook runs one pass, ignores a concurrent second one, and clears its guard", async () => {
  // The soft target deliberately stops a sweep with the session still over
  // threshold. Before the idle hook the only thing that resumed it was the next
  // pre-step — i.e. the operator typing something; lcm-x has no such gap because
  // its corpus maintenance runs in a bounded background pass.
  // Short clocks: this test is about the GUARD, not the budget, and a 600 s sweep
  // over 20 leaves would keep the pass in flight for the whole wait window.
  const { engine, session, state } = idleEngine({ softSeconds: 5, hardSeconds: 5, reserveSeconds: 0, leafMs: 100 });
  const agent = { session, options: { provider: "p", model: "m" } };

  engine._continueOnIdle(agent);
  assert.equal(engine.idlePasses.size, 1, "a pass is in flight");
  engine._continueOnIdle(agent);
  assert.equal(engine.idlePasses.size, 1, "a second idle notification must not start a second pass");

  for (let i = 0; i < 80 && engine.idlePasses.size > 0; i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.equal(engine.idlePasses.size, 0, "the guard releases when the pass ends");
  assert.ok(state.leaves > 0, "the idle pass actually compacted");
  // NOT asserted: the `compaction (idle)` log line. It is written only after a
  // successful COMMIT, and this fixture has no host services (sessions, session
  // store) for the engine to commit through, so the pass always ends in the
  // catch. That the catch swallows it — rather than surfacing an idle failure the
  // operator would have to dismiss — is the behaviour under test, and it is
  // visible in the guard releasing without a throw.
});

test("the idle hook is a no-op under threshold", async () => {
  const { engine, session, state } = idleEngine({ softSeconds: 600, hardSeconds: 600 });
  state.total = 100000;
  engine._continueOnIdle({ session, options: { provider: "p", model: "m" } });
  for (let i = 0; i < 40 && engine.idlePasses.size > 0; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(state.leaves, 0, "no leaf is released below the threshold");
  assert.equal(engine.idlePasses.size, 0, "the guard still releases");
});

test("the hard clock reserves a slice for the finalize", async () => {
  // lcm-x computes usable_deadline = t0 + hard - reserve, because the last leaf
  // still has to commit and re-measure after it returns.
  const { engine, session, state } = idleEngine({ softSeconds: 600, hardSeconds: 4, reserveSeconds: 2, leafMs: 500 });
  const started = Date.now();
  await engine.compactPressure({ session, options: { provider: "p", model: "m" } }, session.requestHeader(), undefined, false);
  const elapsed = Date.now() - started;
  assert.ok(state.leaves <= 4, `the reserve cut the pass short (released ${state.leaves} in ${elapsed} ms)`);
  assert.ok(elapsed < 4000, `and it stayed inside the hard ceiling (${elapsed} ms)`);
});
