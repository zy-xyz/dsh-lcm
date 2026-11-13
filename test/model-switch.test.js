/**
 * The model-switch gate: `agent/request` must price the PROPOSED model.
 *
 * Switching to a model with a smaller context window is a pressure event that has
 * not happened yet — the durable header still describes the old model. Without this
 * listener the switch was admitted and then failed mid-turn with a provider
 * context-window error, after the request had been prepared; `dsh-compaction-basic`
 * instead compacts against the proposed envelope and REFUSES the switch when it
 * cannot get the history below the new threshold, with
 * `MODEL_SWITCH_COMPACTION_FAILED`.
 *
 * Run with: node --test test/model-switch.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

let harnessPackages;
try {
  const { Session } = await import("@deepseek-ai/dsh-session");
  const { createUserMessage, createAssistantMessage, createSystemMessage, LlmError } = await import("@deepseek-ai/dsh-llm");
  const { Context } = await import("@deepseek-ai/cordis");
  const { TokenMeter } = await import("@deepseek-ai/dsh-token-meter");
  const { LcmCompactionEngine } = await import("../src/index.js");
  harnessPackages = { Session, createUserMessage, createAssistantMessage, createSystemMessage, LlmError, Context, TokenMeter, LcmCompactionEngine };
} catch {
  harnessPackages = null;
}

const skip = harnessPackages === null;
const T0 = 1790000000000;

/** A model summary short enough to shrink any seeded span. */
const MODEL_SUMMARY = "## 逐字锚点\n- NEEDLE_1\n## 目标与约束\n- 压缩";

/**
 * Seed: a system head, one durable routed header, and `turns` complete turns.
 * @param turns - complete turns to seed, 1 or more.
 * @returns borrowed seed events.
 */
function seedFor(turns = 3) {
  const { createUserMessage, createAssistantMessage, createSystemMessage } = harnessPackages;
  const seed = [];
  let seq = 0;
  const push = (event) => {
    seed.push({ ...event, seq: seq, time: T0 + seq });
    seq += 1;
  };
  push({ type: "system/message", data: { message: createSystemMessage("system prompt") }, surfaceOp: "append" });
  push({ type: "request/header", data: { header: { config: { provider: "big", model: "window", maxTokens: 512 } }, reason: "initial" } });
  for (let turn = 1; turn <= turns; turn += 1) {
    push({ type: "turn/start", data: { turn: turn } });
    push({
      type: "user/message",
      data: createUserMessage({ content: [{ type: "text", text: "question " + turn + " " + "x".repeat(600) }], source: { kind: "user" } }),
      surfaceOp: "append"
    });
    push({ type: "step/start", data: { turn: turn, step: 1 } });
    push({
      type: "assistant/message",
      data: {
        message: createAssistantMessage({ content: [{ type: "text", text: "answer " + turn + " " + "y".repeat(600) }], source: { kind: "model", provider: "big", model: "window" } }),
        turn: turn,
        step: 1,
        stream: []
      },
      surfaceOp: "append"
    });
    push({ type: "step/end", data: { turn: turn, step: 1 } });
    push({ type: "turn/end", data: { turn: turn } });
  }
  // A real `agent/request` fires INSIDE a turn: it prepares that turn's next
  // request. Automatic compaction events must be enclosed in a turn, so the
  // fixture leaves one open, exactly as the live dispatch does.
  push({ type: "turn/start", data: { turn: turns + 1 } });
  return seed;
}

/**
 * A real session, meter, context and engine on `auto: true`, so the automatic
 * listeners are the ones under test. Only the LLM transport is stubbed.
 * @param windowOf - context window per "provider/model" key.
 * @param turns - turns to seed.
 * @returns the world plus its observation points.
 */
function buildWorld(windowOf, turns = 3) {
  const { Session, Context, TokenMeter, LcmCompactionEngine } = harnessPackages;
  const session = Session.create("model-switch", seedFor(turns));
  const ctx = new Context();
  const llmCalls = [];
  ctx.provide("llm");
  ctx.set("llm", {
    stream(options) {
      llmCalls.push(options);
      return (async function* textStream(text) {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: text };
        yield { type: "block-end", index: 0, block: { type: "text", text: text } };
        yield { type: "finish", reason: { kind: "stop" }, replayState: undefined };
      })(MODEL_SUMMARY);
    },
    imageRequestPricing() {
      return undefined;
    },
    async resolveModelInfo(provider, model) {
      const window = windowOf[`${provider}/${model}`];
      return window === undefined ? {} : { context: { contextWindow: window }, defaultMaxTokens: 512 };
    }
  });
  ctx.provide("sessions");
  ctx.set("sessions", { flush: async () => {} });
  const meter = new TokenMeter(ctx, {});
  // headroom 128 over the 1024-token window used below: threshold 384 tokens, and
  // the seeded three-turn history prices at 974. The default 65536 headroom would
  // make every window in this fixture unreachable, and the point of the test is the
  // switch decision, not the pressure arithmetic (test/min-span.test.js owns that).
  // `summaryFloorTokens` is pinned to the historical 512 on purpose. The shipping
  // floor is 2 000 (lcm-x `leaf_target_min_tokens`) and the selector refuses a span
  // at or below TWICE it, so this fixture — whose whole history prices under 2 000 —
  // would have nothing compactable and the switch would be refused for the span
  // floor rather than for the window it is meant to test.
  const engine = new LcmCompactionEngine(ctx, { auto: true, headroomTokens: 128, summaryFloorTokens: 512 });
  const agent = { session: session, options: {} };
  return { session: session, ctx: ctx, meter: meter, engine: engine, agent: agent, llmCalls: llmCalls };
}

/** Dispatch the model-switch waterfall exactly as the agent loop does. */
function propose(world, proposed, signal = new AbortController().signal) {
  return world.ctx.waterfall("agent/request", { agent: world.agent, signal }, () => proposed);
}

const compactionEvents = (session) => session.log.filter((event) => event.type === "compaction/summary").length;

// ── 1: the switch is priced on the PROPOSED model ──────────────────────────

test("switching to a smaller window compacts against the new model before admitting it", { skip }, async () => {
  // The history fits "big/window" (200k) but not "small/window" (4096): the new
  // threshold must drive the decision, which is only possible if the proposed
  // envelope is the one being priced.
  // Five turns, not three: the default summaryFloorTokens of 512 refuses a span at
  // or below 2 * 512 tokens, and a three-turn history prices at 974 — below that
  // floor, so nothing would be compactable and the switch would be refused for the
  // span floor rather than for the window.
  const world = buildWorld({ "big/window": 200000, "small/window": 1536 }, 5);
  const proposed = { provider: "small", model: "window", maxTokens: 512 };
  const returned = await propose(world, proposed);

  assert.deepEqual(returned, proposed, "the proposed config is returned unchanged when compaction succeeds");
  assert.equal(world.llmCalls.length, 1, "exactly one summarization call");
  assert.equal(compactionEvents(world.session), 1, "one durable checkpoint was committed before the switch");
});

test("a switch that needs no compaction costs no model call", { skip }, async () => {
  const world = buildWorld({ "big/window": 200000, "roomy/window": 200000 });
  const proposed = { provider: "roomy", model: "window", maxTokens: 512 };
  const returned = await propose(world, proposed);

  assert.deepEqual(returned, proposed);
  assert.equal(world.llmCalls.length, 0, "room to spare must not buy a summary");
  assert.equal(compactionEvents(world.session), 0);
});

test("re-selecting the same route is a no-op", { skip }, async () => {
  const world = buildWorld({ "big/window": 200000, "small/window": 4096 });
  const proposed = { provider: "big", model: "window", maxTokens: 512 };
  const returned = await propose(world, proposed);

  assert.deepEqual(returned, proposed, "no switch, no compaction, no refusal");
  assert.equal(world.llmCalls.length, 0);
});

// ── 2: a switch that cannot fit is REFUSED, with the contract code ──────────

test("a switch whose target has no capacity is refused with MODEL_SWITCH_COMPACTION_FAILED", { skip }, async () => {
  const world = buildWorld({ "big/window": 200000 });
  const { LlmError } = harnessPackages;
  const proposed = { provider: "ghost", model: "route" };

  await assert.rejects(
    () => propose(world, proposed),
    (error) => {
      assert.ok(error instanceof LlmError, "the refusal must be an LlmError so the harness surfaces it as a model-switch failure");
      assert.equal(error.code, "MODEL_SWITCH_COMPACTION_FAILED");
      assert.match(error.message, /Cannot switch to ghost\/route/);
      assert.match(error.message, /context compaction failed/);
      assert.match(error.message, /previous request model is preserved/);
      return true;
    }
  );
});

test("a refused switch leaves the previous route as the durable header", { skip }, async () => {
  // The header is what the NEXT request is priced against, so a refused switch must
  // not have moved it.
  const world = buildWorld({ "big/window": 200000 });
  const before = world.session.requestHeader();
  await assert.rejects(() => propose(world, { provider: "ghost", model: "route" }), (error) => error.code === "MODEL_SWITCH_COMPACTION_FAILED");
  const after = world.session.requestHeader();
  assert.equal(after.config.provider, before.config.provider);
  assert.equal(after.config.model, before.config.model);
});

test("an empty proposed route is passed through untouched", { skip }, async () => {
  const world = buildWorld({ "big/window": 200000 });
  const proposed = { provider: "", model: "" };
  assert.deepEqual(await propose(world, proposed), proposed, "a cleared route is not a switch");
  assert.equal(world.llmCalls.length, 0);
});

test("a cancelled turn does not compact and does not refuse", { skip }, async () => {
  const world = buildWorld({ "big/window": 200000, "small/window": 4096 });
  const controller = new AbortController();
  const proposed = { provider: "small", model: "window" };
  controller.abort();
  const returned = await propose(world, proposed, controller.signal);
  assert.deepEqual(returned, proposed);
  assert.equal(world.llmCalls.length, 0, "cancellation wins over the switch gate");
});
