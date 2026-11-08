/**
 * The request carries NO completion cap.
 *
 * A summary-sized `maxTokens` was actively harmful on real engines: a
 * reasoning-first backend bills hidden reasoning against the same completion
 * budget, so the cap was spent entirely on thinking and the response finished
 * `max-tokens` with ZERO text — a compression that failed for a reason the
 * caller could not fix by tuning. Model output length is also not predictable
 * enough to cap usefully (the anchor list alone varies by an order of
 * magnitude across spans), so every fixed number was either a truncation or
 * dead weight.
 *
 * What still holds, and is asserted here:
 *   - `ctx.llm.stream` receives options with NO `maxTokens` key at all
 *   - the instruction still names a target size, worded as a target
 *   - a `max-tokens` finish WITH text is still deterministic truncation -> throw
 *   - a `max-tokens` finish WITHOUT text is the empty case -> retried
 *   - `error`/`aborted` finishes throw immediately
 *   - an oversize summary is accepted: `checkpointCap` is not a post-hoc gate
 *
 * Run with: node --test test/no-token-cap.test.js
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

/** Reasoning only, and the stream ends on the provider's cap: no text. */
async function* reasoningOnlyMaxTokens() {
  yield { type: "block-start", index: 0, blockType: "reasoning" };
  yield { type: "reasoning-delta", index: 0, text: "weighing the span" };
  yield { type: "block-end", index: 0, block: { type: "reasoning", text: "weighing the span" } };
  yield { type: "finish", reason: { kind: "max-tokens" }, replayState: undefined };
}

/** Text that was cut off at the provider's cap: deterministic truncation. */
async function* textMaxTokens() {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text: "## 逐字锚点\n- src/index.js" };
  yield { type: "finish", reason: { kind: "max-tokens" }, replayState: undefined };
}

/** A transport failure: thrown, never retried. */
async function* failed() {
  yield { type: "finish", reason: { kind: "error", failure: new Error("transport exploded") }, replayState: undefined };
}

/** A normal response: one text block, clean stop. */
async function* withText(text) {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "finish", reason: { kind: "stop" }, replayState: undefined };
}

/** A stub LLM recording every options object it is handed. */
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

test("the request carries no maxTokens key at all", async () => {
  const stub = stubLlm([() => withText("## 已完成\n- 压缩完成")]);
  const p = prepared();
  await summarizeLeaf({ llm: stub.llm }, resolveConfig({}), p, { session: p.session, options: {} }, 2400, undefined);

  assert.equal(stub.calls.length, 1);
  assert.equal("maxTokens" in stub.calls[0], false, "no completion cap may be sent");
  assert.equal(stub.calls[0].maxTokens, undefined);
});

test("the instruction still names the target, worded as a target rather than a ceiling", async () => {
  const stub = stubLlm([() => withText("## 已完成\n- 写完了")]);
  const p = prepared();
  await summarizeLeaf({ llm: stub.llm }, resolveConfig({}), p, { session: p.session, options: {} }, 2400, undefined);

  const instruction = stub.calls[0].messages.at(-1).content[0].text;
  assert.match(instruction, /Aim for roughly 2400 tokens/, "the model is still told the size to aim for");
  assert.match(instruction, /that is a target, not a hard limit/, "the wording says target, not cap");
  assert.doesNotMatch(instruction, /Produce at most/, "the old ceiling wording is gone");
});

test("a max-tokens finish with no text is retried as an empty response, not escalated", async () => {
  const stub = stubLlm([reasoningOnlyMaxTokens, () => withText("## 已完成\n- 压缩完成")]);
  const p = prepared();
  const result = await summarizeLeaf({ llm: stub.llm }, resolveConfig({}), p, { session: p.session, options: {} }, 512, undefined);

  assert.equal(stub.calls.length, 2, "one empty-response retry");
  // There is no budget to restate, so the retry is the SAME request: identical
  // prompt AND identical options. That is the whole point of dropping the
  // escalation — the second attempt differs from the first only by sampling.
  assert.deepEqual(
    stub.calls[1].messages.at(-1).content[0].text,
    stub.calls[0].messages.at(-1).content[0].text,
    "the prompt is unchanged between attempts: there is no budget to restate"
  );
  assert.equal("maxTokens" in stub.calls[1], false, "the retry sends no cap either");
  assert.match(stub.calls[1].messages.at(-1).content[0].text, /Aim for roughly 512 tokens/);
  assert.match(result.summary[0].text, /压缩完成/);
  assert.equal(result.targetTokens, 512);
});

test("reasoning-only responses that never produce text fail after the empty retries", async () => {
  const stub = stubLlm([reasoningOnlyMaxTokens]);
  const p = prepared();
  await assert.rejects(
    summarizeLeaf({ llm: stub.llm }, resolveConfig({}), p, { session: p.session, options: {} }, 512, undefined),
    /produced no text content/
  );
  assert.equal(stub.calls.length, 3, "1 attempt + the default emptySummaryRetries of 2 — no budget escalation");
});

test("a truncated response that carries text still fails on the first attempt", async () => {
  const stub = stubLlm([textMaxTokens, () => withText("never reached")]);
  const p = prepared();
  await assert.rejects(
    summarizeLeaf({ llm: stub.llm }, resolveConfig({}), p, { session: p.session, options: {} }, 512, undefined),
    (error) => error.code === "MAX_TOKENS" && /truncated at the token cap/.test(error.message)
  );
  assert.equal(stub.calls.length, 1, "a deterministic truncation earns no retry");
});

test("an error finish throws the transport failure without retrying", async () => {
  const stub = stubLlm([failed, () => withText("never reached")]);
  const p = prepared();
  await assert.rejects(
    summarizeLeaf({ llm: stub.llm }, resolveConfig({}), p, { session: p.session, options: {} }, 512, undefined),
    /transport exploded/
  );
  assert.equal(stub.calls.length, 1);
});

test("a summary longer than checkpointCap is accepted: the cap is a target, not a post-hoc gate", async () => {
  // 2000 characters of anchors is far past a 100-token checkpointCap. Under the
  // old hard cap this response could not exist; now it is simply what the model
  // wrote, and the shrink guarantee (framed < shadowed) is the only gate.
  const long = "## 逐字锚点\n" + Array.from({ length: 60 }, (_, i) => "- src/file" + i + ".js").join("\n");
  const stub = stubLlm([() => withText(long)]);
  const p = prepared();
  const result = await summarizeLeaf(
    { llm: stub.llm },
    resolveConfig({ checkpointCap: 100 }),
    p,
    { session: p.session, options: {} },
    100,
    undefined
  );

  assert.equal(stub.calls.length, 1);
  assert.match(result.summary[0].text, /src\/file59\.js/, "every anchor survives; nothing is trimmed to the cap");
  assert.equal(result.targetTokens, 100);
  assert.equal(result.finish, "stop");
});
