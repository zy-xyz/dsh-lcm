/**
 * Retry behaviour for one specific real-world failure of the leaf summarizer:
 * a model response that carries no text block at all.
 *
 * Measured on a live engine run, a reasoning-first backend spends the completion
 * budget on reasoning and returns zero text blocks; the same request repeated
 * usually returns text. This backend sends no `maxTokens`, so the budget being
 * burned is the PROVIDER's own default; the failure shape is unchanged. The
 * neighbouring failure — a `max-tokens` finish that DID produce text — is
 * deterministic truncation and must keep failing on the first attempt, because a
 * retry would only truncate again at full price.
 *
 * Run with: node --test test/empty-summary.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfig } from "../src/index.js";
import { summarizeLeaf } from "../src/summarize.js";

/** One user event, so the selected span has a model-visible message. */
function fakeSession() {
  const events = [
    { seq: 0, type: "user/message", message: { role: "user", content: [{ type: "text", text: "do the thing" }] } }
  ];
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

const prepared = () => ({ session: fakeSession(), start: 0, end: 0, shadowedSeqs: [0], shadowedTokenCount: 100 });

/** A response that is all reasoning and no text — the failure being retried. */
async function* reasoningOnly() {
  yield { type: "block-start", index: 0, blockType: "reasoning" };
  yield { type: "reasoning-delta", index: 0, text: "thinking about the span" };
  yield { type: "block-end", index: 0, block: { type: "reasoning", text: "thinking about the span" } };
  yield { type: "finish", reason: { kind: "stop" }, replayState: undefined };
}

/** A normal response: one text block, clean stop. */
async function* withText(text) {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "finish", reason: { kind: "stop" }, replayState: undefined };
}

/** A response cut off at the output cap: deterministic, never retried. */
async function* truncated() {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text: "## 逐字锚点\\n- src/index.js" };
  yield { type: "finish", reason: { kind: "max-tokens" }, replayState: undefined };
}

/** A stub LLM that replays the given response factories in order, counting calls. */
function stubLlm(responses) {
  const calls = [];
  return {
    calls,
    llm: {
      stream(options) {
        const next = responses[Math.min(calls.length, responses.length - 1)];
        calls.push(options);
        return next();
      }
    }
  };
}

test("an empty first response is retried and the second attempt succeeds", async () => {
  const stub = stubLlm([reasoningOnly, () => withText("## 已完成\n- 压缩完成")]);
  const p = prepared();
  const result = await summarizeLeaf({ llm: stub.llm }, resolveConfig({}), p, { session: p.session, options: {} }, 512, undefined);

  assert.equal(stub.calls.length, 2, "one retry after the empty response");
  assert.match(result.summary[0].text, /压缩完成/);
  assert.equal(result.targetTokens, 512, "the instruction target is reported, not a request cap");
  assert.equal(typeof stub.calls[0].maxTokens, "number", "the ceiling is generous, not the binding constraint");
});

test("all attempts empty throws the original error after 1 + emptySummaryRetries calls", async () => {
  const stub = stubLlm([reasoningOnly]);
  const p = prepared();
  await assert.rejects(
    summarizeLeaf({ llm: stub.llm }, resolveConfig({}), p, { session: p.session, options: {} }, 512, undefined),
    /produced no text content/
  );
  assert.equal(stub.calls.length, 3, "1 attempt + the default emptySummaryRetries of 2");
});

test("a max-tokens truncation fails immediately: no retry is attempted", async () => {
  const stub = stubLlm([truncated, () => withText("never reached")]);
  const p = prepared();
  await assert.rejects(
    summarizeLeaf({ llm: stub.llm }, resolveConfig({}), p, { session: p.session, options: {} }, 512, undefined),
    (error) => error.code === "MAX_TOKENS" && /truncated at the token cap/.test(error.message)
  );
  assert.equal(stub.calls.length, 1, "a deterministic truncation must not be re-sampled");
});

test("emptySummaryRetries: 0 disables the retry", async () => {
  const stub = stubLlm([reasoningOnly]);
  const p = prepared();
  await assert.rejects(
    summarizeLeaf({ llm: stub.llm }, resolveConfig({ emptySummaryRetries: 0 }), p, { session: p.session, options: {} }, 512, undefined),
    /produced no text content/
  );
  assert.equal(stub.calls.length, 1, "no retry budget means one attempt");
});
