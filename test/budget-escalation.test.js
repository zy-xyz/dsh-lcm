/**
 * The third summarizer failure mode: a completion that hits the output cap
 * before writing a single text token.
 *
 * Two failures share the `max-tokens` finish reason and need opposite handling.
 * A summary WITH text that was cut off is deterministic — the same budget
 * truncates it again — so it must fail on the first attempt. A completion with
 * NO text but a full reasoning stream is the empty-response failure wearing the
 * truncation reason: a reasoning-first backend spent the whole budget thinking.
 * That one gets exactly one budget escalation, because the next attempt at the
 * same ceiling would only buy the same reasoning spend again.
 *
 * Run with: node --test test/budget-escalation.test.js
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

/** Reasoning only, and the stream ends on the cap: budget starved, no text. */
async function* reasoningOnlyMaxTokens() {
  yield { type: "block-start", index: 0, blockType: "reasoning" };
  yield { type: "reasoning-delta", index: 0, text: "weighing the span" };
  yield { type: "block-end", index: 0, block: { type: "reasoning", text: "weighing the span" } };
  yield { type: "finish", reason: { kind: "max-tokens" }, replayState: undefined };
}

/** Text that was cut off at the cap: deterministic truncation. */
async function* textMaxTokens() {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text: "## 逐字锚点\n- src/index.js" };
  yield { type: "finish", reason: { kind: "max-tokens" }, replayState: undefined };
}

/** A normal response: one text block, clean stop. */
async function* withText(text) {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "finish", reason: { kind: "stop" }, replayState: undefined };
}

/**
 * A stub LLM replaying the given response factories in order. Each call is
 * recorded by VALUE (budget plus the instruction the model was told), because a
 * later escalation replaces the caller's options object.
 */
function stubLlm(responses) {
  const calls = [];
  return {
    calls,
    llm: {
      stream(options) {
        const next = responses[Math.min(calls.length, responses.length - 1)];
        calls.push({ maxTokens: options.maxTokens, instruction: options.messages.at(-1).content[0].text });
        return next();
      }
    }
  };
}

test("a reasoning-only max-tokens response is retried with a doubled budget", async () => {
  const stub = stubLlm([reasoningOnlyMaxTokens, () => withText("## 已完成\n- 压缩完成")]);
  const p = prepared();
  const result = await summarizeLeaf({ llm: stub.llm }, resolveConfig({}), p, { session: p.session, options: {} }, 512, undefined);

  assert.equal(stub.calls.length, 2, "one escalation attempt after the budget-starved response");
  assert.equal(stub.calls[0].maxTokens, 512);
  assert.equal(stub.calls[1].maxTokens, 1024, "the escalation doubles the budget");
  assert.match(result.summary[0].text, /压缩完成/);
  assert.equal(result.maxTokens, 1024, "provenance reports the budget actually used");
});

test("the escalated request restates the new budget in the instruction", async () => {
  const stub = stubLlm([reasoningOnlyMaxTokens, () => withText("## 已完成\n- 写完了")]);
  const p = prepared();
  await summarizeLeaf({ llm: stub.llm }, resolveConfig({}), p, { session: p.session, options: {} }, 512, undefined);

  assert.match(stub.calls[0].instruction, /Produce at most 512 tokens/);
  assert.match(stub.calls[1].instruction, /Produce at most 1024 tokens/, "the model must not be told the stale ceiling");
});

test("two budget-starved responses fail after exactly one escalation", async () => {
  const stub = stubLlm([reasoningOnlyMaxTokens]);
  const p = prepared();
  await assert.rejects(
    summarizeLeaf({ llm: stub.llm }, resolveConfig({}), p, { session: p.session, options: {} }, 512, undefined),
    (error) => error.code === "MAX_TOKENS" && /truncated at the token cap/.test(error.message)
  );
  assert.equal(stub.calls.length, 2, "1 attempt + 1 escalation, never a third");
  assert.deepEqual(stub.calls.map((call) => call.maxTokens), [512, 1024]);
});

test("a truncated response that carries text still fails on the first attempt", async () => {
  const stub = stubLlm([textMaxTokens, () => withText("never reached")]);
  const p = prepared();
  await assert.rejects(
    summarizeLeaf({ llm: stub.llm }, resolveConfig({}), p, { session: p.session, options: {} }, 512, undefined),
    (error) => error.code === "MAX_TOKENS" && /truncated at the token cap/.test(error.message)
  );
  assert.equal(stub.calls.length, 1, "a deterministic truncation earns no budget");
});

test("the escalation clamps to checkpointCap instead of doubling past it", async () => {
  const stub = stubLlm([reasoningOnlyMaxTokens, () => withText("## 已完成\n- 到了上限")]);
  const p = prepared();
  const result = await summarizeLeaf(
    { llm: stub.llm },
    resolveConfig({ checkpointCap: 600 }),
    p,
    { session: p.session, options: {} },
    512,
    undefined
  );

  assert.deepEqual(stub.calls.map((call) => call.maxTokens), [512, 600], "600 is the cap, not 1024");
  assert.match(stub.calls[1].instruction, /Produce at most 600 tokens/);
  assert.equal(result.maxTokens, 600);
});
