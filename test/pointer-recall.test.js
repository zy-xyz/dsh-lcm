/**
 * The pointer must actually resolve.
 *
 * An anchor list that says `(seq 812)` is a promise: `lcm_expand` with that
 * seq returns the event that contains the anchor. Attribution and recall are
 * separate code paths (attribution scans the span at summary time, recall
 * projects the durable log later), so nothing but a test stops them from
 * disagreeing — and a wrong pointer is worse than no pointer, because the agent
 * gets a confident answer from the wrong event.
 *
 * This closes the loop end to end: attribute -> parse the pointer out of the
 * checkpoint text -> recall that seq -> assert the anchor really is in the
 * returned bytes.
 *
 * Run with: node --test test/pointer-recall.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { recallSession } from "../src/recall.js";
import { attributeAnchorPointers } from "../src/summarize.js";

/** A session whose events each render one line, with the harness's event shape. */
function sessionOf(texts) {
  const events = texts.map((text, seq) => ({
    seq,
    type: "assistant/message",
    message: { role: "assistant", content: [{ type: "text", text }] }
  }));
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  return {
    id: "s1",
    events,
    surface: { nodes: events.map((event) => event.seq), replaceGeneration: 1 },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => event.message ?? null
  };
}

const SPAN = [
  "读了 /vol3/1000/work/notes/baseline.md，结论是缓存失效",
  "导出 LD_LIBRARY_PATH=/opt/lib 之后重跑",
  "其余无关的一行",
  "再一次提到 LD_LIBRARY_PATH，但这是第二次"
];

const SUMMARY = [
  "## 逐字锚点",
  "- /vol3/1000/work/notes/baseline.md",
  "- LD_LIBRARY_PATH",
  "",
  "## 下一步",
  "- 重跑"
].join("\n");

/** Pull every `- <anchor> (seq N)` pair out of an attributed checkpoint. */
function pointersIn(text) {
  const pairs = [];
  for (const line of text.split("\n")) {
    const match = /^- (.+) \(seq (\d+)\)$/.exec(line);
    if (match !== null) pairs.push({ anchor: match[1], seq: Number(match[2]) });
  }
  return pairs;
}

test("every pointer the checkpoint emits resolves to bytes containing its anchor", () => {
  const session = sessionOf(SPAN);
  const attributed = attributeAnchorPointers(SUMMARY, session, [0, 1, 2, 3]);
  const pointers = pointersIn(attributed);
  assert.equal(pointers.length, 2, "both anchors of the span must be attributed");

  for (const { anchor, seq } of pointers) {
    const recalled = recallSession(session, [{ start: seq, end: seq }], { maxRecallTokens: 4000 });
    assert.equal(recalled.missing, 0, `recall must find seq ${seq}`);
    assert.ok(
      recalled.text.includes(anchor),
      `seq ${seq} does not contain "${anchor}" — the pointer lies`
    );
  }
});

test("the pointer is the FIRST occurrence, so recall returns the earliest evidence", () => {
  const session = sessionOf(SPAN);
  const attributed = attributeAnchorPointers(SUMMARY, session, [0, 1, 2, 3]);
  const ldPointer = pointersIn(attributed).find((pair) => pair.anchor === "LD_LIBRARY_PATH");
  assert.equal(ldPointer.seq, 1, "LD_LIBRARY_PATH appears in seq 1 and seq 3; the pointer must be 1");
});

test("an anchor with no pointer never gets one invented for it", () => {
  const session = sessionOf(SPAN);
  const attributed = attributeAnchorPointers(
    ["## 逐字锚点", "- never-出现在这段里的东西", "", "## 下一步", "- x"].join("\n"),
    session,
    [0, 1, 2, 3]
  );
  assert.deepEqual(pointersIn(attributed), [], "an unattributable anchor must stay bare");
});

test("pointers only ever name seqs inside the shadowed span", () => {
  const session = sessionOf(SPAN);
  // Only seq 0 is in scope; LD_LIBRARY_PATH lives in seq 1 and 3.
  const attributed = attributeAnchorPointers(SUMMARY, session, [0]);
  const pointers = pointersIn(attributed);
  assert.equal(pointers.length, 1, "only the seq-0 anchor may be attributed");
  assert.equal(pointers[0].seq, 0);
  assert.equal(pointers[0].anchor, "/vol3/1000/work/notes/baseline.md");
});
