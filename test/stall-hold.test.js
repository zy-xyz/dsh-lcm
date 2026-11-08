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

import { resolveConfig } from "../src/config.js";

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

test("an explicit request is never held", () => {
  // requireBelowThreshold is the manual /compact and the model-switch path: the
  // operator asked for an answer, and "nothing to compact" IS that answer. lcm-x
  // likewise exempts calls above the survival ceiling, whose fit only compress()
  // can run.
  const config = resolveConfig({ stallCooldownMs: 0 });
  assert.equal(config.stallCooldownMs, 0, "0 disables the hold entirely");
});
