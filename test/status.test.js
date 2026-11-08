/**
 * G6.1: the state surface. \`/lcm-status\` reports what the session has compacted.
 *
 * lcm-x exposes \`lcm_status\` / \`lcm_inspect\` for the same reason. Reading the
 * numbers off the log rather than keeping counters in memory means they survive a
 * restart and describe the session as persisted, which is also what makes them
 * trustworthy as evidence.
 *
 * Run with: node --test test/status.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildStatus, defineStatusCommand } from "../src/command.js";

/** A session with one depth-1 checkpoint and a live tail. */
function sessionWithOneCheckpoint() {
  const events = [
    { seq: 0, type: "user/message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    { seq: 1, type: "compaction/summary", data: { compactionId: "c1", shadowedSeqs: [0], shadowedTokenCount: 5000, maxTokens: 600 } },
    { seq: 2, type: "user/message", data: { content: [{ type: "text", text: "checkpoint" }], source: { kind: "compact-checkpoint", compactionId: "c1" } } }
  ];
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  return {
    id: "s",
    events,
    surface: { nodes: [1, 2], replaceGeneration: 1 },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => event.message ?? event.data?.message ?? null
  };
}

/** A session that has never been compacted. */
function untouchedSession() {
  return {
    id: "t",
    events: [{ seq: 0, type: "user/message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }],
    surface: { nodes: [0], replaceGeneration: 1 },
    eventAt: () => undefined,
    deriveEventMessage: (event) => event.message ?? null
  };
}

test("an untouched session says so instead of reporting zeros", () => {
  const text = buildStatus(untouchedSession());
  assert.match(text, /nothing has been compacted/);
  assert.doesNotMatch(text, /saved:/, "no savings line when there is nothing to save against");
});

test("a compacted session reports checkpoints, depth and savings", () => {
  const text = buildStatus(sessionWithOneCheckpoint());
  assert.match(text, /checkpoints: 1 \(max depth 1\)/, "the count and the depth are both present");
  assert.match(text, /d1=1/, "the depth histogram");
  assert.match(text, /5000 shadowed -> 600 kept/, "both sides of the ratio, from the log");
  assert.match(text, /saved: 4400 tokens/);
  assert.match(text, /8\.33:1/, "the ratio is derived, not asserted");
});

test("the command is a command, not a tool", () => {
  const definition = defineStatusCommand();
  assert.equal(definition.name, "lcm-status");
  assert.equal(typeof definition.handler, "function");
  assert.equal(definition.handler({ agent: { session: untouchedSession() } }).kind, "success");
});
