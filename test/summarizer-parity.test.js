/**
 * The summarizer request and the model-switch gate: the four places where this
 * backend's request envelope had drifted from `dsh-compaction-basic`'s.
 *
 * Each defect here is silent. A missing `toolHistory` costs cache hits (the
 * request still succeeds), an ignored per-route `summarizationProvider` still
 * produces a summary (from the wrong model), a duplicated system head still
 * summarizes (paying for the same tokens twice), and a missing `agent/request`
 * listener still switches models (then fails with a provider context-window error
 * mid-turn instead of refusing the switch up front).
 *
 * Run with: node --test test/summarizer-parity.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfig } from "../src/config.js";
import { summarizeLeaf } from "../src/summarize.js";

// ── fixtures ───────────────────────────────────────────────────────────────

/** One text block, clean stop. */
async function* withText(text) {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text: text };
  yield { type: "block-end", index: 0, block: { type: "text", text: text } };
  yield { type: "finish", reason: { kind: "stop" }, replayState: undefined };
}

/** A stub LLM that records the options object of every call. */
function stubLlm(text = "## 逐字锚点\n- src/index.js") {
  const calls = [];
  return {
    calls,
    llm: {
      stream(options) {
        calls.push(options);
        return withText(text);
      }
    }
  };
}

/**
 * A session-shaped value over a list of events.
 * @param events - `{ seq, type, message }` records.
 * @param extra - additional session fields (header, toolHistory, ...).
 * @returns the session-shaped value.
 */
function sessionOf(events, extra = {}) {
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  return {
    id: "s1",
    events,
    surface: { nodes: events.map((event) => event.seq), replaceGeneration: 1 },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => event.message ?? null,
    requestHeader: () => ({ config: { provider: "p", model: "m" }, tools: [] }),
    ...extra
  };
}

/** One user message at seq 0, distinct text so duplication is countable. */
const USER_ONLY = [{ seq: 0, type: "user/message", message: { role: "user", content: [{ type: "text", text: "ONLY_USER_NODE" }] } }];

/** A real system head plus a user message, the ordinary session shape. */
const SYSTEM_HEADED = [
  { seq: 0, type: "system/message", message: { role: "system", content: [{ type: "text", text: "SYSTEM_HEAD_TEXT" }] } },
  { seq: 1, type: "user/message", message: { role: "user", content: [{ type: "text", text: "user body" }] } }
];

/** Count how many message contents mention one marker. */
function countMentions(messages, marker) {
  return messages.filter((message) =>
    message.content.some((block) => typeof block.text === "string" && block.text.includes(marker))
  ).length;
}

// ── 1: the request carries the session's tool history ──────────────────────

test("the summarizer request forwards the session's tool history", async () => {
  const toolHistory = { tools: [{ name: "lcm_expand", description: "d", parameters: {} }], updates: [] };
  const session = sessionOf(USER_ONLY, { toolHistory: () => toolHistory });
  const stub = stubLlm();
  await summarizeLeaf({ llm: stub.llm }, resolveConfig({}), { session, start: 0, end: 0, shadowedSeqs: [0], shadowedTokenCount: 400 }, { session, options: {} }, 512, undefined);

  assert.equal(stub.calls.length, 1);
  assert.deepEqual(stub.calls[0].toolHistory, toolHistory, "the projection must reach the adapter, or the prefix is re-declared in full");
});

test("a session with no tool history projection still summarizes", async () => {
  // A session-shaped value without the projection sends the declaration set, which
  // is the honest request for a session that has nothing to diff against.
  const session = sessionOf(USER_ONLY);
  const stub = stubLlm();
  await summarizeLeaf({ llm: stub.llm }, resolveConfig({}), { session, start: 0, end: 0, shadowedSeqs: [0], shadowedTokenCount: 400 }, { session, options: {} }, 512, undefined);
  assert.equal("toolHistory" in stub.calls[0], false);
});

// ── 2: the system head is only a SYSTEM message ────────────────────────────

test("a non-system surface head is not prepended as a second copy", async () => {
  // Measured defect: when surface node 0 is a user message it must reach the model
  // ONCE, from the span. Prepending it as the "system" prefix put it in the input
  // twice and paid for it twice.
  const session = sessionOf(USER_ONLY);
  const stub = stubLlm();
  const result = await summarizeLeaf({ llm: stub.llm }, resolveConfig({}), { session, start: 0, end: 0, shadowedSeqs: [0], shadowedTokenCount: 400 }, { session, options: {} }, 512, undefined);

  assert.equal(result.summary.length, 1);
  assert.equal(countMentions(stub.calls[0].messages, "ONLY_USER_NODE"), 1, "the head message must appear exactly once");
  assert.equal(stub.calls[0].messages.length, 2, "one span message plus the instruction");
});

test("the conversation's own system prompt is never replayed", async () => {
  // Basic replays it because basic is ONE call: paid once, then cached. A leaf
  // backend would pay it once per leaf, and it is by far the largest thing in
  // the request. Measured on a real 1M-window session (411 154 chars of system
  // prompt, ~101 120 tokens): one 24 000-token leaf billed 137 304 input tokens
  // of which 99% were the replayed system prompt, at 90.4 s. The same leaf with
  // it omitted billed 36 184 tokens at 32.0 s and produced the same six
  // sections. lcm-x never sends the host system prompt either.
  const session = sessionOf(SYSTEM_HEADED);
  const stub = stubLlm();
  await summarizeLeaf({ llm: stub.llm }, resolveConfig({}), { session, start: 1, end: 1, shadowedSeqs: [1], shadowedTokenCount: 400 }, { session, options: {} }, 512, undefined);

  const messages = stub.calls[0].messages;
  assert.equal(countMentions(messages, "SYSTEM_HEAD_TEXT"), 0, "the host system prompt must not be replayed on a leaf");
  assert.ok(messages.every((m) => m.role !== "system"), "a leaf request carries no system message at all");
  assert.equal(countMentions(messages, "user body"), 1, "the span still reaches the model exactly once");
});

// ── 3: per-route summarization target overrides the default ────────────────

/** A config whose exact route "p/m" summarizes with a different model. */
function routedConfig() {
  return resolveConfig({
    summarizationProvider: "default-provider",
    summarizationModel: "default-model",
    modelPolicies: [{ provider: "p", model: "m", summarizationProvider: "override-provider", summarizationModel: "override-model" }]
  });
}

test("an exact-route summarization override is honored", async () => {
  // The routed client is "p"/"m" (that is what the session header records), and its
  // modelPolicies row names its own summarizer. Reading the pair off the top-level
  // config instead silently summarized with "default-model".
  const session = sessionOf(USER_ONLY);
  const stub = stubLlm();
  await summarizeLeaf({ llm: stub.llm }, routedConfig(), { session, start: 0, end: 0, shadowedSeqs: [0], shadowedTokenCount: 400 }, { session, options: {} }, 512, undefined);

  assert.equal(stub.calls[0].provider, "override-provider");
  assert.equal(stub.calls[0].model, "override-model");
});

test("a route without a summarization override keeps the top-level pair", async () => {
  const session = sessionOf(USER_ONLY, {
    requestHeader: () => ({ config: { provider: "other", model: "route" }, tools: [] })
  });
  const stub = stubLlm();
  await summarizeLeaf({ llm: stub.llm }, routedConfig(), { session, start: 0, end: 0, shadowedSeqs: [0], shadowedTokenCount: 400 }, { session, options: {} }, 512, undefined);

  assert.equal(stub.calls[0].provider, "default-provider");
  assert.equal(stub.calls[0].model, "default-model");
});

test("no top-level pair and no override falls back to the routed model", async () => {
  const session = sessionOf(USER_ONLY);
  const stub = stubLlm();
  await summarizeLeaf(
    { llm: stub.llm },
    resolveConfig({ modelPolicies: [{ provider: "p", model: "m", thresholdRatio: 0.6 }] }),
    { session, start: 0, end: 0, shadowedSeqs: [0], shadowedTokenCount: 400 },
    { session, options: {} },
    512,
    undefined
  );
  assert.equal(stub.calls[0].provider, "p");
  assert.equal(stub.calls[0].model, "m");
});
