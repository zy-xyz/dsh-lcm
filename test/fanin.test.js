/**
 * Condensation: enough same-depth checkpoints become one node one level up.
 *
 * Step 3 of lcm-x's six-step pipeline ("Condense - merge same-depth nodes into
 * higher-depth summaries", `condensation_fanin` default 4). Without it the surface
 * keeps a flat row of depth-1 leaves forever: `deriveDag` computes depth but
 * nothing uses it to raise the level, so the assembled context grows linearly with
 * history instead of logarithmically.
 *
 * The rule is deliberately narrow: only a LEADING run of checkpoints that all sit
 * at the SAME depth qualifies. A run that mixes depths would merge a parent with
 * its own children, which is not condensation.
 *
 * Run with: node --test test/fanin.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { selectCompactableRange } from "../src/region.js";

/** A session whose log holds `leaves` depth-1 checkpoints followed by a live tail. */
function sessionWithLeaves(leaves) {
  const events = [{ seq: 0, type: "system/message", data: { message: { role: "system", content: [{ type: "text", text: "sys" }] } } }];
  let seq = 1;
  for (let i = 0; i < leaves; i += 1) {
    events.push({ seq, type: "compaction/summary", data: { compactionId: "c" + i, shadowedSeqs: [], shadowedTokenCount: 100 } });
    events.push({ seq: seq + 1, type: "user/message", data: { content: [{ type: "text", text: "leaf" + i }], source: { kind: "compact-checkpoint", compactionId: "c" + i } } });
    seq += 2;
  }
  // Three live tail messages, so there is fresh material AFTER the checkpoints to
  // compact. With one tail node and retainTokens 0 the compactable prefix is exactly
  // the checkpoints, which is the "nothing but checkpoints" case.
  for (let index = 0; index < 3; index += 1) {
    events.push({ seq: seq + index, type: "user/message", data: { content: [{ type: "text", text: "tail" + index }] } });
  }
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  return {
    id: "fanin",
    events,
    get surface() {
      return { nodes: events.filter((e) => e.type !== "compaction/summary").map((e) => e.seq), replaceGeneration: 1 };
    },
    eventAt: (s) => bySeq.get(s),
    deriveEventMessage: (event) => event.message ?? event.data?.message ?? (event.data?.content ? { role: "user", content: event.data.content } : null)
  };
}

/** Every node priced, nothing retained: the whole prefix is compactable. */
function priced(session, each) {
  const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: each, heuristicTokens: each }));
  return { nodes, totalTokens: nodes.length * each };
}

test("four same-depth leaves condense into one range covering all four", () => {
  const session = sessionWithLeaves(4);
  const measurement = priced(session, 1000);
  const range = selectCompactableRange(session, measurement, 0, 0, 0, 4);
  assert.ok(range !== null, "a full leading run is selected");
  const covered = session.surface.nodes.slice(session.surface.nodes.indexOf(range.start), session.surface.nodes.indexOf(range.end) + 1);
  assert.equal(covered.length, 4, "all four leaves are inside the condensation range");
  assert.equal(range.start, session.surface.nodes[1], "it starts at the first leaf, not at the system head");
});

test("three leaves do not condense, and the new leaf starts PAST them", () => {
  // Below fanin there is nothing to merge - but the leaf must not re-absorb the
  // existing checkpoints either. Every leaf used to start at the oldest surface
  // node, which is the previous checkpoint, so the surface held exactly one
  // checkpoint forever and no two siblings ever existed. A replay measured it: 7
  // compactions, 7 checkpoints in the log, 1 on the surface, depth [7]. Starting
  // past them is what lets breadth exist at all, and it is what makes the fanin
  // branch reachable.
  const session = sessionWithLeaves(3);
  const measurement = priced(session, 1000);
  const capped = selectCompactableRange(session, measurement, 0, 0, 0, 4);
  assert.ok(capped !== null, "there is still fresh material after the checkpoints");
  const startIndex = session.surface.nodes.indexOf(capped.start);
  const checkpointSeqs = session.surface.nodes.slice(1, 4);
  assert.ok(!checkpointSeqs.includes(capped.start), "the leaf starts at the tail, not at a checkpoint");
  assert.equal(startIndex, 4, "the first node after the three checkpoints");
  assert.equal(session.surface.nodes[4], capped.start, "and it is the first live message");
  // Without a fanin the historical whole-prefix rule still applies verbatim.
  const plain = selectCompactableRange(session, measurement, 0, 0, 0, 0);
  assert.equal(plain.start, session.surface.nodes[1], "fanin 0 keeps the old start");
});

test("a mixed-depth run never merges a parent with its own children", () => {
  // leaf0 and leaf1 at depth 1, then a checkpoint that absorbed both (depth 2),
  // then leaf3 at depth 1. The leading run is [1, 1, 2, 1]: it must stop at the
  // depth change, so with fanin 4 nothing condenses.
  const events = [{ seq: 0, type: "system/message", data: { message: { role: "system", content: [{ type: "text", text: "sys" }] } } }];
  const push = (seq, type, data) => events.push({ seq, type, data });
  push(1, "compaction/summary", { compactionId: "a", shadowedSeqs: [], shadowedTokenCount: 10 });
  push(2, "user/message", { content: [{ type: "text", text: "leaf0" }], source: { kind: "compact-checkpoint", compactionId: "a" } });
  push(3, "compaction/summary", { compactionId: "b", shadowedSeqs: [], shadowedTokenCount: 10 });
  push(4, "user/message", { content: [{ type: "text", text: "leaf1" }], source: { kind: "compact-checkpoint", compactionId: "b" } });
  push(5, "compaction/summary", { compactionId: "m", shadowedSeqs: [2, 4], shadowedTokenCount: 20 });
  push(6, "user/message", { content: [{ type: "text", text: "merge" }], source: { kind: "compact-checkpoint", compactionId: "m" } });
  push(7, "compaction/summary", { compactionId: "d", shadowedSeqs: [], shadowedTokenCount: 10 });
  push(8, "user/message", { content: [{ type: "text", text: "leaf3" }], source: { kind: "compact-checkpoint", compactionId: "d" } });
  push(9, "user/message", { content: [{ type: "text", text: "tail" }] });
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const session = {
    id: "mixed",
    events,
    get surface() {
      return { nodes: events.filter((e) => e.type !== "compaction/summary").map((e) => e.seq), replaceGeneration: 1 };
    },
    eventAt: (s) => bySeq.get(s),
    deriveEventMessage: (event) => event.data?.content ? { role: "user", content: event.data.content } : null
  };
  const measurement = priced(session, 1000);
  const selected = selectCompactableRange(session, measurement, 0, 0, 0, 4);
  if (selected === null) {
    assert.ok(true, "nothing but checkpoints: no leaf, which is the honest answer");
  } else {
    const covered = session.surface.nodes.slice(
      session.surface.nodes.indexOf(selected.start),
      session.surface.nodes.indexOf(selected.end) + 1
    );
    const checkpointSeqs = [2, 4, 6, 8];
    assert.equal(
      covered.filter((seq) => checkpointSeqs.includes(seq)).length,
      0,
      "no checkpoint is inside the leaf: a parent is never merged with its children"
    );
  }
});
