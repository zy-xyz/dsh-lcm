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

import { toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";

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

test("a leaf never opens on the result half of a tool pair", () => {
  // The start used to be the first surface node, so this needed no guard. It moves
  // now (past the existing checkpoints), and the same rule that protects the END
  // has to hold at the beginning.
  const events = [
    { seq: 0, type: "system/message", data: { message: { role: "system", content: [{ type: "text", text: "sys" }] } } },
    { seq: 1, type: "turn/start", data: { turn: 1 } },
    { seq: 2, type: "compaction/summary", data: { compactionId: "c1", shadowedSeqs: [], shadowedTokenCount: 10 } },
    { seq: 3, type: "user/message", data: { content: [{ type: "text", text: "cp" }], source: { kind: "compact-checkpoint", compactionId: "c1" } } },
    // A step that is still open: a tool call whose result has not arrived.
    { seq: 4, type: "assistant/message", data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "tool-call", id: "t1", name: "bash", arguments: "{}" }] }, stream: [] } },
    { seq: 5, type: "turn/end", data: { turn: 1 } },
    { seq: 6, type: "user/message", data: { content: [{ type: "text", text: "tail a" }] } },
    { seq: 7, type: "user/message", data: { content: [{ type: "text", text: "tail b" }] } }
  ];
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const session = {
    id: "pair",
    events,
    get surface() {
      return { nodes: events.filter((event) => event.type !== "compaction/summary").map((event) => event.seq), replaceGeneration: 1 };
    },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => event.message ?? event.data?.message ?? (event.data?.content ? { role: "user", content: event.data.content } : null)
  };
  const nodes = session.surface.nodes;
  const measurement = { nodes: nodes.map((seq) => ({ seq, tokens: 1000, heuristicTokens: 1000 })), totalTokens: nodes.length * 1000 };
  const range = selectCompactableRange(session, measurement, 0, 0, 0, 4);
  if (range !== null) {
    assert.ok(
      toolPairingBalancedBefore(session, range.start),
      "the selected start is a balanced boundary, never the middle of a step"
    );
    assert.notEqual(range.start, 4, "it must not open on the assistant tool-call node");
  }
});

test("a short leading run does not block the next run of the same depth", () => {
  // The leading-only rule died here: with depths [2, 1, 1, 1, 1] the leading run
  // is one node, so nothing condensed and the four depth-1 siblings behind the
  // rollup were unreachable forever. Measured on the 40-round replay that exposed
  // it: this exact shape sat on the surface from round 8 to round 40 (growing to
  // [2, 1 x 33]) while condensation never fired again.
  //
  // The surface is built by hand because only POSITIONAL depth matters to the
  // selector, and a synthetic log is the only way to place the rollup first: the
  // real commit path replaces its children in place (see the replay test in
  // surface-breadth.test.js, which drives foldSurface for real). deriveDag resolves
  // depth from shadowedSeqs, so the parent here names a later seq - that is the one
  // thing a real log cannot contain, and it does not affect what is asserted.
  const events = [{ seq: 0, type: "system/message", data: { message: { role: "system", content: [{ type: "text", text: "sys" }] } } }];
  const push = (seq, type, data) => events.push({ seq, type, data });
  push(1, "compaction/summary", { compactionId: "m", shadowedSeqs: [4], shadowedTokenCount: 10 });
  push(2, "user/message", { content: [{ type: "text", text: "rollup" }], source: { kind: "compact-checkpoint", compactionId: "m" } });
  for (let leaf = 0; leaf < 4; leaf += 1) {
    const seq = 3 + leaf * 2;
    push(seq, "compaction/summary", { compactionId: "d" + leaf, shadowedSeqs: [], shadowedTokenCount: 10 });
    push(seq + 1, "user/message", { content: [{ type: "text", text: "leaf" + leaf }], source: { kind: "compact-checkpoint", compactionId: "d" + leaf } });
  }
  push(11, "user/message", { content: [{ type: "text", text: "tail a" }] });
  push(12, "user/message", { content: [{ type: "text", text: "tail b" }] });
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const session = {
    id: "short-leading-run",
    events,
    get surface() {
      return { nodes: events.filter((event) => event.type !== "compaction/summary").map((event) => event.seq), replaceGeneration: 1 };
    },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => event.data?.content ? { role: "user", content: event.data.content } : null
  };
  const measurement = priced(session, 1000);
  assert.deepEqual(session.surface.nodes, [0, 2, 4, 6, 8, 10, 11, 12], "two depth-1 leaves under the rollup, then four siblings");

  const selected = selectCompactableRange(session, measurement, 0, 0, 0, 4);
  assert.ok(selected !== null, "the second run is long enough, so something must condense");
  assert.equal(selected.start, 4, "the new node lands at the SECOND run's first position, not at the rollup");
  assert.equal(selected.end, 10, "and covers that run to its last sibling");
  const covered = session.surface.nodes.slice(session.surface.nodes.indexOf(selected.start), session.surface.nodes.indexOf(selected.end) + 1);
  assert.deepEqual(covered, [4, 6, 8, 10], "exactly the four same-depth siblings, never the depth-2 rollup");
  assert.ok(!covered.includes(2), "the rollup is outside the span: a parent is never merged with its children");

  // Fanin 0 keeps the historical whole-prefix start, so the new rule is only ever
  // reached through the condensation path.
  const plain = selectCompactableRange(session, measurement, 0, 0, 0, 0);
  assert.equal(plain.start, 2, "without a fanin the selector still starts at the oldest node");
});
