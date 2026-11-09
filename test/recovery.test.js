/**
 * Recoverability — the claim that actually distinguishes this backend.
 *
 * A summary is a lossy view; the append-only log is not. These tests prove the
 * shipped recall path closes the loop: an anchor the summary dropped comes back
 * byte-for-byte, on a real production log.
 *
 * They also pin a bug this measurement found: `session.events[seq]` is off by
 * one for every persisted log (the file starts with a header record that has no
 * `seq`), so recall reported "not found in this session" for every real event.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { resolveEventAt } from "../src/events.js";
import { MAX_RECALL_TOKENS, recallSession } from "../src/recall.js";
import { defineRecallTool, resolveConfig } from "../src/tool.js";

// ── the indexing bug ───────────────────────────────────────────────────────

/** A log shaped like a persisted session file: header record first, no seq. */
function headerPrefixedEvents() {
  return [
    { type: "session", version: 4, id: "s1", createdAt: 1 },
    { type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: "first real event" }] } },
    { type: "assistant/message", seq: 1, time: 1, data: { message: { role: "assistant", content: [{ type: "text", text: "second real event" }] } } }
  ];
}

test("resolveEventAt finds an event by seq even when the array is header-shifted", () => {
  const events = headerPrefixedEvents();
  const session = { events };

  // The naive index is wrong for this array: events[0] is the header.
  assert.equal(events[0].type, "session");
  assert.equal(resolveEventAt(session, 0).type, "user/message");
  assert.equal(resolveEventAt(session, 1).type, "assistant/message");
  assert.equal(resolveEventAt(session, 2), undefined, "absent seqs stay absent");
  assert.equal(resolveEventAt(session, -1), undefined);
});

test("resolveEventAt prefers the session's own accessor", () => {
  const events = headerPrefixedEvents();
  const fromAccessor = { type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: "from accessor" }] } };
  const session = { events, eventAt: (seq) => (seq === 0 ? fromAccessor : undefined) };
  assert.equal(resolveEventAt(session, 0), fromAccessor);
  // Falls back to the array when the accessor misses.
  assert.equal(resolveEventAt(session, 1).type, "assistant/message");
});

test("recallSession reads an event from a header-shifted log", () => {
  const session = { events: headerPrefixedEvents() };
  const result = recallSession(session, [{ start: 0, end: 0 }], { maxRecallTokens: 4000 });
  assert.equal(result.recalled, 1, "the event must be found");
  assert.match(result.text, /first real event/);
  assert.equal(result.missing, 0);
});

// ── byte-exact fidelity on a synthetic session ─────────────────────────────

test("recall returns the original content, not a re-rendering", () => {
  const body = "||| unusual   spacing\ttabs  and **markdown** _chars_ |||";
  const session = {
    events: [
      { type: "session", id: "s" },
      { type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: body }] } }
    ],
    // The live session projects events; without a projector recall falls back to
    // a raw JSON dump, which would make this assertion vacuous.
    deriveEventMessage: (event) => ({
      role: "user",
      content: event.data?.content ?? []
    })
  };
  const result = recallSession(session, [{ start: 0, end: 0 }], { maxRecallTokens: 4000 });
  assert.ok(!result.text.includes('{"content"'), "the projection must run, not the JSON fallback");
  assert.ok(result.text.includes(body), "every character of the original must survive");
});

// ── the production measurement ─────────────────────────────────────────────

/**
 * The real 436k-token span from a production session, when the log is present.
 * A summary carried 3 of 24 auto-extracted anchors; recall must make the other
 * 21 retrievable, i.e. availableRetention = 1.0.
 */
const REAL_LOG = path.join(
  os.homedir(),
  ".dsh/sessions/--home-agent-workspaces--/d45c83f5-e619-4b3a-96e7-5cb17e2f690b/session.v4.jsonl.zstd"
);

test("every anchor the summary dropped is recoverable from the log", { skip: !fs.existsSync(REAL_LOG) }, async () => {
  const { buildAnchorSet } = await import("../bench/anchors.mjs");
  const events = zlib.zstdDecompressSync(fs.readFileSync(REAL_LOG)).toString("utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));

  const render = (event) => {
    const data = event.data ?? {};
    if (event.type === "user/message") return (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (event.type === "assistant/message" || event.type === "tool/result") {
      const message = data.message ?? data;
      return (message.content ?? []).map((b) => (b.type === "text" ? b.text : b.type === "tool-call" ? String(b.arguments ?? "") : "")).join("\n");
    }
    if (event.type === "tool/call") return String(data.arguments ?? "");
    return "";
  };
  const session = {
    events,
    eventAt: (seq) => resolveEventAt({ events }, seq),
    deriveEventMessage: (event) => {
      const text = render(event);
      return text.length === 0 ? null : { role: "user", content: [{ type: "text", text }] };
    }
  };

  const summary = events.find((e) => e.type === "compaction/summary");
  assert.ok(summary, "the fixture log must contain a production compaction");
  const shadowedSeqs = summary.data.shadowedSeqs;
  const spanText = shadowedSeqs.map((seq) => render(resolveEventAt(session, seq))).join("\n");
  const summaryText = (summary.data.summary ?? []).map((b) => b.text ?? "").join("\n");
  const anchors = buildAnchorSet(spanText).anchors;

  let dropped = 0;
  let recovered = 0;
  for (const anchor of anchors) {
    if (summaryText.includes(anchor.value)) continue;
    dropped += 1;
    const ownerSeq = shadowedSeqs.find((seq) => render(resolveEventAt(session, seq)).includes(anchor.value));
    assert.ok(ownerSeq !== undefined, `anchor "${anchor.value}" came from the span, so an owner seq must exist`);
    const result = recallSession(session, [{ start: ownerSeq, end: ownerSeq }], { maxRecallTokens: 20000 });
    assert.equal(result.missing, 0, `recall must find seq ${ownerSeq}`);
    // Guard against a vacuous pass: the raw-JSON fallback would preserve every
    // substring, so require the real projection to have produced the text.
    assert.ok(
      !result.text.includes('{"content"') && !result.text.includes('{"role"'),
      `recall fell back to a JSON dump for seq ${ownerSeq} instead of projecting it`
    );
    if (result.text.includes(anchor.value)) recovered += 1;
  }

  assert.ok(dropped > 0, "the production summary did drop anchors; otherwise this test proves nothing");
  assert.equal(recovered, dropped, `every dropped anchor must be recoverable (dropped ${dropped}, recovered ${recovered})`);
});
// ── deriveDag must not rely on array indices either ────────────────────────

test("deriveDag reads a header-shifted log correctly", async () => {
  const { deriveDag } = await import("../src/summarize.js");
  // Same shape as a persisted session file: a header record with no seq first.
  const events = [
    { type: "session", version: 4, id: "s1" },
    { type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: "a" }] } },
    { type: "compaction/summary", seq: 1, time: 1, data: { compactionId: "c1", shadowedSeqs: [0], shadowedTokenCount: 100 } },
    { type: "user/message", seq: 2, time: 1, data: { source: { kind: "compact-checkpoint", compactionId: "c1" } } }
  ];
  const dag = deriveDag({ events });
  assert.equal(dag.checkpoints, 1, "the checkpoint node must be found despite the header shift");
  assert.equal(dag.maxDepth, 1);
  assert.deepEqual(dag.nodeBySeq.get(2).children, [0]);
});

// ── the per-call budget channel ────────────────────────────────────────────
//
// Measured defect: across 21 compacted sessions, 2 of 10630 shadowed seqs
// exceeded the 16000-token default and were truncated on every call — the
// largest a 23251-token tool result that came back at 69.3% of its bytes. The
// data was never missing (raising the budget by hand returned it whole); the
// channel was too narrow and there was no argument to widen it. These tests pin
// the argument: omitted = today's bytes, raised = the whole event, above the
// ceiling = clamped and said so, nonsense = rejected.

/** A session holding one projected user message: the shape recall reads. */
function oneTextSession(text) {
  return {
    events: [
      { type: "session", id: "s" },
      { seq: 0, type: "user/message", time: 1, data: { content: [{ type: "text", text }] } }
    ],
    deriveEventMessage: (event) => (typeof event.seq === "number" ? { role: "user", content: event.data.content } : null)
  };
}

/** A body of `count` distinct single-word tokens. */
function wordsOf(count) {
  return Array.from({ length: count }, (_, index) => "w" + index).join(" ");
}

const RECALL_TOOL = defineRecallTool(resolveConfig({}));
const callExpand = (session, args) => RECALL_TOOL.execute(args, { agent: { session } });

test("an omitted maxTokens returns exactly the bytes it returns today", async () => {
  const body = "note: nothing unusual here";
  const result = await callExpand(oneTextSession(body), { type: "seq", id: "0" });
  // Pinned literal: the pre-change output for this event, join separator included.
  assert.equal(result.text, "[seq 0: user]\n" + body);
  assert.equal(result.truncated, false);
  assert.equal(result.recalled, 1);
  assert.equal(result.missing, 0);
});

test("the default budget still cuts an oversized event, and now says what the cut costs", async () => {
  const text = wordsOf(12000);
  const result = await callExpand(oneTextSession(text), { type: "seq", id: "0" });
  assert.equal(result.truncated, true, "the default budget must not return this whole event");
  assert.ok(result.text.length < text.length, "the cut must be a cut");
  // The old marker, kept: the provenance of the cut.
  assert.match(result.text, /\.\.\.\(truncated from recall budget\)/);
  // The new tail: how much of how much, and the argument that returns the rest.
  assert.match(result.text, /\[recall budget 16000 tokens: returned ~\d+ of ~\d+ tokens \(\d+ of \d+ chars\)/);
  assert.match(result.text, /raise maxTokens \(up to 32768\) to restore the rest/);
});

test("a raised maxTokens returns the oversized event complete", async () => {
  const text = wordsOf(12000);
  const session = oneTextSession(text);
  const omitted = await callExpand(session, { type: "seq", id: "0" });
  assert.equal(omitted.truncated, true);

  const raised = await callExpand(session, { type: "seq", id: "0", maxTokens: MAX_RECALL_TOKENS });
  assert.equal(raised.truncated, false, "the ceiling must be enough for every event this log holds");
  assert.equal(raised.text, "[seq 0: user]\n" + text, "the whole event, byte for byte");
});

test("an over-ceiling request is clamped, and the marker says where the ceiling is", async () => {
  // Bigger than the ceiling, so the clamp is observable as a still-truncated result.
  const text = wordsOf(20000);
  const session = oneTextSession(text);
  const clamped = await callExpand(session, { type: "seq", id: "0", maxTokens: 1_000_000 });
  const atCeiling = await callExpand(session, { type: "seq", id: "0", maxTokens: MAX_RECALL_TOKENS });

  assert.equal(clamped.truncated, true);
  assert.equal(clamped.text, atCeiling.text, "1_000_000 must land exactly on the ceiling");
  assert.match(clamped.text, new RegExp("recall budget " + MAX_RECALL_TOKENS + " tokens"));
  assert.match(clamped.text, /32768 is the ceiling for maxTokens/);
  assert.ok(clamped.tokens <= MAX_RECALL_TOKENS + 200, "a clamped call must not exceed its ceiling");
});

test("a nonsense maxTokens is rejected with a readable message, not silently ignored", async () => {
  const session = oneTextSession("small");
  await assert.rejects(() => callExpand(session, { type: "seq", id: "0", maxTokens: 0 }), /maxTokens must be a positive integer \(got 0\)/);
  await assert.rejects(() => callExpand(session, { type: "seq", id: "0", maxTokens: -5 }), /maxTokens must be a positive integer \(got -5\)/);
  await assert.rejects(() => callExpand(session, { type: "seq", id: "0", maxTokens: 1.5 }), /must be an integer/);
});
