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

test("an empty retry ESCALATES the completion ceiling instead of repeating it", async () => {
  // Measured across 121 checkpoints: 10 fell back to the deterministic rung, at a
  // rate of 27.3% when the target put the ceiling at the 4 096 floor versus 4.0%
  // above it. A reasoning backend bills hidden reasoning against the same budget,
  // so at 4 096 the thinking can consume all of it and the response finishes with
  // zero text — and retrying at the SAME ceiling reproduces that by construction.
  // The ladder used to do exactly that: three full-price calls, then a degraded body.
  const stub = stubLlm([reasoningOnly]);
  const p = prepared();
  await assert.rejects(
    summarizeLeaf({ llm: stub.llm }, resolveConfig({ emptySummaryRetries: 3 }), p, { session: p.session, options: {} }, 512, undefined),
    /produced no text content/
  );
  const ceilings = stub.calls.map((call) => call.maxTokens);
  assert.deepEqual(ceilings, [4096, 8192, 16384, 32768], "each retry doubles the cap, up to 32 768");
});

test("a successful retry reports the escalated ceiling it was sent with", async () => {
  // The durable record states "the generation cap the summarize call sent". Once a
  // retry escalates, that is no longer the base ceiling, and recording the base
  // would under-report the number an operator reads to judge truncation risk.
  const stub = stubLlm([reasoningOnly, () => withText("## 已完成\n- 压缩完成")]);
  const p = prepared();
  const result = await summarizeLeaf({ llm: stub.llm }, resolveConfig({}), p, { session: p.session, options: {} }, 512, undefined);
  assert.deepEqual(stub.calls.map((call) => call.maxTokens), [4096, 8192], "the retry doubled");
  assert.equal(result.maxTokens, 8192, "the record names the cap that produced the body");
});

test("a truncation retries with a bigger ceiling, and a retry that fits is used", async () => {
  // The ceiling was too small — that is the whole failure — so the retry raises it
  // instead of resending the same request. Measured live: three condensation passes
  // truncated at the 4 096 floor and fell to the deterministic rung because this
  // path threw on the first attempt while the empty path already escalated.
  const stub = stubLlm([truncated, () => withText("## 已完成\n- 压缩完成")]);
  const p = prepared();
  const result = await summarizeLeaf({ llm: stub.llm }, resolveConfig({}), p, { session: p.session, options: {} }, 512, undefined);
  assert.deepEqual(stub.calls.map((call) => call.maxTokens), [4096, 8192], "the retry doubled");
  assert.match(result.summary[0].text, /压缩完成/u, "and its answer is kept");
  assert.equal(result.maxTokens, 8192, "the record names the cap that produced the body");
});

test("a truncation that never fits still fails, once the ceiling stops growing", async () => {
  const stub = stubLlm([truncated]);
  const p = prepared();
  await assert.rejects(
    summarizeLeaf({ llm: stub.llm }, resolveConfig({ emptySummaryRetries: 2 }), p, { session: p.session, options: {} }, 512, undefined),
    (error) => error.code === "MAX_TOKENS" && /truncated at the token cap/.test(error.message)
  );
  // 1 + emptySummaryRetries calls, the same budget the empty path gets:
  // 4 096 -> 8 192 -> 16 384, then the retries are spent and it throws. Two bounds
  // exist — the retry budget and ESCALATED_CEILING_MAX — and the retry budget is
  // the one that binds here, because three doublings of 4 096 stop well short of
  // 32 768.
  assert.deepEqual(stub.calls.map((call) => call.maxTokens), [4096, 8192, 16384], "the same retry budget as the empty path");
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
