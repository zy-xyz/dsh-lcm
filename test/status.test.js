/**
 * G6.1: the state surface. \`/lcm-status\` reports what the session has compacted.
 *
 * lcm-x exposes \`lcm_status\` / \`lcm_inspect\` for the same reason. Reading the
 * numbers off the log rather than keeping counters in memory means they survive a
 * restart and describe the session as persisted, which is also what makes them
 * trustworthy as evidence.
 *
 * Every number has to be a MEASUREMENT of what happened. \`maxTokens\` on a
 * \`compaction/summary\` event is the summary TARGET the instruction asked the
 * model to aim for (summarize.js returns its \`budgetTokens\`, region.js commits it
 * under the contract's field name), so reporting it as "kept" published the
 * request as if it were the result.
 *
 * Run with: node --test test/status.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildStatus, defineStatusCommand } from "../src/command.js";
import { estimateEntryTokens } from "../src/compiler.js";

/** A body a summary event actually produced, sized by the engine's own estimator. */
const BODY = "## 已完成\n- 状态面改为实测 checkpoint 体积\n\n## 下一步\n- 跑 test/status.test.js";
const BODY_TOKENS = estimateEntryTokens(BODY);

/** One depth-1 checkpoint: a shadowed span, its summary event, its replacement. */
function sessionWithOneCheckpoint({
  shadowedTokenCount = 5000,
  targetTokens = 600,
  body = BODY,
  usage
} = {}) {
  const events = [
    { seq: 0, type: "user/message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    {
      seq: 1,
      type: "compaction/summary",
      data: {
        compactionId: "c1",
        shadowedSeqs: [0],
        shadowedTokenCount,
        maxTokens: targetTokens,
        summary: [{ type: "text", text: body }],
        ...(usage === undefined ? {} : { usage })
      }
    },
    { seq: 2, type: "user/message", data: { content: [{ type: "text", text: "checkpoint" }], source: { kind: "compact-checkpoint", compactionId: "c1" } } }
  ];
  return shapedSession(events, [1, 2]);
}

/** Two checkpoints, the second absorbing the first: d1 + d2. */
function sessionWithTwoCheckpoints() {
  const second = "## 已完成\n- 第二层摘要\n\n## 下一步\n- 继续";
  const events = [
    { seq: 0, type: "user/message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    { seq: 1, type: "compaction/summary", data: { compactionId: "c1", shadowedSeqs: [0], shadowedTokenCount: 5000, maxTokens: 600, summary: [{ type: "text", text: BODY }] } },
    { seq: 2, type: "user/message", data: { content: [{ type: "text", text: "checkpoint one" }], source: { kind: "compact-checkpoint", compactionId: "c1" } } },
    { seq: 3, type: "compaction/summary", data: { compactionId: "c2", shadowedSeqs: [0, 1, 2], shadowedTokenCount: 9000, maxTokens: 16384, summary: [{ type: "text", text: second }] } },
    { seq: 4, type: "user/message", data: { content: [{ type: "text", text: "checkpoint two" }], source: { kind: "compact-checkpoint", compactionId: "c2" } } }
  ];
  return shapedSession(events, [2, 4]);
}

/** Wrap events in the session shape buildStatus reads. */
function shapedSession(events, nodes) {
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  return {
    id: "s",
    events,
    surface: { nodes, replaceGeneration: 1 },
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
  assert.ok(text.includes(`5000 shadowed -> ${BODY_TOKENS} kept`), "kept is the produced body size\n" + text);
  assert.ok(text.includes(`saved: ${5000 - BODY_TOKENS} tokens`), text);
  assert.ok(text.includes(`${(5000 / BODY_TOKENS).toFixed(2)}:1`), "the ratio is derived from the two measured sides\n" + text);
  assert.doesNotMatch(text, /-> 600 kept/, "600 is the target the instruction named, not a size");
});

test("a target that differs from the body is reported as the body", () => {
  // The real production shape: 371625 shadowed, a 16384-token TARGET, a 15832-char body.
  const text = buildStatus(sessionWithOneCheckpoint({ shadowedTokenCount: 371625, targetTokens: 16384 }));
  assert.ok(text.includes(`371625 shadowed -> ${BODY_TOKENS} kept`), text);
  assert.ok(!text.includes("16384"), "the target never surfaces as a size\n" + text);
  assert.ok(text.includes(`saved: ${371625 - BODY_TOKENS} tokens`), text);
  assert.ok(text.includes(`${(371625 / BODY_TOKENS).toFixed(2)}:1`), text);
});

test("the billed completion is not the kept size either", () => {
  // usage.outputTokens covers the whole completion, reasoning included, and is
  // absent whenever the deterministic fallback produced the body.
  const text = buildStatus(sessionWithOneCheckpoint({ usage: { inputTokens: 1183, outputTokens: 5299, totalTokens: 565074 } }));
  assert.ok(text.includes(`5000 shadowed -> ${BODY_TOKENS} kept`), text);
  assert.ok(!text.includes("5299"), "billed tokens are not a size\n" + text);
});

test("several checkpoints sum their bodies", () => {
  const text = buildStatus(sessionWithTwoCheckpoints());
  const second = estimateEntryTokens("## 已完成\n- 第二层摘要\n\n## 下一步\n- 继续");
  assert.match(text, /checkpoints: 2 \(max depth 2\)/);
  assert.match(text, /d1=1 d2=1/);
  assert.ok(text.includes(`-> ${BODY_TOKENS + second} kept`), text);
  assert.ok(!text.includes("16984"), "sum of targets must not appear\n" + text);
});

test("the command is a command, not a tool", () => {
  const definition = defineStatusCommand();
  assert.equal(definition.name, "lcm-status");
  assert.equal(typeof definition.handler, "function");
  assert.equal(definition.handler({ agent: { session: untouchedSession() } }).kind, "success");
});
