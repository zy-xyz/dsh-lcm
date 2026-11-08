/**
 * The "not worth compacting" guard on span selection.
 *
 * A live engine paid for a model call it could never have used:
 *
 *   [dsh-lcm] engine: summarize span=1 seqs=24-24 shadowedTokens=428 budget=512
 *   [dsh-lcm] engine: step compaction failed: lcm: summary truncated at the token cap
 *
 * The second span was a single node — the checkpoint the previous run had just
 * written — and the resolved summary budget (512, clamped up to
 * `summaryFloorTokens`) was LARGER than the 428 tokens it was replacing. The
 * shrink guarantee can never accept that checkpoint, so the attempt was wasted
 * before it started.
 *
 * `selectCompactableRange(session, measurement, retainTokens, minTokens = 0)`
 * now refuses such a span when the caller arms the floor. The default keeps the
 * historical selection byte for byte (the manual `/compact` path must compact
 * exactly what the user asked for, however small).
 *
 * Run with: node --test test/min-span.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { selectCompactableRange } from "../src/region.js";

let foldSurface;
try {
  ({ foldSurface } = await import("@deepseek-ai/dsh-session/surface"));
} catch {
  foldSurface = null;
}

/** The engine-level case needs the real session, meter and engine. */
let enginePackages;
try {
  const { Session } = await import("@deepseek-ai/dsh-session");
  const { createUserMessage, createAssistantMessage, createSystemMessage } = await import("@deepseek-ai/dsh-llm");
  const { Context } = await import("@deepseek-ai/cordis");
  const { TokenMeter } = await import("@deepseek-ai/dsh-token-meter");
  const { LcmCompactionEngine } = await import("../src/index.js");
  enginePackages = { Session, createUserMessage, createAssistantMessage, createSystemMessage, Context, TokenMeter, LcmCompactionEngine };
} catch {
  enginePackages = null;
}

const skip = foldSurface === null;
const skipEngine = enginePackages === null;

// ── fixture: a real fold, equal-price pricing ──────────────────────────────

const SURFACE_TYPES = new Set(["system/message", "developer/message", "user/message", "assistant/message", "tool/result"]);

function withMarker(event) {
  if (SURFACE_TYPES.has(event.type)) {
    return event.surfaceOp === undefined ? { ...event, surfaceOp: "append" } : event;
  }
  const { surfaceOp, sourceEventSeqs, ...rest } = event;
  return rest;
}

/** A session whose surface is folded by the harness's own implementation. */
function makeSession(events) {
  const list = events.map(withMarker);
  return {
    id: "min-span",
    events: list,
    get surface() {
      const folded = foldSurface(list);
      return { nodes: folded.nodes, replaceGeneration: folded.replaceGeneration ?? 0 };
    },
    eventAt: (seq) => list.find((e) => e.seq === seq),
    deriveEventMessage: (event) => event.message ?? event.data?.message ?? null,
    requestHeader: () => ({ config: { provider: "p", model: "m" }, tools: [] }),
    append(type, data, metadata) {
      const event = withMarker({ type, seq: list.length, time: 1_790_000_000_000 + list.length, data, ...(metadata ?? {}) });
      foldSurface([...list, event]);
      list.push(event);
      return event;
    }
  };
}

/** Three turns of user/assistant traffic: a 7-node surface, no tool pairs. */
function plainEvents(turns = 3) {
  const events = [
    { type: "system/message", seq: 0, time: 1, data: { message: { role: "system", content: [{ type: "text", text: "sys" }] } } }
  ];
  let seq = 1;
  for (let turn = 1; turn <= turns; turn += 1) {
    events.push({ type: "turn/start", seq: seq++, time: 1, data: { turn } });
    events.push({ type: "user/message", seq: seq++, time: 1, data: { content: [{ type: "text", text: "question " + turn }] } });
    events.push({
      type: "assistant/message",
      seq: seq++,
      time: 1,
      data: { turn, step: 1, message: { role: "assistant", content: [{ type: "text", text: "answer " + turn }] } }
    });
    events.push({ type: "turn/end", seq: seq++, time: 1, data: { turn } });
  }
  return events;
}

/** Equal pricing for every surface node. */
function fixedPrice(session, price) {
  const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: price }));
  return { nodes, totalTokens: nodes.length * price };
}

/** The surface seqs one selected range covers, inclusive. */
function spanOf(session, range) {
  const nodes = session.surface.nodes;
  return nodes.slice(nodes.indexOf(range.start), nodes.indexOf(range.end) + 1);
}

// ── 1: a span the summary could never undercut is not selected ─────────────

test("a span under the summary floor (or a lone node) is refused when the floor is armed", { skip }, () => {
  // Multi-node, but 5 × 80 = 400 tokens: below the 512 default floor, so the
  // clamped budget (512) is larger than the span and the shrink guarantee must
  // reject whatever comes back.
  const small = makeSession(plainEvents(3));
  const smallPricing = fixedPrice(small, 80);
  const baseline = selectCompactableRange(small, smallPricing, 0);
  assert.ok(baseline !== null, "the unarmed selector still returns this span");
  assert.equal(spanOf(small, baseline).length, 5);
  assert.equal(selectCompactableRange(small, smallPricing, 0, 512), null, "400 tokens is not worth a 512-token summary");

  // One node: the incident shape — the previous run's checkpoint, re-selected.
  const single = makeSession(plainEvents(3));
  const singlePricing = fixedPrice(single, 100);
  const singleRange = selectCompactableRange(single, singlePricing, 500);
  assert.ok(singleRange !== null);
  assert.equal(singleRange.start, singleRange.end, "the unarmed selector does return a one-node span");
  assert.equal(selectCompactableRange(single, singlePricing, 500, 512), null, "a lone 100-token node is not worth a summary");

  // One node that is LARGE: selected, because the rule is arithmetic, not shape.
  // A lone 1000-token node gets a 512-token budget and does shrink; refusing it
  // by node count would also refuse the case compaction exists for — one huge
  // tool result. The incident that motivated this guard was a 428-token node,
  // which the token floor already refuses.
  const large = makeSession(plainEvents(3));
  const largePricing = fixedPrice(large, 1000);
  const largeRange = selectCompactableRange(large, largePricing, 5000);
  assert.ok(largeRange !== null);
  assert.equal(largeRange.start, largeRange.end);
  assert.ok(1000 > 512, "this span clears the floor");
  assert.equal(
    selectCompactableRange(large, largePricing, 5000, 512)?.start,
    largeRange.start,
    "a lone node above the floor is still compactable"
  );
});

// ── 2: the engine never pays for such a span ────────────────────────────────

/** Fixed clock so the seeded log is byte-stable. */
const T0 = 1790000000000;

/**
 * A real session whose compactable prefix is ONE tiny node and whose retained
 * tail is one huge node: the exact pressure shape that produced the incident.
 * @returns the seed events.
 */
function incidentSeed() {
  const { createUserMessage, createAssistantMessage, createSystemMessage } = enginePackages;
  const seed = [];
  let seq = 0;
  const push = (event) => {
    seed.push({ ...event, seq: seq, time: T0 + seq });
    seq += 1;
  };
  push({ type: "system/message", data: { message: createSystemMessage("system prompt") }, surfaceOp: "append" });
  push({ type: "request/header", data: { header: { config: { provider: "probe-provider", model: "probe-model", maxTokens: 512 } }, reason: "initial" } });
  push({ type: "turn/start", data: { turn: 1 } });
  push({
    type: "user/message",
    data: createUserMessage({ content: [{ type: "text", text: "question 1 NEEDLE_1" }], source: { kind: "user" } }),
    surfaceOp: "append"
  });
  push({ type: "step/start", data: { turn: 1, step: 1 } });
  push({
    type: "assistant/message",
    data: {
      message: createAssistantMessage({
        content: [{ type: "text", text: "y".repeat(12000) }],
        source: { kind: "model", provider: "probe-provider", model: "probe-model" }
      }),
      turn: 1,
      step: 1,
      stream: []
    },
    surfaceOp: "append"
  });
  push({ type: "step/end", data: { turn: 1, step: 1 } });
  push({ type: "turn/end", data: { turn: 1 } });
  return seed;
}

/** The real world with only the LLM transport and the idle gate stubbed. */
function buildWorld(engineConfig) {
  const { Session, Context, TokenMeter, LcmCompactionEngine } = enginePackages;
  const session = Session.create("min-span-engine", incidentSeed());
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
      })("## 逐字锚点\n- NEEDLE_1");
    },
    imageRequestPricing() {
      return undefined;
    },
    async resolveModelInfo() {
      return { context: { contextWindow: 4096 }, defaultMaxTokens: 512 };
    }
  });
  ctx.provide("sessions");
  ctx.set("sessions", { flush: async () => {} });
  const meter = new TokenMeter(ctx, {});
  const engine = new LcmCompactionEngine(ctx, { auto: false, ...engineConfig });
  const agent = { session, options: {}, runMaintenance: (task) => task(new AbortController().signal) };
  return { session, meter, engine, agent, llmCalls };
}

test("pressure never buys a summary for a span below its own floor", { skip, skipEngine }, async () => {
  // headroom 1024 over a 4096 window reserving 512: threshold 2560, retain 200.
  const world = buildWorld({ headroomTokens: 1024, retainTokens: 200 });
  const measurement = world.meter.measure(world.session);
  assert.ok(measurement.totalTokens >= 2560, "the fixture must be over the pressure threshold, got " + measurement.totalTokens);

  // The selected span really is the single 13-token user node.
  const range = selectCompactableRange(world.session, measurement, 200);
  assert.ok(range !== null);
  assert.equal(range.start, range.end, "the compactable prefix must be one node");
  assert.equal(measurement.nodes.find((node) => node.seq === range.start).tokens < 512, true);

  assert.equal(await world.engine.compactIfNeeded(world.agent, "pressure", new AbortController().signal), null);
  assert.equal(world.llmCalls.length, 0, "a span under the floor must not cost a model call");
  assert.equal(world.session.log.some((event) => event.type === "compaction/start"), false, "no transaction may be opened");
  assert.equal(world.session.log.some((event) => event.type === "compaction/summary"), false);
});

// ── 3: the normal case still compacts ──────────────────────────────────────

test("a normal multi-node span above the floor is still selected", { skip }, () => {
  const session = makeSession(plainEvents(3));
  const measurement = fixedPrice(session, 200); // 5-node span, 1000 tokens
  const gated = selectCompactableRange(session, measurement, 0, 512);
  assert.ok(gated !== null, "1000 tokens over a 512-token floor is worth a summary");
  assert.deepEqual(gated, { start: session.surface.nodes[1], end: session.surface.nodes[5] });
  assert.equal(spanOf(session, gated).length, 5);
});

// ── 4: the default argument changes nothing ────────────────────────────────

test("an unarmed floor is byte-identical to the previous selection", { skip }, () => {
  const shapes = [
    [makeSession(plainEvents(3)), fixedPrice, 80, 0],
    [makeSession(plainEvents(3)), fixedPrice, 100, 0],
    [makeSession(plainEvents(3)), fixedPrice, 100, 500],
    [makeSession(plainEvents(3)), fixedPrice, 1000, 5000],
    [makeSession(plainEvents(4)), fixedPrice, 100, 200]
  ];
  for (const [session, price, perNode, retainTokens] of shapes) {
    const measurement = price(session, perNode);
    assert.deepEqual(
      selectCompactableRange(session, measurement, retainTokens, 0),
      selectCompactableRange(session, measurement, retainTokens),
      "minTokens=0 must reproduce the three-argument selection exactly"
    );
  }

  // The boundary is a refusal, not a gamble: at spanTokens === floor the budget
  // IS the span, and a framed checkpoint is always bigger than that.
  const session = makeSession(plainEvents(3));
  const measurement = fixedPrice(session, 150); // exactly 5 × 150 = 750 tokens
  assert.equal(selectCompactableRange(session, measurement, 0, 750), null, "750 tokens against a 750-token floor cannot shrink");
  assert.ok(selectCompactableRange(session, measurement, 0, 749) !== null, "749 leaves room to shrink");
});
