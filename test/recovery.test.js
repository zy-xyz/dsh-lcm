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
import { recallSession } from "../src/recall.js";

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
