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

test("an empty summary degrades to a deterministic body instead of failing", async () => {
  // lcm-x's ladder reaches level 3 whenever the model produces nothing usable, and
  // its property is "guaranteed convergence". Measured twice in one subagent run:
  // the summariser answered with reasoning only, and our engine failed the whole
  // compaction. The deterministic body is built from the span, so it cannot be
  // empty and cannot exceed the budget.
  async function* reasoningOnly() {
    yield { type: "block-start", index: 0, blockType: "reasoning" };
    yield { type: "reasoning-delta", index: 0, text: "thinking" };
    yield { type: "finish", reason: { kind: "stop" }, replayState: undefined };
  }
  const stub = stubLlm([reasoningOnly]);
  const engine = engineWith(stub);
  const out = await engine.compile(prepared(), { session: prepared().session, options: {} }, undefined);
  const body = out.entries.map((entry) => entry.text).join("\n");

  assert.equal(stub.calls.length, 3, "the empty retries still happen before falling back");
  assert.ok(body.length > 0, "a checkpoint is produced, not a failure");
  assert.match(body, /DETERMINISTIC fallback/, "the entry header says the body is not a model summary");
  assert.match(body, /seq 0/, "and it carries per-seq pointers so the original is one lcm_expand away");
  assert.match(body, /do the thing/, "the span's own words survive");
  assert.ok(estimateEntryTokens(body) <= SHADOWED, "and the body still fits the shrink bound");
});

test("the deterministic body names the route it tried and records no cap", async () => {
  async function* reasoningOnly() {
    yield { type: "block-start", index: 0, blockType: "reasoning" };
    yield { type: "reasoning-delta", index: 0, text: "thinking" };
    yield { type: "finish", reason: { kind: "stop" }, replayState: undefined };
  }
  const stub = stubLlm([reasoningOnly]);
  const engine = engineWith(stub);
  const out = await engine.compile(prepared(), { session: prepared().session, options: {} }, undefined);

  // `compaction/summary.provider|model` are REQUIRED non-empty strings, and a
  // payload carrying `undefined` cannot be appended at all. Leaving them
  // undefined here is what made this rung - the one whose documented property is
  // "guaranteed convergence" - the only rung that could not commit.
  assert.equal(typeof out.provider, "string", "the record must name a provider");
  assert.ok(out.provider.length > 0);
  assert.equal(typeof out.model, "string");
  assert.ok(out.model.length > 0);
  // The honest value is the route this rung actually resolved and tried, and this
  // assertion is the drift guard: it compares against what the transport received.
  const last = stub.calls.at(-1);
  assert.equal(out.provider, last.provider, "the route named is the route the summarizer actually called");
  assert.equal(out.model, last.model);
  // No model wrote this body, so no completion cap produced it and none is claimed.
  assert.equal(out.maxTokens, undefined, "a deterministic body carries no generation cap");
});

test("a model-authored body records the cap the request actually sent", async () => {
  const stub = stubLlm([() => withText(FITTING)]);
  const engine = engineWith(stub);
  const out = await engine.compile(prepared(), { session: prepared().session, options: {} }, undefined);

  assert.equal(out.maxTokens, stub.calls[0].maxTokens, "the durable cap is the one the transport received");
  assert.equal(out.maxTokens, Math.max(4096, 2 * engine.effectiveMaxTokens(SHADOWED)), "which is max(4096, 2 x target)");
});

test("a transport failure still propagates: a rate limit is not a summary outcome", async () => {
  async function* rateLimited() {
    yield { type: "finish", reason: { kind: "error", failure: { message: "429 rate limit", code: "RATE_LIMIT" } }, replayState: undefined };
  }
  const stub = stubLlm([rateLimited]);
  const engine = engineWith(stub);
  await assert.rejects(
    engine.compile(prepared(), { session: prepared().session, options: {} }, undefined),
    (error) => /rate limit/i.test(String(error.message)),
    "routing must see the failure, so it can retry or switch model"
  );
});


// ── the rung must COMMIT, not only compile ─────────────────────────────────

/** Harness packages resolve only inside a dsh profile; outside one this skips. */
let harness = null;
try {
  const { Session } = await import("@deepseek-ai/dsh-session");
  const { createUserMessage, createAssistantMessage, createSystemMessage } = await import("@deepseek-ai/dsh-llm");
  const { Context } = await import("@deepseek-ai/cordis");
  const { TokenMeter } = await import("@deepseek-ai/dsh-token-meter");
  harness = { Session, createUserMessage, createAssistantMessage, createSystemMessage, Context, TokenMeter };
} catch {
  harness = null;
}

const T0 = 1790000000000;

/** Seed log for one real session: system head, a routed header, three turns. */
function realSeed(turns) {
  const { createUserMessage, createAssistantMessage, createSystemMessage } = harness;
  const seed = [];
  let seq = 0;
  const push = (event) => {
    seed.push({ ...event, seq, time: T0 + seq });
    seq += 1;
  };
  push({ type: "system/message", data: { message: createSystemMessage("system prompt for the deterministic-rung probe") }, surfaceOp: "append" });
  push({ type: "request/header", data: { header: { config: { provider: "probe-provider", model: "probe-model", maxTokens: 1024 } }, reason: "initial" } });
  for (let turn = 1; turn <= turns; turn += 1) {
    push({ type: "turn/start", data: { turn } });
    push({
      type: "user/message",
      data: createUserMessage({ content: [{ type: "text", text: "question " + turn + " NEEDLE_" + turn + " " + "x".repeat(400) }], source: { kind: "user" } }),
      surfaceOp: "append"
    });
    push({ type: "step/start", data: { turn, step: 1 } });
    push({
      type: "assistant/message",
      data: {
        message: createAssistantMessage({
          content: [{ type: "text", text: "answer " + turn + " " + "y".repeat(400) }],
          source: { kind: "model", provider: "probe-provider", model: "probe-model" }
        }),
        turn,
        step: 1,
        stream: []
      },
      surfaceOp: "append"
    });
    push({ type: "step/end", data: { turn, step: 1 } });
    push({ type: "turn/end", data: { turn } });
  }
  return seed;
}

/**
 * A real Session, a real TokenMeter and a real engine whose only stub is the
 * transport - and that transport answers with reasoning and no text at all.
 */
function reasoningOnlyWorld(turns) {
  const { Session, Context, TokenMeter } = harness;
  const session = Session.create("deterministic-rung-" + turns, realSeed(turns));
  const ctx = new Context();
  const calls = [];
  ctx.provide("llm");
  ctx.set("llm", {
    stream(options) {
      calls.push(options);
      return (async function* () {
        yield { type: "block-start", index: 0, blockType: "reasoning" };
        yield { type: "reasoning-delta", index: 0, text: "weighing the span" };
        yield { type: "finish", reason: { kind: "stop" }, replayState: undefined };
      })();
    },
    imageRequestPricing() {
      return undefined;
    },
    async resolveModelInfo() {
      return { context: { contextWindow: 200_000 }, defaultMaxTokens: 4096 };
    }
  });
  ctx.provide("sessions");
  ctx.set("sessions", { flush: async () => {} });
  new TokenMeter(ctx, {});
  // emptySummaryRetries 0: one attempt, then the ladder's level-3 rung.
  const engine = new LcmCompactionEngine(ctx, { auto: false, emptySummaryRetries: 0 });
  const agent = { session, options: {}, runMaintenance: (task) => task(new AbortController().signal) };
  return { session, engine, agent, calls };
}

test("the deterministic rung commits on a real Session", { skip: harness === null }, async () => {
  // The defect this test exists for: every other test in this file stopped at
  // `compile()`, which is exactly why it was invisible. Compiling was fine;
  // committing was not. `compile()` returned `provider: undefined`,
  // `commitCompactionBody` wrote it into the payload, `Session.append` validated
  // `snapshotJsonValue` and rejected the WHOLE payload, and because
  // `compaction/start` had already landed the transaction surfaced as
  // ManualCompactionError("commit") with the surface still full. The ladder's
  // guaranteed-convergence rung was the one rung that could never finish.
  // Eight turns: the deterministic body is capped at the 512-token summary floor
  // plus framing, so the span must be comfortably larger than that or the shrink
  // guarantee rejects the checkpoint before the commit is ever reached (measured
  // on three turns: 668 framed tokens against a 561-token span).
  const { session, engine, agent, calls } = reasoningOnlyWorld(8);
  const before = [...session.surface.nodes];

  const result = await engine.compactNow(agent, new AbortController().signal, "cmd-deterministic");

  assert.ok(result !== null, "the deterministic rung must produce a durable result, not a failure");
  assert.ok(session.surface.nodes.length < before.length, "and the surface must actually shrink");
  const summary = session.log.find((event) => event.type === "compaction/summary");
  assert.ok(summary !== undefined, "the summary record landed");
  // Every value in the payload survives the harness's own snapshot rule - which is
  // the rule that rejected it before.
  assert.equal(typeof summary.data.provider, "string", "provider is a string, never undefined");
  assert.ok(summary.data.provider.length > 0);
  assert.equal(typeof summary.data.model, "string");
  assert.ok(summary.data.model.length > 0);
  assert.equal(summary.data.provider, calls.at(-1).provider, "it names the route the summarizer actually called");
  assert.equal(summary.data.model, calls.at(-1).model);
  assert.equal("maxTokens" in summary.data, false, "no model produced this body, so it claims no generation cap");
  const end = session.log.find((event) => event.type === "compaction/end");
  assert.equal(end.data.error, undefined, "the transaction closed cleanly");
  assert.equal(session.log.filter((event) => event.type === "compaction/end").length, 1);

  const replacement = session.log.find((event) => event.type === "user/message" && event.data?.source?.kind === "compact-checkpoint");
  assert.ok(replacement !== undefined, "a checkpoint node replaced the span");
  assert.match(replacement.data.content.map((block) => block.text ?? "").join("\n"), /DETERMINISTIC fallback/, "and it says it is not a model summary");
});
