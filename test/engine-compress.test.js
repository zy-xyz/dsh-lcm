/**
 * `bench/engine-compress.mjs` drives the real engine, offline.
 *
 * Every benchmark used to compress by prompting a model itself, so the reported
 * numbers measured the PROMPT and the RETRIEVAL and none of the engine. This test
 * pins the replacement: a haystack goes in, the real `Session` + real
 * `TokenMeter` + real `LcmCompactionEngine` run ONE compaction transaction
 * (`selectCompactableRange` → `compactRegion`, the automatic path's own pair),
 * and a framed checkpoint comes out — with only the LLM transport stubbed.
 *
 * Run with: node --test test/engine-compress.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

/**
 * The harness packages only resolve inside a dsh profile; outside one this test
 * skips rather than failing on a missing peer dependency.
 */
let compressHaystack;
try {
  await import("@deepseek-ai/dsh-session");
  ({ compressHaystack } = await import("../bench/engine-compress.mjs"));
} catch {
  compressHaystack = null;
}

const skip = compressHaystack === null;

/** What the stubbed model returns; one anchor of the span appears in it. */
const MODEL_SUMMARY = [
  "## 逐字锚点",
  "- alpha-1",
  "## 用户事实",
  "- user.needle = alpha-1 | fact",
  "## 目标与约束",
  "- compress the span",
  "## 已完成",
  "- seeded haystack",
  "## 未决问题",
  "- none",
  "## 下一步",
  "- continue"
].join("\n");

/** A tiny haystack: enough tokens to clear the span floor, no network. */
function haystackOf(sessions, turns) {
  const haystack = [];
  for (let session = 1; session <= sessions; session += 1) {
    const messages = [];
    for (let turn = 1; turn <= turns; turn += 1) {
      messages.push({ role: "user", content: "session " + session + " turn " + turn + " alpha-" + turn + " " + "x".repeat(1200) });
      messages.push({ role: "assistant", content: "ack " + session + "." + turn + " " + "y".repeat(1200) });
    }
    haystack.push(messages);
  }
  return haystack;
}

test("one compaction of a haystack returns the engine's framed checkpoint", { skip }, async () => {
  const calls = [];
  const result = await compressHaystack(haystackOf(4, 2), {
    complete: async (request) => {
      calls.push(request);
      return { content: MODEL_SUMMARY };
    },
    maxCompactions: 1
  });

  // The summarizer was driven exactly once, through the engine's own compile
  // hook, and the transaction committed once.
  assert.equal(result.calls, 1, "one leaf costs exactly one model call");
  assert.equal(calls.length, 1, "the reported call count matches the transport's");
  assert.equal(result.compactions, 1, "one committed compaction");
  assert.equal(result.leaves, 1, "a first compaction absorbs no earlier checkpoint, so it is a depth-1 leaf");

  // The prompt really was the engine's: the instruction it builds is the last
  // message, so the transport sees the section skeleton the summarizer demands.
  assert.match(calls[0].prompt, /## 逐字锚点/u, "the engine's instruction reached the model");
  assert.match(calls[0].prompt, /alpha-1/u, "the shadowed span was replayed verbatim");

  // The checkpoint is the engine's framing, not the raw model text.
  assert.match(result.checkpointText, /<compacted-checkpoint>/u, "the durable checkpoint framing is present");
  assert.match(result.checkpointText, /## LCM checkpoint: \d+ nodes \(seqs \d+-\d+/u, "the structural header is present");
  assert.match(result.checkpointText, /\[lcm leaf summary · \d+ nodes · seqs \d+-\d+/u, "the leaf entry header is present");
  // Anchor attribution is the engine's post-processing, and it only fires for a
  // string the span actually contained.
  assert.match(result.checkpointText, /- alpha-1 \(seq \d+\)/u, "the anchor carries its seq pointer");
  assert.match(result.checkpointText, /## 下一步\n- continue/u, "the model body survived intact");
});
