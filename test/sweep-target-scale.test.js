// ── the target scales with the window, exactly ─────────────────────────────
// The audit found this property untested: replacing the target with the constant
// 24 875 left `sweep-target.test.js` 4/4 green, because that file asserts only
// "at least one leaf" and its "half-window" fixture never changes the window.
//
// So this file asserts the NUMBER of leaves, computed independently from
// `resolveCompactSpec` — the same function the engine prices pressure with — and
// checks it at two window sizes that must differ.
import assert from "node:assert/strict";
import test from "node:test";

import LcmCompactionEngine from "../src/index.js";
import { resolveCompactSpec, resolveConfig } from "../src/config.js";

/**
   * An engine over a session of `nodeCount` messages and a meter that shrinks by
   * `reclaim` per committed leaf.
   */
function sweepWorld({ nodeCount, each, window, reclaim = 22000, config = {} }) {
  const events = [];
  for (let index = 0; index < nodeCount; index += 1) {
    events.push({ type: "user/message", seq: index, time: 1, data: { message: { role: "user", content: [{ type: "text", text: "x".repeat(each) }] } } });
  }
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const state = { total: nodeCount * each, live: events.map((event) => event.seq) };
  const session = {
    id: "scale-probe",
    events,
    get seq() { return events.length; },
    get surface() { return { nodes: state.live, replaceGeneration: 1 }; },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => event?.data?.message ?? null,
    requestHeader: () => ({ config: { provider: "p", model: "m" }, tools: [] })
  };
  const engine = Object.create(LcmCompactionEngine.prototype);
  engine.config = resolveConfig({
    thresholdRatio: 0.75,
    retainRatio: 0.05,
    headroomTokens: 65536,
    thresholdFullSweep: true,
    fullSweepMaxPasses: 60,
    fullSweepMaxSeconds: 600,
    fullSweepSoftSeconds: 0,
    summaryFloorTokens: 2000,
    leafSpanTokens: 24000,
    ...config
  });
  engine.stallBySession = new Map();
  engine.pressureConfigFaults = new Map();
  engine.overflowRetries = new WeakMap();
  engine.overflowAgents = new WeakMap();
  const calls = [];
  engine.ctx = {
    tokenMeter: {
      measure: () => ({
        nodes: state.live.map((seq) => ({ seq, tokens: each, heuristicTokens: each })),
        totalTokens: state.total,
        baseline: { kind: "estimated", tokens: 0 },
        surfaceDeltaTokens: 0
      }),
      estimateMessage: () => 10
    },
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: window }, defaultMaxTokens: 8000 }) },
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} }
  };
  engine.compactRegion = async (start, end) => {
    calls.push({ start, end });
    const cut = state.live.indexOf(start);
    const stop = state.live.indexOf(end);
    if (cut >= 0 && stop >= cut) state.live = [...state.live.slice(0, cut), ...state.live.slice(stop + 1)];
    state.total = Math.max(0, state.total - reclaim);
    return { shadowedSeqs: [start], shadowedRange: { start, end }, shadowedTokenCount: reclaim };
  };
  return { engine, session, calls, config: engine.config };
}

/**
   * Leaves a sweep must take to reclaim its target, computed from the engine's own
   * pressure arithmetic rather than from the result it produces.
   */
function expectedLeaves(config, window, reclaim) {
  const spec = resolveCompactSpec({
    target: { provider: "p", model: "m" },
    thresholdRatio: config.thresholdRatio,
    retainRatio: config.retainRatio,
    headroomTokens: config.headroomTokens
  }, window, 8000);
  const target = Math.floor(spec.thresholdTokens * config.fullSweepTargetShare);
  return { leaves: Math.ceil(target / reclaim), threshold: spec.thresholdTokens, target };
}

const HEADER = { config: { provider: "p", model: "m" }, tools: [] };
const AGENT = (session) => ({ session, options: {} });

test("a 1M window takes exactly the leaves its target implies", async () => {
  const w = sweepWorld({ nodeCount: 900, each: 1000, window: 1000000 });
  const { leaves, target } = expectedLeaves(w.config, 1000000, 22000);
  assert.ok(target > 0, "the fixture must produce a positive target");

  await w.engine.compactPressure(AGENT(w.session), HEADER, undefined, false);
  assert.equal(w.calls.length, leaves, `expected exactly ${leaves} leaves for a ${target}-token target, took ${w.calls.length}`);
});

test("a 200k window takes fewer leaves than a 1M window for the same reclaim", async () => {
  // The property a constant target cannot satisfy: the target is a SHARE of a
  // threshold that itself scales with the window, so the leaf count must move.
  const small = sweepWorld({ nodeCount: 900, each: 1000, window: 200000 });
  const big = sweepWorld({ nodeCount: 900, each: 1000, window: 1000000 });
  const smallPlan = expectedLeaves(small.config, 200000, 22000);
  const bigPlan = expectedLeaves(big.config, 1000000, 22000);
  assert.notEqual(smallPlan.target, bigPlan.target, "the two windows must have different targets");

  await small.engine.compactPressure(AGENT(small.session), HEADER, undefined, false);
  await big.engine.compactPressure(AGENT(big.session), HEADER, undefined, false);

  assert.equal(small.calls.length, smallPlan.leaves);
  assert.equal(big.calls.length, bigPlan.leaves);
  assert.ok(small.calls.length < big.calls.length,
    `a smaller window must take fewer leaves (${small.calls.length} vs ${big.calls.length})`);
});

test("the leaf count follows the share, not a constant", async () => {
  // Same window, two shares: the leaf count must scale with the share. A hardcoded
  // target passes every other assertion in the suite and fails this one.
  const low = sweepWorld({ nodeCount: 900, each: 1000, window: 1000000, config: { fullSweepTargetShare: 0.04 } });
  const high = sweepWorld({ nodeCount: 900, each: 1000, window: 1000000, config: { fullSweepTargetShare: 0.16 } });

  await low.engine.compactPressure(AGENT(low.session), HEADER, undefined, false);
  await high.engine.compactPressure(AGENT(high.session), HEADER, undefined, false);

  assert.equal(low.calls.length, expectedLeaves(low.config, 1000000, 22000).leaves);
  assert.equal(high.calls.length, expectedLeaves(high.config, 1000000, 22000).leaves);
  assert.ok(high.calls.length > low.calls.length, "4x the share takes more leaves");
});
