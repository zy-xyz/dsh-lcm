/**
 * The manual \`/compact\` path, driven end to end on a REAL \`@deepseek-ai/dsh-session\`
 * \`Session\`.
 *
 * Every other test in this repo builds a session-shaped fixture. That is exactly
 * how the plugin once shipped a 100%-broken manual path: the fixtures carried an
 * \`events\` array and a fake \`surface\`, so \`compactNow\` looked green while the
 * first real \`Session\` threw on \`session.events\`, and \`dsh headless\` never
 * exercises a slash command. The automatic pressure path has since been proven on
 * a live engine + live session; this file proves the OTHER entry point —
 * \`engine.compactNow(agent, signal, commandId)\`, the seam the \`/compact\` command
 * calls — on the real class, with the real \`TokenMeter\`, the real summarizer and a
 * real \`foldSurface\` replacement.
 *
 * Only two things are stubbed, both at the process edge:
 *   - the LLM transport (\`llm.stream\` / \`resolveModelInfo\`): a local text stream,
 *     no network;
 *   - \`agent.runMaintenance\`, the harness's idle-agent gate, which is a
 *     scheduling primitive rather than session state.
 *
 * Everything that ever broke in production — the log accessors, the token meter,
 * the surface replacement contract, the \`sourceCommandId\` provenance — is the
 * real implementation.
 *
 * Run with: node --test test/manual-compact.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { findCheckpointSeqs, recallSession } from "../src/recall.js";

/**
 * Load the harness packages. They only resolve inside a dsh profile; outside one
 * every test here skips rather than failing on a missing peer dependency.
 */
let harnessPackages;
try {
  const { Session } = await import("@deepseek-ai/dsh-session");
  const { createUserMessage, createAssistantMessage, createSystemMessage } = await import("@deepseek-ai/dsh-llm");
  const { Context } = await import("@deepseek-ai/cordis");
  const { TokenMeter } = await import("@deepseek-ai/dsh-token-meter");
  const { LcmCompactionEngine } = await import("../src/index.js");
  harnessPackages = { Session, createUserMessage, createAssistantMessage, createSystemMessage, Context, TokenMeter, LcmCompactionEngine };
} catch {
  harnessPackages = null;
}

const skip = harnessPackages === null;

/** Fixed clock so the seeded log is byte-stable across runs. */
const T0 = 1790000000000;

/** Fillers long enough that the leaf summary is a real reduction. */
const QUESTION_FILLER = "x".repeat(400);
const ANSWER_FILLER = "y".repeat(400);

/** What the stubbed model returns; contains one anchor present in the span. */
const MODEL_SUMMARY = "## 逐字锚点\n- NEEDLE_1\n## 目标与约束\n- 压缩上下文";

/**
 * Seed log for one real session: a system head, one durable routed request
 * header (so summary routing reads a real header fold), and one
 * user/step/assistant/step/end group per turn.
 * @param turns - number of complete turns to seed (0 = system head only).
 * @returns borrowed seed events, seqs 0..n-1.
 */
function seedFor(turns) {
  const { createUserMessage, createAssistantMessage, createSystemMessage } = harnessPackages;
  const seed = [];
  let seq = 0;
  const push = (event) => {
    seed.push({ ...event, seq: seq, time: T0 + seq });
    seq += 1;
  };
  push({ type: "system/message", data: { message: createSystemMessage("system prompt for the manual-compact probe") }, surfaceOp: "append" });
  // An empty tool list is rejected by the real validator; a tool-less header omits it.
  push({ type: "request/header", data: { header: { config: { provider: "probe-provider", model: "probe-model", maxTokens: 1024 } }, reason: "initial" } });
  for (let turn = 1; turn <= turns; turn += 1) {
    push({ type: "turn/start", data: { turn: turn } });
    push({
      type: "user/message",
      data: createUserMessage({ content: [{ type: "text", text: "question " + turn + " NEEDLE_" + turn + " " + QUESTION_FILLER }], source: { kind: "user" } }),
      surfaceOp: "append"
    });
    push({ type: "step/start", data: { turn: turn, step: 1 } });
    push({
      type: "assistant/message",
      data: {
        message: createAssistantMessage({
          content: [{ type: "text", text: "answer " + turn + " " + ANSWER_FILLER }],
          source: { kind: "model", provider: "probe-provider", model: "probe-model" }
        }),
        turn: turn,
        step: 1,
        // The real settlement shape: a compacted stream record; empty is valid.
        stream: []
      },
      surfaceOp: "append"
    });
    push({ type: "step/end", data: { turn: turn, step: 1 } });
    push({ type: "turn/end", data: { turn: turn } });
  }
  return seed;
}

/** One text-only model response, in the harness's chunk protocol. */
async function* textStream(text) {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text: text };
  yield { type: "block-end", index: 0, block: { type: "text", text: text } };
  yield { type: "finish", reason: { kind: "stop" }, replayState: undefined };
}

/**
 * Build a real-session world: a real Session, a real TokenMeter and a real
 * LcmCompactionEngine on a real Cordis context, with only the LLM transport and
 * the agent's idle gate stubbed.
 * @param seed - borrowed seed events for the real session.
 * @param contextWindow - routed model window the automatic path prices against.
 * @returns the world plus its observation points.
 */
function buildWorld(seed, contextWindow) {
  const { Session, Context, TokenMeter, LcmCompactionEngine } = harnessPackages;
  const session = Session.create("manual-compact-" + seed.length, seed);
  const ctx = new Context();
  const llmCalls = [];
  const flushes = { count: 0 };
  // cordis: a service must be declared before it can be set, as the loader does.
  ctx.provide("llm");
  ctx.set("llm", {
    stream(options) {
      llmCalls.push(options);
      return textStream(MODEL_SUMMARY);
    },
    imageRequestPricing() {
      return undefined;
    },
    async resolveModelInfo() {
      return { context: { contextWindow: contextWindow }, defaultMaxTokens: 4096 };
    }
  });
  ctx.provide("sessions");
  ctx.set("sessions", {
    flush: async () => {
      flushes.count += 1;
    }
  });
  const meter = new TokenMeter(ctx, {});
  const engine = new LcmCompactionEngine(ctx, { auto: false });
  const agent = {
    session: session,
    options: {},
    // The idle-agent gate: run this one maintenance task under a live signal.
    runMaintenance: (task) => task(new AbortController().signal)
  };
  return { session: session, ctx: ctx, meter: meter, engine: engine, agent: agent, llmCalls: llmCalls, flushes: flushes };
}

/** One world with a number of complete seeded turns. */
function world(turns, contextWindow = 200000) {
  return buildWorld(seedFor(turns), contextWindow);
}

/** The one surface-replacing checkpoint record, or undefined. */
function checkpointRecord(session) {
  return session.log.find((event) => event.type === "user/message" && event.surfaceOp !== undefined && event.surfaceOp !== "append" && event.surfaceOp.op === "replace");
}

/** Seq of the single event of one type, failing loudly on zero or duplicate. */
function onlySeq(session, type) {
  const matches = session.log.filter((event) => event.type === type);
  assert.equal(matches.length, 1, "expected exactly one " + type + " record");
  return matches[0].seq;
}

// ── the manual transaction ─────────────────────────────────────────────────

test("compactNow runs the manual /compact transaction on a real Session", { skip }, async () => {
  const { session, engine, agent, llmCalls, flushes } = world(3);

  // The shape that broke production: no events property, a log and a frozen
  // snapshot accessor, a folded surface. Nothing below may need a fixture.
  assert.equal("events" in session, false, "a real Session has no events property");
  assert.ok(Array.isArray(session.log));
  assert.ok(Object.isFrozen(session.snapshotEvents()));
  const surfaceBefore = [...session.surface.nodes];
  const retainedTail = surfaceBefore[surfaceBefore.length - 1];

  const result = await engine.compactNow(agent, new AbortController().signal, "cmd-1");

  assert.ok(result !== null, "manual compaction must produce a result");
  assert.equal(result.sourceCommandId, "cmd-1", "the result echoes the initiating command id");

  // Exactly one positional replacement, whose surfaceOp is EXACTLY the contract:
  // three own keys, both seqs safe integers.
  const replacement = checkpointRecord(session);
  assert.ok(replacement !== undefined, "the manual path must land one replacing checkpoint node");
  assert.deepEqual(Object.keys(replacement.surfaceOp).sort(), ["endSeq", "op", "startSeq"]);
  assert.deepEqual(replacement.surfaceOp, { op: "replace", startSeq: result.shadowedRange.start, endSeq: result.shadowedRange.end });
  assert.ok(Number.isSafeInteger(replacement.surfaceOp.startSeq) && Number.isSafeInteger(replacement.surfaceOp.endSeq));

  // start -> summary -> end, once each, in that order, on one transaction.
  const startSeq = onlySeq(session, "compaction/start");
  const summarySeq = onlySeq(session, "compaction/summary");
  const endSeq = onlySeq(session, "compaction/end");
  assert.ok(startSeq < summarySeq && summarySeq < endSeq, "markers must be ordered, got " + startSeq + "/" + summarySeq + "/" + endSeq);
  assert.deepEqual([result.startSeq, result.summarySeq, result.endSeq], [startSeq, summarySeq, endSeq]);
  const startEvent = session.eventAt(startSeq);
  const summaryEvent = session.eventAt(summarySeq);
  // The durable record names the TARGET the instruction asked for, and carries
  // no `maxTokens`: the request never had one, so recording one would claim a
  // cap that was never sent.
  assert.equal(summaryEvent.data.targetTokens, engine.effectiveMaxTokens(result.shadowedTokenCount), "the record names the instruction target");
  assert.equal("maxTokens" in summaryEvent.data, false, "no request cap is recorded because none was sent");
  const endEvent = session.eventAt(endSeq);
  assert.equal(endEvent.data.error, undefined, "a clean manual compaction records no error");
  assert.equal(endEvent.data.turn, null, "an idle manual compaction has no open turn to bracket");

  // The command identity is durable on every record of the transaction: that is
  // what a UI correlates a manual run against, so it has to survive the log.
  for (const event of [startEvent, summaryEvent, endEvent]) {
    assert.equal(event.data.sourceCommandId, "cmd-1", event.type + " must carry sourceCommandId");
    assert.equal(event.data.compactionId, startEvent.data.compactionId, event.type + " must share one compactionId");
  }
  assert.equal(replacement.data.source.sourceCommandId, "cmd-1", "the checkpoint node carries the command id too");
  assert.equal(replacement.data.source.kind, "compact-checkpoint");

  // The surface really shrank, keeps the verbatim tail, and carries the checkpoint.
  assert.ok(session.surface.nodes.length < surfaceBefore.length, "the surface must shrink");
  assert.deepEqual(session.surface.nodes, [surfaceBefore[0], replacement.seq, retainedTail], "head + checkpoint + retained tail, in position");
  assert.deepEqual(findCheckpointSeqs(session), [replacement.seq], "the landed checkpoint is discoverable through the log accessor");

  // Durability checkpoint ran once, and the summary used the real routed route.
  assert.equal(flushes.count, 1, "manual compaction must flush the session exactly once");
  assert.equal(llmCalls.length, 1, "one leaf summarization per manual compaction");
  assert.equal(llmCalls[0].purpose, "compaction");
  assert.equal(llmCalls[0].provider, "probe-provider", "the route comes from the real request/header fold");
  assert.equal(llmCalls[0].model, "probe-model");
  assert.equal("maxTokens" in llmCalls[0], false, "the request carries no completion cap: the provider default applies");
  assert.match(
    llmCalls[0].messages[llmCalls[0].messages.length - 1].content[0].text,
    new RegExp("Aim for roughly " + engine.effectiveMaxTokens(result.shadowedTokenCount) + " tokens"),
    "the instruction still names the resolved target for the shadowed span"
  );
  assert.match(llmCalls[0].messages[llmCalls[0].messages.length - 1].content[0].text, /逐字锚点/u, "the instruction is the last message");

  // Both records of the transaction are recoverable by seq on the real shape.
  const fromSummary = recallSession(session, [{ start: summarySeq, end: summarySeq }], { maxRecallTokens: 8000 });
  assert.equal(fromSummary.missing, 0, "the summary record must resolve by seq");
  assert.match(fromSummary.text, /逐字锚点/u);
  assert.match(fromSummary.text, /NEEDLE_1/u);
  const fromCheckpoint = recallSession(session, [{ start: replacement.seq, end: replacement.seq }], { maxRecallTokens: 8000 });
  assert.equal(fromCheckpoint.missing, 0);
  assert.match(fromCheckpoint.text, /手动 \/compact/u, "the checkpoint names the manual path it came from");
  assert.match(fromCheckpoint.text, /LCM checkpoint: 5 nodes/u);
  assert.match(fromCheckpoint.text, /NEEDLE_1 \(seq 3\)/u, "anchors keep their seq pointers");
  assert.match(fromCheckpoint.text, /尾部原文保留/u, "the retained tail is announced, not silently assumed");
});

// ── the two entry points are genuinely different ───────────────────────────

test("manual /compact is a different entry point from automatic pressure", { skip }, async () => {
  const { session, engine, agent, meter } = world(3);
  const signal = new AbortController().signal;

  // Well below the pressure threshold: the automatic path is a no-op and says so
  // by returning null without writing anything.
  assert.ok(meter.measure(session).totalTokens < 100000, "the seeded session stays far below the pressure threshold");
  assert.equal(await engine.compactIfNeeded(agent, "pressure", signal), null);
  assert.equal(session.log.some((event) => event.type === "compaction/start"), false, "the pressure path must not open a transaction");

  // The manual path is NOT gated by the threshold: same session, same meter.
  const result = await engine.compactNow(agent, signal, "cmd-2");
  assert.ok(result !== null, "the manual path compacts below the threshold, which is the whole point of /compact");

  // And the pressure path is still a no-op afterwards: it is a threshold gate,
  // not a "compact when idle" fallback for the manual run.
  assert.equal(await engine.compactIfNeeded(agent, "pressure", signal), null);
  assert.equal(session.log.filter((event) => event.type === "compaction/start").length, 1);
});

// ── the boundary: nothing to compact is not an error ───────────────────────

test("compactNow returns null instead of throwing when there is no compactable range", { skip }, async () => {
  const signal = new AbortController().signal;

  // One node: a system head that is never compacted.
  const single = world(0);
  assert.deepEqual(single.session.surface.nodes, [single.session.log[0].seq], "a system head is the whole surface");
  assert.equal(await single.engine.compactNow(single.agent, signal, "cmd-3"), null, "a one-node surface has no range");
  assert.equal(single.session.log.some((event) => event.type === "compaction/start"), false, "nothing may be opened");
  assert.equal(single.flushes.count, 0);
  assert.equal(single.llmCalls.length, 0, "no range means no model call");

  // Two nodes: the only candidate is the trailing node, which is retained.
  const pair = buildWorld(seedFor(1).slice(0, 4), 200000);
  assert.equal(pair.session.surface.nodes.length, 2, "system head plus one user message");
  assert.equal(await pair.engine.compactNow(pair.agent, signal, "cmd-4"), null, "the trailing node is never compacted");
  assert.equal(pair.session.log.some((event) => event.type === "compaction/start"), false);
  assert.equal(pair.llmCalls.length, 0);
});
