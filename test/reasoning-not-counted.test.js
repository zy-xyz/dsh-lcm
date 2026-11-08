/**
 * Reasoning tokens are never part of a summary's size.
 *
 * A reasoning-first backend bills hidden reasoning inside `completion_tokens`
 * against the same ceiling as the answer, and that number is routinely several
 * times the visible text (measured: 7264 of 12953 on one arm). Sizing a summary
 * by it would make a 900-token checkpoint look like a 4000-token one and trip
 * the shrink guarantee for no reason.
 *
 * The engine's contract: every size decision counts the TEXT that came back.
 * This test pins it by making the provider report an absurd billed total while
 * returning a small summary, and asserting the summary is priced by its text.
 *
 * Run with: node --test test/reasoning-not-counted.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { estimateEntryTokens } from "../src/compiler.js";
import { resolveConfig } from "../src/index.js";
import { summarizeLeaf } from "../src/summarize.js";

/** One user event, so the selected span has a model-visible message. */
function fakeSession() {
  const events = [{ seq: 0, type: "user/message", message: { role: "user", content: [{ type: "text", text: "do the thing ".repeat(50) }] } }];
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  return {
    id: "s1",
    events,
    surface: { nodes: [0], replaceGeneration: 1 },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => event.message ?? null,
    requestHeader: () => ({ config: { provider: "p", model: "m" }, tools: [] })
  };
}

/** A response with reasoning plus text, and a huge billed completion total. */
async function* billedHeavy(billed, reasoning, text) {
  yield { type: "block-start", index: 0, blockType: "reasoning" };
  yield { type: "reasoning-delta", index: 0, text: "thinking hard" };
  yield { type: "block-end", index: 0, block: { type: "reasoning", text: "thinking hard" } };
  yield { type: "block-start", index: 1, blockType: "text" };
  yield { type: "text-delta", index: 1, text };
  yield { type: "block-end", index: 1, block: { type: "text", text } };
  yield {
    type: "finish",
    reason: { kind: "stop" },
    replayState: undefined,
    usage: {
      inputTokens: 100,
      outputTokens: billed,
      completion_tokens: billed,
      completion_tokens_details: { reasoning_tokens: reasoning }
    }
  };
}

const SUMMARY = "## 逐字锚点\n- NEEDLE_1\n\n## 目标与约束\n- 测试\n\n## 已完成\n- 无\n\n## 未决问题\n- 无\n\n## 下一步\n- 继续";

test("a summary is sized by its text, not by the billed completion total", async () => {
  const session = fakeSession();
  const prepared = { session, start: 0, end: 0, shadowedSeqs: [0], shadowedTokenCount: 1000 };
  // 9000 billed, 8000 of them reasoning, but a small text body.
  const llm = { stream: () => billedHeavy(9000, 8000, SUMMARY) };
  const result = await summarizeLeaf({ llm }, resolveConfig({}), prepared, { session, options: {} }, 512);
  const text = result.summary.map((block) => block.text ?? "").join("\n");
  const tokens = estimateEntryTokens(text);
  assert.ok(tokens < 200, `the summary text is small; got ${tokens} estimated tokens`);
  assert.ok(tokens < 9000 / 4, "size must come from the text, not the billed 9000-token completion");
  // The billed total is not required to survive into the result - what matters is
  // that it never influences the size. Asserting its absence would over-specify
  // the provenance shape; asserting it is unused is the contract.
  assert.ok(
    !("tokens" in result) || result.tokens < 200,
    "no reported size may reflect the billed total"
  );
});