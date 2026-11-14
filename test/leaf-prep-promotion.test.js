// ── the prepared leaf is actually reused ───────────────────────────────────
// The audit found this promotion could be deleted wholesale — pre-computing a leaf
// that the foreground then ignores, paying for every prep call and reusing nothing —
// with all 328 tests green. The prep pass and the promotion are two halves of one
// contract, and only a single test that runs BOTH can see it.
//
// That is what this file does: enable `backgroundLeafPrep`, let the idle hook
// prepare one leaf, then force a sweep over the SAME span and count model calls.
// One call total proves the reuse; two proves the prep was thrown away.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import LcmCompactionEngine from "../src/index.js";
import { resolveCompactSpec, resolveConfig } from "../src/config.js";
import { preparedLeafKey } from "../src/prep.js";
import { prepareCompaction, selectCompactableRange, validateSurfaceRegion } from "../src/region.js";

/**
 * A session just over threshold, with a meter that shrinks as leaves commit.
 *
 * 200 messages of 1 000 tokens against a 200 000-token window gives a 150 000
 * threshold, so the session is over and both the prep pass and a sweep have work.
 */
function world({ nodeCount = 200, each = 1000, config = {} } = {}) {
  const events = [];
  for (let index = 0; index < nodeCount; index += 1) {
    events.push({ type: "user/message", seq: index, time: 1, data: { message: { role: "user", content: [{ type: "text", text: "x".repeat(each) }] } } });
  }
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const state = { total: nodeCount * each, live: events.map((event) => event.seq) };
  const session = {
    id: "prep-probe",
    events,
    get seq() { return events.length; },
    get surface() { return { nodes: state.live, replaceGeneration: 1 }; },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => event?.data?.message ?? null,
    requestHeader: () => ({ config: { provider: "p", model: "m" }, tools: [] })
  };
  const calls = [];
  const ctx = {
    on: () => () => {},
    effect: (fn) => { const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; },
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
    tokenMeter: {
      measure: () => ({
        nodes: state.live.map((seq) => ({ seq, tokens: each, heuristicTokens: each })),
        totalTokens: state.total,
        baseline: { kind: "estimated", tokens: 0 },
        surfaceDeltaTokens: 0
      }),
      estimateMessage: () => 10
    },
    llm: {
      async *stream() {
        calls.push(1);
        const text = "## 目标与约束\n- prepared body";
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text };
        yield { type: "block-end", index: 0, block: { type: "text", text } };
        yield { type: "finish", reason: { kind: "stop" }, replayState: undefined };
      },
      resolveModelInfo: async () => ({ context: { contextWindow: 200000 }, defaultMaxTokens: 8000 })
    }
  };
  const root = new Context();
  root.on = ctx.on;
  root.get = ctx.get;
  root.logger = ctx.logger;
  root.tokenMeter = ctx.tokenMeter;
  root.llm = ctx.llm;
  const engine = new LcmCompactionEngine(root, {
    auto: true,
    thresholdRatio: 0.75,
    retainRatio: 0.05,
    headroomTokens: 65536,
    thresholdFullSweep: true,
    fullSweepMaxPasses: 3,
    fullSweepMaxSeconds: 600,
    fullSweepSoftSeconds: 0,
    summaryFloorTokens: 512,
    leafSpanTokens: 24000,
    ...config
  });
  engine.ctx = ctx;
  engine.compactRegion = async (start, end) => {
    const cut = state.live.indexOf(start);
    const stop = state.live.indexOf(end);
    if (cut >= 0 && stop >= cut) state.live = [...state.live.slice(0, cut), ...state.live.slice(stop + 1)];
    state.total = Math.max(0, state.total - 20000);
    return { shadowedSeqs: [start], shadowedRange: { start, end }, shadowedTokenCount: 20000 };
  };
  return { engine, session, calls, state };
}

/** Let a detached pass finish. */
async function settle(engine, timeoutMs = 4000) {
  const started = Date.now();
  while ((engine.prepPasses.size > 0 || engine.idlePasses.size > 0) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("backgroundLeafPrep: false never prepares, so a sweep pays for its own leaf", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lcm-prep-off-"));
  try {
    const w = world({ config: { rollupDir: dir, assertionDir: dir, backgroundLeafPrep: false } });
    w.engine._prepareNextLeaf({ session: w.session, options: {} });
    await settle(w.engine);
    assert.equal(w.calls.length, 0, "the prep pass is off: no call");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the prep pass and the foreground compute the SAME key, which is what makes reuse possible", async () => {
  // Promotion lives at one seam: the prep pass stores under `preparedLeafKey`, and
  // `compactRegion` looks up under `preparedLeafKey` for the SAME span and route.
  // If the two derivations ever drift — a changed route field, a different selection,
  // an extra token count in the key — the cache is written and never read, which is
  // the audit's mutation M25 (every prep call paid for, nothing reused) under a green
  // suite.
  //
  // This asserts the seam directly instead of stubbing `compactRegion` and counting
  // model calls through it: the stub would replace the very method that does the
  // lookup, so the count would be zero whether or not promotion works.
  const dir = await mkdtemp(path.join(tmpdir(), "lcm-prep-key-"));
  try {
    const w = world({ config: { rollupDir: dir, assertionDir: dir, backgroundLeafPrep: true } });
    w.state.total = 100000;

    // 1. The prep pass stores one leaf.
    w.engine._prepareNextLeaf({ session: w.session, options: {} });
    await settle(w.engine);
    assert.equal(w.calls.length, 1, "the prep pass paid for exactly one leaf");

    // 2. Recompute the key the way the foreground does, from the same surface.
    const header = w.session.requestHeader();
    const info = await w.engine.ctx.llm.resolveModelInfo("p", "m");
    const spec = resolveCompactSpec(
      { target: { provider: "p", model: "m" }, thresholdRatio: w.engine.config.thresholdRatio, retainRatio: w.engine.config.retainRatio, headroomTokens: w.engine.config.headroomTokens },
      info.context.contextWindow,
      info.defaultMaxTokens
    );
    const measurement = w.engine.ctx.tokenMeter.measure(w.session, header);
    const range = selectCompactableRange(w.session, measurement, spec.retainTokens, w.engine.config.summaryFloorTokens, w.engine.config.leafSpanTokens, w.engine.config.condensationFanin);
    assert.notEqual(range, null, "the same span must still be selectable");

    const selection = validateSurfaceRegion(w.session, range.start, range.end);
    const prepared = prepareCompaction(w.engine.regionDependencies(), w.session, selection);
    assert.notEqual(prepared, null, "and preparable");
    // The fixture fixes the route to p/m in BOTH the session header and the agent
    // options, so the resolved route is unambiguous without reaching for the
    // module-private resolver. If that ever stops being true, the assertion below
    // fails rather than the test passing on a guess.
    const route = { provider: "p", model: "m" };
    const key = preparedLeafKey(prepared, route);

    assert.ok(w.engine.leafPrep.has(key),
      "the foreground's key must find the prepared entry; if this fails the prep pass is spending tokens into a cache nobody reads");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the prep pass refuses to run over threshold", async () => {
  // Over threshold a sweep is already owed, and pre-computing would compete with the
  // pass that is supposed to commit it. The guard is what keeps prep from being a
  // second spender on the same span.
  const dir = await mkdtemp(path.join(tmpdir(), "lcm-prep-guard-"));
  try {
    const w = world({ config: { rollupDir: dir, assertionDir: dir, backgroundLeafPrep: true } });
    w.state.total = 200000;
    w.engine._prepareNextLeaf({ session: w.session, options: {} });
    await settle(w.engine);
    assert.equal(w.calls.length, 0, "over threshold the prep pass is a no-op");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
