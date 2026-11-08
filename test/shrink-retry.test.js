/**
 * The shrink gate must not cost a model call it did not have to spend.
 *
 * Measured on a real engine, a run wrote a 2438-token summary for a 1517-token
 * span against a 512-token target: 4.8x the target and longer than the text it
 * replaced, so `compileCompaction`'s shrink guarantee rejected the checkpoint
 * and the call was wasted. The gate is right (it is the transaction's safety
 * line), and the request carries no `maxTokens` by design, so the only lever is
 * the PROMPT. This backend therefore measures the summary BODY against the
 * shadowed span it replaces, and on an overrun re-asks exactly once with the
 * upper bound restated as a hard number plus an explicit cut/keep split.
 *
 * Asserted here:
 *   1. over-long first attempt -> one retry, which succeeds, and the retry
 *      instruction names the hard bound
 *   2. over-long both times -> throws after exactly 2 calls, naming both numbers
 *   3. a first attempt that already fits costs ONE call (no extra spend)
 *   4. the retry instruction still demands the anchor list and every state
 *      section: "be shorter" must not be satisfied by deleting fidelity
 *
 * Run with: node --test test/shrink-retry.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { LcmCompactionEngine, resolveConfig } from "../src/index.js";
import { estimateEntryTokens } from "../src/compiler.js";

/** The hard bound the retry must state: the shadowed span's own token count. */
const SHADOWED = 100;

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

/** A priced selection snapshot with a deliberately small shadowed span. */
const prepared = () => ({
  session: fakeSession(),
  start: 0,
  end: 0,
  shadowedSeqs: [0],
  shadowedTokenCount: SHADOWED
});

/** A summary that fits: a few lines, well under the shadowed span. */
const FITTING = "## 逐字锚点\n- src/index.js\n## 已完成\n- 压缩完成";

/**
 * A summary that overruns the span it replaces — the shape the real run
 * produced. No anchor heading, so pointer attribution leaves the bytes alone and
 * the expected estimate is exactly `estimateEntryTokens` of this string.
 */
const OVERSIZE = Array.from({ length: 120 }, (_, i) => "- src/file" + i + ".js").join("\n");

/** A normal response: one text block, clean stop. */
async function* withText(text) {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "finish", reason: { kind: "stop" }, replayState: undefined };
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

/** An engine whose only collaborator is the stubbed LLM transport. */
function engineWith(stub) {
  const engine = Object.create(LcmCompactionEngine.prototype);
  engine.config = resolveConfig({ summaryRatio: 0.12, summaryFloorTokens: 512, checkpointCap: 16384 });
  engine.ctx = { llm: stub.llm };
  return engine;
}

/** The instruction text of one recorded call. */
function instructionOf(call) {
  return call.messages.at(-1).content[0].text;
}

/** The retry-only block: everything from the hard constraint onwards. */
function retryBlockOf(call) {
  const text = instructionOf(call);
  const at = text.indexOf("HARD CONSTRAINT");
  return at < 0 ? "" : text.slice(at);
}

test("an over-long summary is re-asked once and the retry succeeds", async () => {
  const stub = stubLlm([() => withText(OVERSIZE), () => withText(FITTING)]);
  const engine = engineWith(stub);
  const out = await engine.compile(prepared(), { session: prepared().session, options: {} }, undefined);

  assert.equal(stub.calls.length, 2, "one initial call plus exactly one length retry");
  assert.equal(out.entries.length, 1);
  assert.match(out.entries[0].text, /压缩完成/, "the retry's summary is what gets committed");
  assert.equal(out.stats.tokens, estimateEntryTokens(FITTING), "stats price the accepted body");
  assert.ok(out.stats.tokens < SHADOWED);

  // The retry states the upper bound as a NUMBER, taken from the span itself.
  assert.match(instructionOf(stub.calls[1]), new RegExp("shorter than " + SHADOWED + " tokens"));
  assert.ok(
    estimateEntryTokens(OVERSIZE) > SHADOWED,
    "the fixture must actually overrun the span, or this test proves nothing"
  );
});

test("a summary that overruns twice degrades deterministically instead of failing", async () => {
  // Reversed deliberately. Throwing SUMMARY_NOT_SHRINKING turned "the model wrote
  // too much" into "the compaction fails": the span lost its summary and the error
  // repeated every step. lcm-x's ladder ends in deterministic truncation ("no LLM,
  // guaranteed convergence") because its invariant is to prefer degraded coverage
  // over failure, and this package puts the anchor list FIRST precisely so a
  // truncation costs the narrative tail and keeps the pointers.
  const stub = stubLlm([() => withText(OVERSIZE)]);
  const engine = engineWith(stub);
  const out = await engine.compile(prepared(), { session: prepared().session, options: {} }, undefined);
  const body = out.entries.map((entry) => entry.text).join("\n");

  assert.equal(stub.calls.length, 2, "one normal attempt plus one aggressive retry - both bounded");
  assert.ok(estimateEntryTokens(body) <= SHADOWED, "the degraded checkpoint still fits the shrink bound");
  // The note shortens when the bound is tight (this fixture's bound is 100 tokens,
  // so the terse form is used), but it must always say the body was cut.
  assert.match(body, /truncated/i, "the result says it was cut, so a reader is not misled");
  assert.match(body, /lcm_search|lcm_expand/, "and it names the recovery path");
  // The cut starts from the TOP: the summary's first lines are the anchor section,
  // so truncation costs the narrative tail. This fixture has no section headers, so
  // the property to assert is prefix preservation, not a heading match.
  assert.ok(body.includes("- src/file0.js"), "the first line survives: truncation cuts from the tail");
  assert.ok(!body.includes("- src/file119.js"), "and the last line is gone");
});

test("a first attempt that already fits costs one call", async () => {
  const stub = stubLlm([() => withText(FITTING), () => withText(OVERSIZE)]);
  const engine = engineWith(stub);
  const out = await engine.compile(prepared(), { session: prepared().session, options: {} }, undefined);

  assert.equal(stub.calls.length, 1, "no retry, no extra spend");
  assert.match(out.entries[0].text, /压缩完成/);
  assert.equal(retryBlockOf(stub.calls[0]), "", "the normal path carries no hard-constraint text");
});

test("the retry keeps the anchor list and every state section mandatory", async () => {
  const stub = stubLlm([() => withText(OVERSIZE), () => withText(FITTING)]);
  const engine = engineWith(stub);
  await engine.compile(prepared(), { session: prepared().session, options: {} }, undefined);

  const block = retryBlockOf(stub.calls[1]);
  assert.notEqual(block, "", "the retry instruction must carry the hard-constraint block");
  // 1. the previous attempt's failure is stated, with the numbers involved
  assert.match(block, /previous attempt was rejected/);
  assert.ok(block.includes(estimateEntryTokens(OVERSIZE) + " estimated tokens against " + SHADOWED));
  // 3. what to cut, and what must NOT be cut
  assert.match(block, /逐字锚点/, "the anchor list stays mandatory");
  assert.match(block, /merge duplicate anchors/);
  for (const heading of ["## 目标与约束", "## 已完成", "## 未决问题", "## 下一步"]) {
    assert.ok(block.includes(heading), "state section kept mandatory: " + heading);
  }
  assert.match(block, /never drop or empty a section/);
});
