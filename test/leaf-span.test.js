/**
 * Leaf-sized compaction spans, borrowed from lcm-x.
 *
 * lcm-x condenses in leaf chunks of leaf_chunk_tokens (24 000) with a ~2 000-token
 * target each and keeps every leaf, assembling several per request. Compacting the
 * whole compactable prefix instead produces a single ever-deeper checkpoint: the
 * surface never holds more than one, deriveDag gets depth without breadth, and one
 * model call is asked to summarise everything - which on real runs was the response
 * the provider truncated before the sections were finished.
 *
 * These tests pin the ceiling: a span larger than leafSpanTokens is cut to the
 * oldest chunk that fits, the cut never lands mid-step, and 0 keeps the historical
 * whole-prefix selection byte for byte.
 *
 * Run with: node --test test/leaf-span.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { toolPairingBalancedAfter } from "@deepseek-ai/dsh-compaction";

import { selectCompactableRange } from "../src/region.js";

/** A session whose surface is a system head plus alternating user/assistant nodes. */
function sessionOf(turns) {
  const events = [{ seq: 0, type: "system/message", data: { message: { role: "system", content: [{ type: "text", text: "sys" }] } } }];
  let seq = 1;
  for (let turn = 1; turn <= turns; turn += 1) {
    events.push({ seq: seq++, type: "turn/start", data: { turn } });
    events.push({ seq: seq++, type: "user/message", data: { content: [{ type: "text", text: "q" + turn }] } });
    events.push({ seq: seq++, type: "assistant/message", data: { turn, step: 1, message: { role: "assistant", content: [{ type: "text", text: "a" + turn }] }, stream: [] } });
    events.push({ seq: seq++, type: "turn/end", data: { turn } });
  }
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  return {
    id: "leaf-span",
    events,
    get surface() {
      const nodes = events.filter((e) => e.type === "system/message" || e.type === "user/message" || e.type === "assistant/message").map((e) => e.seq);
      return { nodes, replaceGeneration: 1 };
    },
    eventAt: (s) => bySeq.get(s),
    deriveEventMessage: (event) => event.message ?? event.data?.message ?? (event.data?.content ? { role: "user", content: event.data.content } : null)
  };
}

/** Equal pricing, so the arithmetic is readable. */
function priced(session, each) {
  const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: each, heuristicTokens: each }));
  return { nodes, totalTokens: nodes.length * each };
}

test("a span larger than the leaf ceiling is cut to its oldest chunk", () => {
  const session = sessionOf(20); // 41 surface nodes
  const measurement = priced(session, 1000);
  const whole = selectCompactableRange(session, measurement, 0);
  assert.ok(whole !== null);
  const wholeNodes = session.surface.nodes.slice(session.surface.nodes.indexOf(whole.start), session.surface.nodes.indexOf(whole.end) + 1);
  assert.ok(wholeNodes.length > 20, "without a ceiling the whole prefix is selected");

  const capped = selectCompactableRange(session, measurement, 0, 0, 5000);
  assert.ok(capped !== null);
  const cappedNodes = session.surface.nodes.slice(session.surface.nodes.indexOf(capped.start), session.surface.nodes.indexOf(capped.end) + 1);
  assert.ok(cappedNodes.length * 1000 <= 5000 + 1000, `the leaf fits the ceiling (got ${cappedNodes.length} nodes)`);
  assert.equal(capped.start, whole.start, "the leaf starts at the OLDEST node, matching lcm-x");
  assert.ok(capped.end !== whole.end, "and ends well before the whole prefix");
});

test("a ceiling larger than the prefix changes nothing", () => {
  const session = sessionOf(5);
  const measurement = priced(session, 100);
  assert.deepEqual(
    selectCompactableRange(session, measurement, 0, 0, 1_000_000),
    selectCompactableRange(session, measurement, 0),
    "a non-binding ceiling reproduces the whole-prefix selection"
  );
});

test("the cut never lands mid-step", () => {
  const session = sessionOf(12);
  const measurement = priced(session, 700);
  for (const ceiling of [2100, 3500, 4900, 7000]) {
    const range = selectCompactableRange(session, measurement, 0, 0, ceiling);
    if (range === null) continue;
    assert.ok(
      toolPairingBalancedAfter(session, range.end),
      "the leaf must end on a balanced boundary, or the replacement splits a tool-call/result pair"
    );
  }
});

test("a zero ceiling keeps the historical selection", () => {
  const session = sessionOf(8);
  const measurement = priced(session, 500);
  assert.deepEqual(
    selectCompactableRange(session, measurement, 0, 0, 0),
    selectCompactableRange(session, measurement, 0),
    "0 means whole-prefix, so existing callers are untouched"
  );
});
