/**
 * A threshold below the non-compactable baseline must not fail every step.
 *
 * Measured on a real profile: thresholdRatio 0.002 puts the trigger at 512 tokens
 * while the system prompt + workspace instructions + tool definitions alone are
 * about 9k. The engine compacted everything compactable, remained above the
 * threshold, and threw "still above threshold" on every subsequent step - a
 * permanent, unrecoverable error stream that buries real failures.
 *
 * The distinction the engine must make: "I could not get below the threshold" is
 * only a failure when there was something left to compact. When the compactable
 * prefix is exhausted, the honest answer is to stop and let the caller decide.
 *
 * Run with: node --test test/threshold-exhausted.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { selectCompactableRange } from "../src/region.js";

/** A session-shaped value whose surface is one system head plus N nodes. */
function sessionOf(turns) {
  const events = [{ seq: 0, type: "system/message", data: { message: { role: "system", content: [{ type: "text", text: "sys" }] } } }];
  let seq = 1;
  for (let turn = 1; turn <= turns; turn += 1) {
    events.push({ seq: seq++, type: "user/message", data: { content: [{ type: "text", text: "q" + turn }] } });
    events.push({ seq: seq++, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "a" + turn }] } } });
  }
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  return {
    id: "threshold-probe",
    events,
    surface: { nodes: events.map((e) => e.seq) },
    eventAt: (s) => bySeq.get(s),
    deriveEventMessage: (event) => event.message ?? event.data?.message ?? null
  };
}

test("when the compactable prefix is exhausted, the selector reports nothing left", () => {
  const session = sessionOf(2);
  // Everything priced, but retainTokens covers the whole surface: nothing to compact.
  const measurement = {
    nodes: session.surface.nodes.map((seq) => ({ seq, tokens: 100, heuristicTokens: 100 })),
    totalTokens: session.surface.nodes.length * 100
  };
  assert.equal(
    selectCompactableRange(session, measurement, measurement.totalTokens),
    null,
    "retaining everything leaves no range - this is the exhausted case"
  );
  // And with a small retained tail there IS a range, so the two cases are distinct.
  assert.notEqual(selectCompactableRange(session, measurement, 100), null, "a small tail leaves a range");
});
