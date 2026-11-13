// ── a checkpoint seq is not a message event ───────────────────────────────
import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfig } from "../src/config.js";
import { summarizeLeaf } from "../src/summarize.js";

/** A ctx whose stream always answers with one text block. */
function stubCtx() {
  const calls = [];
  return {
    calls,
    llm: {
      async *stream(options) {
        calls.push(options);
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "(seq 1) did the thing" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "(seq 1) did the thing" } };
        yield { type: "finish", reason: { kind: "stop" }, replayState: undefined };
      }
    }
  };
}

/**
 * A session whose events are `compaction/summary`, i.e. NOT messages.
 * `deriveEventMessage` returns null for those, which is the whole defect.
 */
function checkpointOnlySession(body) {
  const events = [{ type: "compaction/summary", seq: 5, time: 1, data: { summary: [{ type: "text", text: body }] } }];
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  return {
    id: "rollup-probe",
    events,
    eventAt: (seq) => bySeq.get(seq),
    // Exactly what a real Session does with a non-message event.
    deriveEventMessage: (event) => event?.data?.message ?? null,
    requestHeader: () => ({ config: { provider: "p", model: "m" }, tools: [] })
  };
}

test("a span of checkpoints refuses without documents — the defect, pinned", async () => {
  const session = checkpointOnlySession("## checkpoint\n- built the thing");
  const prepared = { session, shadowedSeqs: [5], shadowedTokenCount: 100 };
  await assert.rejects(
    summarizeLeaf(stubCtx(), resolveConfig({}), prepared, { session, options: {} }, 2000, undefined),
    /produced no model-visible messages/u,
    "a checkpoint is not a message: deriving the prompt from seqs finds nothing"
  );
});

test("documents carry the body when the seqs are not messages", async () => {
  const body = "## checkpoint\n- built the thing";
  const session = checkpointOnlySession(body);
  const ctx = stubCtx();
  const prepared = { session, documents: [{ seq: 5, text: body }], shadowedSeqs: [5], shadowedTokenCount: 100 };

  const result = await summarizeLeaf(ctx, resolveConfig({}), prepared, { session, options: {} }, 2000, undefined);
  assert.match(result.summary[0].text, /did the thing/u, "the answer is kept");
  assert.equal(ctx.calls.length, 1, "one call");

  // The document text must actually be IN the request, not merely accepted.
  const sent = JSON.stringify(ctx.calls[0].messages);
  assert.ok(sent.includes("built the thing"), "the checkpoint body reached the prompt");
});

test("documents are optional: an ordinary message span still works", async () => {
  const events = [{ type: "user/message", seq: 1, time: 1, data: { message: { role: "user", content: [{ type: "text", text: "hello" }] } } }];
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const session = {
    id: "leaf-probe",
    events,
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => event?.data?.message ?? null,
    requestHeader: () => ({ config: { provider: "p", model: "m" }, tools: [] })
  };
  const ctx = stubCtx();
  const result = await summarizeLeaf(ctx, resolveConfig({}), { session, shadowedSeqs: [1], shadowedTokenCount: 10 }, { session, options: {} }, 2000, undefined);
  assert.equal(result.summary.length, 1);
  assert.ok(JSON.stringify(ctx.calls[0].messages).includes("hello"), "the message body reached the prompt");
});

test("an empty documents array falls back to the message path", async () => {
  const events = [{ type: "user/message", seq: 1, time: 1, data: { message: { role: "user", content: [{ type: "text", text: "fallback body" }] } } }];
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const session = {
    id: "leaf-probe-2",
    events,
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => event?.data?.message ?? null,
    requestHeader: () => ({ config: { provider: "p", model: "m" }, tools: [] })
  };
  const ctx = stubCtx();
  await summarizeLeaf(ctx, resolveConfig({}), { session, documents: [], shadowedSeqs: [1], shadowedTokenCount: 10 }, { session, options: {} }, 2000, undefined);
  assert.ok(JSON.stringify(ctx.calls[0].messages).includes("fallback body"), "an empty list must not shadow the seq path");
});
