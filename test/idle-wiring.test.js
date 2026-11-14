// ── the idle wiring ───────────────────────────────────────────────────────
// The audit found `_maintainRollups` / `_extractAssertions` / `_prepareNextLeaf`
// never appeared under test/, and deleting the `agent/status` line that calls any
// of them left all 328 tests green (mutation M16). The passes worked; nothing
// proved they were connected.
//
// This file drives `apply()` and dispatches the real event payload the harness
// sends — `{ status, agent }` — then asserts the guard each pass takes. A guard is
// the one externally visible fact a detached pass leaves behind.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import LcmCompactionEngine from "../src/index.js";
import { resolveConfig } from "../src/config.js";

const T0 = Date.parse("2026-11-13T10:00:00Z");

function checkpoint(seq, time, text) {
  return { type: "compaction/summary", seq, time, data: { summary: [{ type: "text", text }] } };
}

function sessionShape() {
  const events = [checkpoint(5, T0, "## built the thing")];
  const frozen = Object.freeze(events.slice());
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  return {
    id: "wiring-probe",
    snapshotEvents: () => frozen,
    get seq() { return events.length; },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => event?.data?.message ?? null,
    requestHeader: () => ({ config: { provider: "p", model: "m" }, tools: [] })
  };
}

/**
 * A context just real enough for `apply()`: it records listeners, and every
 * service the engine reaches for is a stub. `llm.stream` blocks on a promise so a
 * test can observe a pass while it is still in flight.
 */
function harness(config) {
  const listeners = new Map();
  const calls = [];
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = {
    on(event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    },
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
    tokenMeter: { measure: () => ({ nodes: [], totalTokens: 0, baseline: { kind: "estimated", tokens: 0 }, surfaceDeltaTokens: 0 }), estimateMessage: () => 10 },
    llm: {
      async *stream(options) {
        calls.push(options);
        await gate;
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "(seq 5) built the thing" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "(seq 5) built the thing" } };
        yield { type: "finish", reason: { kind: "stop" }, replayState: undefined };
      },
      resolveModelInfo: async () => ({ context: { contextWindow: 1000000 }, defaultMaxTokens: 65536 })
    }
  };
  // A real `Context`: the engine extends cordis' Service, whose constructor calls
  // `ctx.reflect.provide`. Faking that would test a different constructor than the
  // one the host runs. `auto: true` is what makes `_syncAuto` register the listeners,
  // so the wiring under test is the wiring production gets.
  const root = new Context();
  root.on = (event, handler) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  };
  root.get = () => undefined;
  root.logger = { info: () => {}, warn: () => {} };
  root.tokenMeter = ctx.tokenMeter;
  root.llm = ctx.llm;
  const engine = new LcmCompactionEngine(root, { auto: true, temporalRollups: true, ...config });
  engine.leafPrep = { hasCapacity: true, has: () => false, take: () => undefined, put: () => {}, describe: () => "" };
  return { engine, listeners, calls, release };
}

/**
 * A directory private to one test.
 *
 * The first version of this file pointed every test at a fixed `/tmp` path, and the
 * second run then saw a rollup already built for that day, took the "nothing
 * pending" early return, and failed on a guard that was correctly never taken. A
 * test that passes once and fails on a rerun is not a test.
 */async function scratch() {
  return mkdtemp(path.join(tmpdir(), "lcm-wiring-"));
}

test("going idle starts the rollup pass", async () => {
  const dir = await scratch();
  const { engine, listeners, calls, release } = harness({ rollupDir: dir });
  const session = sessionShape();
  const handler = listeners.get("agent/status");
  assert.equal(typeof handler, "function", "apply() must subscribe to agent/status");

  handler({ status: "idle", agent: { session, options: {} } });
  // The pass is detached, so the guard is the observable proof it started.
  assert.equal(engine.rollupPasses.size, 1, "the rollup guard was taken");

  release();
  const started = Date.now();
  while (engine.rollupPasses.size > 0 && Date.now() - started < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(engine.rollupPasses.size, 0, "and released once it settled");
  assert.equal(calls.length, 1, "one model call was made");
  await rm(dir, { recursive: true, force: true });
});

test("a non-idle status starts nothing", async () => {
  const dir = await scratch();
  const { engine, listeners } = harness({ rollupDir: dir });
  const session = sessionShape();
  const handler = listeners.get("agent/status");
  handler({ status: "running", agent: { session, options: {} } });
  assert.equal(engine.rollupPasses.size, 0, "running is not the trigger");
  assert.equal(engine.idlePasses.size, 0);
  assert.equal(engine.prepPasses.size, 0);
  await rm(dir, { recursive: true, force: true });
});

test("the assertion pass is wired too, and stays off by default", async () => {
  const dir = await scratch();
  const off = harness({ assertionDir: dir });
  const session = sessionShape();
  off.listeners.get("agent/status")({ status: "idle", agent: { session, options: {} } });
  assert.equal(off.engine.assertionPasses.size, 0, "assertionExtraction defaults false: no pass");

  const on = harness({ assertionDir: dir, assertionExtraction: true });
  on.listeners.get("agent/status")({ status: "idle", agent: { session: sessionShape(), options: {} } });
  assert.equal(on.engine.assertionPasses.size, 1, "switched on, it runs");
  on.release();
  await rm(dir, { recursive: true, force: true });
});

test("the leaf-prep pass runs only under threshold and only when enabled", async () => {
  const dir = await scratch();
  const off = harness({ backgroundLeafPrep: false, rollupDir: dir, assertionDir: dir });
  off.listeners.get("agent/status")({ status: "idle", agent: { session: sessionShape(), options: {} } });
  assert.equal(off.engine.prepPasses.size, 0, "off by default");

  const on = harness({ backgroundLeafPrep: true, rollupDir: dir, assertionDir: dir });
  on.listeners.get("agent/status")({ status: "idle", agent: { session: sessionShape(), options: {} } });
  assert.equal(on.engine.prepPasses.size, 1, "enabled, it takes its guard");
  on.release();
  await rm(dir, { recursive: true, force: true });
});
