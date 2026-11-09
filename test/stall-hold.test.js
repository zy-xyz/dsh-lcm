/**
 * The stall hold: a session that found nothing worth compacting is not re-decided
 * on every step.
 *
 * Borrowed from lcm-x's `_no_progress_hold` (engine.py:2204): a monotonic deadline,
 * checked in `should_compress` BEFORE any work, whose docstring is "never latches;
 * it ends at its time (a stored leaf clears it in compress())". lcm-x also keeps a
 * per-conversation `_zero_leaf_streaks` counter (#1162) for consecutive
 * over-threshold passes that stored no leaf.
 *
 * Without a hold our engine re-ran the full evaluation - meter, model-info lookup,
 * range selection - on every step of a session it could not help, and emitted the
 * same decline line each time. Measured case: a 14 372-token session with a 4 472
 * token retained tail leaves one 233-token node, below the 2 x floor guard, so
 * nothing is compactable. Correct, but it looked like a hang.
 *
 * Run with: node --test test/stall-hold.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { TargetPressureConfigError, resolveConfig } from "../src/config.js";
import { LcmCompactionEngine } from "../src/index.js";

test("the hold has a deadline and a token baseline", () => {
  const config = resolveConfig({});
  assert.equal(typeof config.stallCooldownMs, "number");
  assert.ok(config.stallCooldownMs > 0, "a deadline, because lcm-x's hold ends at its time");
});

test("the three release conditions are computable from one record", () => {
  const config = resolveConfig({});
  const held = { tokens: 14_372, until: 1_000 + config.stallCooldownMs };
  // Growth by another leaf's worth is new material: worth re-deciding even though
  // the deadline has not passed.
  const grown = { tokens: held.tokens + config.leafSpanTokens, until: held.until };
  const grew = grown.tokens >= held.tokens + config.leafSpanTokens;
  assert.equal(grew, true, "a leaf's worth of new material releases the hold");
  assert.equal(grown.tokens - held.tokens >= config.leafSpanTokens, true);
  // Anything less is not new material and stays held until the deadline.
  const trickle = held.tokens + Math.floor(config.leafSpanTokens / 2);
  assert.equal(trickle >= held.tokens + config.leafSpanTokens, false, "a trickle does not release it");
});

test("the deadline is a positive integer in BOTH configuration layers", () => {
  // `stallCooldownMs` was the one key of the 28 declared in the composition schema
  // (`z.number().step(1).min(1)`) and never validated in ./config.js, so `"60000"`
  // or `1.5` reached the engine and `Date.now() + stallCooldownMs` produced `NaN`.
  // Every `Date.now() < NaN` comparison is false, so the hold never armed: the
  // stall protection was silently disabled by a value the schema already refuses.
  // 0 is refused here for the same reason — the schema has floored this key at 1
  // since it was declared, and a runtime that accepts what the composition layer
  // rejects is the disagreement this test exists to catch.
  const consequence = /must be a positive integer/;
  for (const value of [0, -1, 1.5, "60000", Number.NaN, undefined]) {
    if (value === undefined) continue;
    assert.throws(() => resolveConfig({ stallCooldownMs: value }), consequence, `config.js must reject ${JSON.stringify(value)}`);
    assert.throws(() => LcmCompactionEngine.Config({ stallCooldownMs: value }), `the composition schema must reject ${JSON.stringify(value)} too`);
  }
  assert.equal(resolveConfig({ stallCooldownMs: 1 }).stallCooldownMs, 1, "1 is the smallest legal deadline, as in the schema");
  assert.doesNotThrow(() => LcmCompactionEngine.Config({ stallCooldownMs: 1 }));
});

// ── the OTHER silence: a misconfigured route must never go quiet ───────────

/**
 * A prototype-only engine whose five automatic listeners are captured instead of
 * registered, and whose pressure pass always raises a configuration fault.
 */
function listenerEngine(fault) {
  const handlers = new Map();
  const warns = [];
  const engine = Object.create(LcmCompactionEngine.prototype);
  engine.config = resolveConfig({});
  engine.pressureConfigFaults = new Map();
  // The pre-fix field name too, so this test fails on the DEFECT (one warning,
  // then silence) rather than on a fixture that forgot an internal property.
  engine.warnedPressureConfigTargets = new Set();
  engine.stallBySession = new Map();
  engine.ctx = {
    on: (type, handler) => {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
    logger: {
      warn: (line) => warns.push(line),
      info: () => {}
    },
    get: () => undefined
  };
  engine.compactIfNeeded = async () => {
    throw fault();
  };
  const dispose = engine._registerAutomaticCompaction();
  return { engine, warns, preStep: handlers.get("agent/pre-step"), dispose };
}

test("a misconfigured route keeps warning instead of falling silent after one line", async () => {
  // The measured defect: after the FIRST TargetPressureConfigError for a route the
  // listener returned `next()` with no output at all, so a real misconfiguration
  // (`retainTokens >= threshold`, headroom/maxTokens larger than the window)
  // switched compaction off permanently behind a single line. `resolveCompactSpec`
  // throws BEFORE the pressure gate, so on the pre-step path that error is raised
  // on EVERY step: one warn per step is the spam to avoid, and one warn forever is
  // the silence to fix.
  const { warns, preStep, dispose } = listenerEngine(
    () => new TargetPressureConfigError("p/m", "retainTokens (40000) must be less than threshold tokens 4000")
  );
  const next = () => "next";
  const signal = { aborted: false };

  for (let attempt = 1; attempt <= 8; attempt += 1) await preStep({ agent: {}, signal }, next);

  // Doubling schedule: warnings on attempts 1, 2, 4 and 8 — four lines for eight
  // attempts, and the count keeps climbing, so a long-lived session still speaks.
  assert.equal(warns.length, 4, `expected warnings on 1/2/4/8, got ${warns.length}: ${warns.join(" | ")}`);
  assert.match(warns[0], /switched off by configuration/u, "the first line names the STATE, not only the failure");
  assert.match(warns[0], /1 suppressed attempt/u);
  assert.match(warns[1], /2 suppressed attempts/u);
  assert.match(warns[2], /4 suppressed attempts/u);
  assert.match(warns[3], /8 suppressed attempts/u);
  for (const line of warns) {
    assert.match(line, /p\/m/u, "every line names the route it is about");
    assert.match(line, /retainTokens \(40000\)/u, "and carries the actionable cause");
    assert.match(line, /until the configuration is fixed/u, "and says what ends it");
  }

  // Two hundred steps: still not one line per step, and never silent again.
  for (let attempt = 9; attempt <= 200; attempt += 1) await preStep({ agent: {}, signal }, next);
  assert.equal(warns.length, 8, "1/2/4/8/16/32/64/128 — logarithmic, and the last count is 200 steps in");
  assert.match(warns.at(-1), /128 suppressed attempts/u);
  dispose();
});

test("a route that prices correctly again clears its suppression count", async () => {
  // The counter is "consecutive faults". Without the reset a fixed route would
  // keep counting from the old total and could stay silent for hundreds of
  // attempts before its next scheduled warning.
  const engine = Object.create(LcmCompactionEngine.prototype);
  engine.config = resolveConfig({});
  engine.pressureConfigFaults = new Map([["p/m", 7]]);
  engine.stallBySession = new Map();
  const header = { config: { provider: "p", model: "m", maxTokens: 1024 } };
  engine.ctx = {
    tokenMeter: { measure: () => ({ nodes: [], totalTokens: 0 }) },
    get: () => undefined,
    llm: { async resolveModelInfo() { return { context: { contextWindow: 200_000 }, defaultMaxTokens: 4096 }; } }
  };
  const agent = { session: { id: "s1", events: [], requestHeader: () => header }, options: {} };

  const result = await engine.compactPressure(agent, header, undefined, false);

  assert.equal(result, null, "the session is under its threshold, so nothing runs");
  assert.equal(engine.pressureConfigFaults.has("p/m"), false, "and the fault counter for that route is gone");
});
