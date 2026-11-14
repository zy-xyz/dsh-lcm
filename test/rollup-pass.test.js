// ── the rollup pass, driven end to end ─────────────────────────────────────
// The audit found the pass had NO test that called it: `_maintainRollups`
// appeared zero times under test/, and every related file tested a helper
// (`sessionEvents`, `summarizeLeaf`, `isChronology`) instead of the caller. Two
// shipped bugs lived in that gap — a real Session has no `events` property, and a
// checkpoint seq is not a message event — and both could be reintroduced with all
// 328 tests green.
//
// So these tests drive the pass with the shape the harness actually hands it:
// `{ status, agent }` where the agent's session exposes `snapshotEvents()` only.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import LcmCompactionEngine from "../src/index.js";
import { resolveConfig } from "../src/config.js";
import { pendingRollups, planDayRollups, readRollups } from "../src/rollup.js";

const DAY = 86400000;
const T0 = Date.parse("2026-11-13T10:00:00Z");

function checkpoint(seq, time, text) {
  return { type: "compaction/summary", seq, time, data: { summary: [{ type: "text", text }] } };
}

/**
 * A session shaped like a real dsh Session: `snapshotEvents()`, no `events`.
 * That absence is the point — it is what made the pass a silent no-op in
 * production while every fixture-based test passed.
 */
function realShapeSession(events) {
  const frozen = Object.freeze(events.slice());
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  return {
    id: "rollup-pass-probe",
    snapshotEvents: () => frozen,
    get seq() { return events.length; },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => event?.data?.message ?? null,
    requestHeader: () => ({ config: { provider: "p", model: "m" }, tools: [] })
  };
}

/**
 * An engine whose llm answers with whatever `answer` returns, recording each call.
 * The recording is how a test proves the model was REACHED, which is the half the
 * old tests never checked.
 */
function engineWith(answer, config = {}) {
  const calls = [];
  const engine = Object.create(LcmCompactionEngine.prototype);
  engine.config = resolveConfig({ rollupBuildsPerPass: 2, ...config });
  engine.ctx = {
    llm: {
      async *stream(options) {
        calls.push(options);
        const text = typeof answer === "function" ? answer(calls.length - 1) : answer;
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text };
        yield { type: "block-end", index: 0, block: { type: "text", text } };
        yield { type: "finish", reason: { kind: "stop" }, replayState: undefined };
      },
      resolveModelInfo: async () => ({ context: { contextWindow: 1000000 }, defaultMaxTokens: 65536 })
    },
    tokenMeter: { measure: () => ({ nodes: [], totalTokens: 0 }), estimateMessage: () => 10 },
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} }
  };
  engine.rollupPasses = new Set();
  engine.assertionPasses = new Set();
  engine.prepPasses = new Set();
  engine.idlePasses = new Set();
  engine.stallBySession = new Map();
  engine.leafPrep = { hasCapacity: true, has: () => false, take: () => undefined, put: () => {}, describe: () => "" };
  return { engine, calls };
}

/** Poll until the detached pass settles, so a test never races its own assertion. */
async function settle(engine, timeoutMs = 3000) {
  const started = Date.now();
  while (engine.rollupPasses.size > 0 && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("the pass calls the model once per day and stores the chronology", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lcm-rollup-pass-"));
  try {
    const events = [checkpoint(5, T0, "## built the thing\n- detail"), checkpoint(6, T0 + 60_000, "## and more")];
    const session = realShapeSession(events);
    const { engine, calls } = engineWith("(seq 5) built the thing\n(seq 6) and more", { rollupDir: dir });

    engine._maintainRollups({ session });
    await settle(engine);

    assert.equal(calls.length, 1, "one day, one call — the model was actually reached");
    const stored = readRollups(dir, session.id);
    assert.equal(stored.length, 1, "and the day was written");
    assert.equal(stored[0].periodStart, "2026-11-13");
    assert.deepEqual(stored[0].seqs, [5, 6], "both checkpoints of that day are cited");

    // The body has to reach the prompt, not merely be accepted by the helper.
    const sent = JSON.stringify(calls[0].messages);
    assert.match(sent, /built the thing/u, "the checkpoint body travelled as a document");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a body that is not a chronology is not stored, and the day stays owed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lcm-rollup-reject-"));
  try {
    const events = [checkpoint(5, T0, "## built the thing")];
    const session = realShapeSession(events);
    // The exact body that shipped as a 14-token rollup.
    const { engine, calls } = engineWith("I'll start by locating the checkpoint bodies.", { rollupDir: dir });

    engine._maintainRollups({ session });
    await settle(engine);

    assert.equal(calls.length, 1, "the call happened");
    assert.equal(readRollups(dir, session.id).length, 0, "and its prose was refused");
    const owed = pendingRollups(planDayRollups(events), readRollups(dir, session.id));
    assert.equal(owed.length, 1, "so the day is still pending, not silently marked done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a refused day is retried on the next idle", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lcm-rollup-retry-"));
  try {
    const events = [checkpoint(5, T0, "## built the thing")];
    const session = realShapeSession(events);
    // First answer is prose, second is a chronology.
    const { engine, calls } = engineWith((index) => (index === 0
      ? "I'll start by locating the checkpoint bodies."
      : "(seq 5) built the thing"), { rollupDir: dir });

    engine._maintainRollups({ session });
    await settle(engine);
    assert.equal(readRollups(dir, session.id).length, 0, "the first answer was refused");

    engine._maintainRollups({ session });
    await settle(engine);
    assert.equal(calls.length, 2, "the retry paid for a second call");
    assert.equal(readRollups(dir, session.id).length, 1, "and this one landed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("temporalRollups: false makes the pass a true no-op", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lcm-rollup-off-"));
  try {
    const session = realShapeSession([checkpoint(5, T0, "## built the thing")]);
    const { engine, calls } = engineWith("(seq 5) built the thing", { rollupDir: dir, temporalRollups: false });

    engine._maintainRollups({ session });
    await settle(engine);

    assert.equal(calls.length, 0, "the switch is honoured before any call");
    assert.equal(readRollups(dir, session.id).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rollupBuildsPerPass bounds one idle, and the next idle continues", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lcm-rollup-budget-"));
  try {
    // Two distinct UTC days, one build per pass.
    const events = [checkpoint(5, T0, "## day one"), checkpoint(6, T0 + DAY, "## day two")];
    const session = realShapeSession(events);
    const { engine, calls } = engineWith("(seq 5) day one", { rollupDir: dir, rollupBuildsPerPass: 1 });

    engine._maintainRollups({ session });
    await settle(engine);
    assert.equal(calls.length, 1, "the per-pass budget stopped it at one");
    assert.equal(readRollups(dir, session.id).length, 1);

    engine._maintainRollups({ session });
    await settle(engine);
    assert.equal(calls.length, 2, "the second idle built the other day");
    assert.equal(readRollups(dir, session.id).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a session with no checkpoints costs nothing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lcm-rollup-empty-"));
  try {
    const session = realShapeSession([{ type: "user/message", seq: 1, time: T0, data: {} }]);
    const { engine, calls } = engineWith("(seq 1) nothing", { rollupDir: dir });
    engine._maintainRollups({ session });
    await settle(engine);
    assert.equal(calls.length, 0, "no checkpoint, no call");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
