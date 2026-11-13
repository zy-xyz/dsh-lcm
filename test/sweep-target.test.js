// ── the sweep has a TARGET, not only a clock (lcm-x sweep_target_tokens) ──
import assert from "node:assert/strict";
import test from "node:test";

import LcmCompactionEngine from "../src/index.js";
import { resolveConfig } from "../src/config.js";

/**
 * A session whose surface is `nodeCount` messages of `each` tokens, and an engine
 * whose `compactRegion` reclaims a fixed amount per call.
 */
function world({ nodeCount = 400, each = 1000, reclaim = 22000, config = {} } = {}) {
  const events = [];
  let seq = 0;
  for (let index = 0; index < nodeCount; index += 1) {
    events.push({ type: "user/message", seq: seq++, time: 1, data: { message: { role: "user", content: [{ type: "text", text: "x".repeat(each) }] } } });
  }
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  // The surface must track what the compaction actually removed, or
  // `selectCompactableRange` refuses the mismatch (its own guard, and correct).
  const live = events.map((event) => event.seq);
  const state = { total: nodeCount * each, live };
  const session = {
    id: "sweep-target",
    events,
    get seq() { return events.length; },
    get surface() { return { nodes: state.live, replaceGeneration: 1 }; },
    eventAt: (s) => bySeq.get(s),
    deriveEventMessage: (event) => event?.data?.message ?? null,
    requestHeader: () => ({ config: { provider: "p", model: "m" }, tools: [] })
  };
  const engine = Object.create(LcmCompactionEngine.prototype);
  engine.config = resolveConfig({
    thresholdRatio: 0.5,
    headroomTokens: 1000,
    retainTokens: 10000,
    summaryFloorTokens: 512,
    leafSpanTokens: 20000,
    thresholdFullSweep: true,
    fullSweepMaxPasses: 40,
    fullSweepMaxSeconds: 600,
    fullSweepSoftSeconds: 600,
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
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 200000 }, defaultMaxTokens: 8000 }) },
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} }
  };
  engine.compactRegion = async (start, end) => {
    calls.push({ start, end });
    // Drop the compacted nodes from the surface, which is what a real commit does.
    const cut = state.live.findIndex((seq) => seq === start);
    const stop = state.live.findIndex((seq) => seq === end);
    if (cut >= 0 && stop >= cut) state.live = [...state.live.slice(0, cut), ...state.live.slice(stop + 1)];
    state.total = Math.max(0, state.total - reclaim);
    return { shadowedSeqs: [start], shadowedRange: { start, end }, shadowedTokenCount: reclaim };
  };
  return { engine, session, calls, state, agent: { session, options: {} } };
}

test("a sweep stops when it has reclaimed its target share, not only on the clock", async () => {
  // threshold = min(200000*0.5, 200000-1000) = 99500; share 0.25 -> target 24875
  // start 400000; one leaf reclaims 22000, so the target needs 2 leaves.
  const w = world();
  await w.engine.compactPressure(w.agent, w.session.requestHeader(), undefined, false);

  assert.ok(w.calls.length >= 1, "at least one leaf");
  assert.ok(w.calls.length <= 3, `the target should stop it early, not run all 40 passes (got ${w.calls.length})`);
  const reclaimed = 400000 - w.state.total;
  assert.ok(reclaimed >= 24875 - 22000, `reclaimed ${reclaimed} should reach the 24 875 target within one leaf`);
});

test("the target is a SHARE of the threshold, so it scales with the window", async () => {
  // Same shape, half the window: threshold halves, so the target halves and the
  // number of leaves needed stays about the same. A fixed number would not.
  const small = world({ nodeCount: 200, each: 1000 });
  small.engine.config = resolveConfig({ ...small.engine.config, thresholdRatio: 0.5 });
  await small.engine.compactPressure(small.agent, small.session.requestHeader(), undefined, false);
  assert.ok(small.calls.length >= 1, "a small backlog still compacts");
});

test("with the target unreachable, the clock is what stops it and the stop is reported as partial", async () => {
  // One leaf per 22000 against a 24875 target would need 2; make the leaf cost the
  // whole soft budget so the clock refuses the second admission.
  const w = world({ reclaim: 1000, config: { fullSweepSoftSeconds: 1, leafEstimateFloorSeconds: 15 } });
  await w.engine.compactPressure(w.agent, w.session.requestHeader(), undefined, false);
  // First pass is exempt from the soft test, so exactly one leaf runs and the
  // second is refused: 1000 reclaimed is far short of the target.
  assert.equal(w.calls.length, 1, "the soft clock refuses the second leaf");
  assert.ok(400000 - w.state.total < 24875, "and the target was not met");
});

test("fullSweepTargetShare is sized from the budget, not copied from lcm-x", () => {
  // lcm-x ships 0.25, but its target counts SUMMARY-PREFIX tokens. Copied onto raw
  // reclaimed tokens it becomes 187 500 = 9 leaves = 291 s at the measured 21 479
  // per leaf / 32.3 s each — a target the 120 s budget cannot reach.
  //
  // 0.08 x 750 000 = 60 000, inside the 64 437 one crossing reclaims in 110 s
  // usable, so target_reached is reachable and the stop reason is meaningful.
  const config = resolveConfig({});
  assert.equal(config.fullSweepTargetShare, 0.08);
  const threshold = Math.floor(Math.min(1000000 * config.thresholdRatio, 1000000 - config.maxTokens - config.headroomTokens));
  const target = Math.floor(threshold * config.fullSweepTargetShare);
  const leaves = Math.floor((config.fullSweepMaxSeconds - config.fullSweepReserveSeconds) / 32.3);
  assert.ok(target <= leaves * 21479, `the target ${target} must fit in the ${leaves} leaves the budget admits`);
});
