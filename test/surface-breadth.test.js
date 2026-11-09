/**
 * Does the surface ever hold MORE THAN ONE checkpoint?
 *
 * This is the integration test that would have caught the defect fixed in 79fa3d8.
 * Every unit test was green while the mechanism was dead, because they built the
 * surface by hand: nothing asserted that the state the ENGINE creates across
 * repeated compactions can satisfy the condensation precondition at all.
 *
 * Measured before the fix, with a replay of the real selector and the real DAG: 7
 * compactions left 7 checkpoints in the log and ONE on the surface, depth [7]. Each
 * leaf started at the oldest surface node, and the oldest node is the previous
 * checkpoint, so every compaction re-absorbed its predecessor. Breadth stayed at 1
 * and the same-depth fanin branch could never fire.
 *
 * This test runs the real commit path (`compactSurfaceRegion` folding through the
 * harness's own `foldSurface`) for several rounds and asserts the surface really
 * accumulates siblings, and that a condensation then happens.
 *
 * Run with: node --test test/surface-breadth.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { deriveDag } from "../src/summarize.js";
import { compactSurfaceRegion, selectCompactableRange } from "../src/region.js";

let foldSurface;
try {
  ({ foldSurface } = await import("@deepseek-ai/dsh-session/surface"));
} catch {
  foldSurface = null;
}
const skip = foldSurface === null;

/** Event types the harness's surface fold accepts as appends. */
const SURFACE_TYPES = new Set(["system/message", "developer/message", "user/message", "assistant/message", "tool/result"]);
const HEURISTIC = 1200;

/** Normalize one seeded event to the marker the canonical fold expects. */
function withMarker(event) {
  if (SURFACE_TYPES.has(event.type)) {
    return event.surfaceOp === undefined ? { ...event, surfaceOp: "append" } : event;
  }
  const { surfaceOp, sourceEventSeqs, ...rest } = event;
  return rest;
}

/** A session whose surface comes from the harness's own fold, not from a stub. */
function makeSession() {
  const list = [
    withMarker({ type: "system/message", seq: 0, time: 1, message: { role: "system", content: [{ type: "text", text: "sys" }] } })
  ];
  // The harness caches tool-pairing balance per session and invalidates on
  // `replaceGeneration`. A getter that reports a constant generation leaves the cache
  // holding seqs the surface no longer has, and the next boundary check throws
  // "surface seq N not found". So the generation has to move when membership does.
  let generation = 0;
  let lastSignature = "";
  return {
    id: "breadth",
    get events() {
      return list;
    },
    get surface() {
      const folded = foldSurface(list);
      const signature = folded.nodes.join(",");
      if (signature !== lastSignature) {
        lastSignature = signature;
        generation += 1;
      }
      return { nodes: folded.nodes, replaceGeneration: generation };
    },
    eventAt: (seq) => list.find((event) => event.seq === seq),
    deriveEventMessage: (event) => event.message ?? event.data?.message ?? null,
    requestHeader: () => ({ config: { provider: "p", model: "m" }, tools: [] }),
    appendLive(text) {
      const event = withMarker({
        type: "user/message",
        seq: list.length,
        time: 1_790_000_000_000 + list.length,
        data: { content: [{ type: "text", text }] }
      });
      foldSurface([...list, event]);
      list.push(event);
    },
    append(type, data, metadata) {
      const event = withMarker({ type, seq: list.length, time: 1_790_000_000_000 + list.length, data, ...(metadata ?? {}) });
      foldSurface([...list, event]);
      list.push(event);
      return event;
    }
  };
}

/** Dependencies with a deterministic compile: a fixed-size checkpoint, no model. */
function makeDeps() {
  return {
    meter: {
      measure: (session) => ({
        nodes: session.surface.nodes.map((seq) => ({ seq, tokens: HEURISTIC, heuristicTokens: HEURISTIC })),
        totalTokens: session.surface.nodes.length * HEURISTIC
      }),
      estimateMessage: () => 10
    },
    compile: async (prepared) => ({
      entries: [{ seq: prepared.shadowedSeqs[0], text: "## 逐字锚点\n- anchor", kind: "checkpoint" }],
      stats: { nodes: prepared.shadowedSeqs.length, entries: 1, tokens: 300 }
    })
  };
}

/**
 * Append six whole turns and run one compaction, then report the resulting shape.
 * @param session - folded session under test.
 * @param deps - meter and deterministic compile.
 * @param round - zero-based round number.
 * @returns that round's surface size, on-surface depths and max depth.
 */
async function runRound(session, deps, round) {
  // Whole turns, not bare messages: the balance cache the harness builds needs
  // turn boundaries, and the start-boundary guard reads it.
  for (let index = 0; index < 6; index += 1) {
    const turn = round * 6 + index + 1;
    session.append("turn/start", { turn });
    session.appendLive("m" + round + "-" + index);
    session.append("turn/end", { turn });
  }
  const measurement = deps.meter.measure(session);
  const range = selectCompactableRange(session, measurement, 16_000, 512, 24_000, 4);
  const committed = range !== null;
  if (committed) {
    await compactSurfaceRegion(deps, session, range.start, range.end, { session }, { owner: null, stability: "selected-span" });
  }
  const dag = deriveDag(session);
  const onSurface = session.surface.nodes.filter((seq) => dag.nodeBySeq.has(seq));
  return {
    committed,
    surface: session.surface.nodes.length,
    depths: onSurface.map((seq) => dag.nodeBySeq.get(seq).depth),
    maxDepth: dag.maxDepth
  };
}

test("repeated compactions leave several checkpoints on the surface", { skip }, async () => {
  const session = makeSession();
  const deps = makeDeps();
  let commits = 0;

  for (let round = 0; round < 12; round += 1) {
    if ((await runRound(session, deps, round)).committed) commits += 1;
  }

  assert.ok(commits >= 3, "the replay must actually compact, or the test proves nothing: " + commits);

  const dag = deriveDag(session);
  const onSurface = session.surface.nodes.filter((seq) => dag.nodeBySeq.has(seq));
  assert.ok(
    onSurface.length > 1,
    "the surface must hold more than one checkpoint: " + onSurface.length + " after " + commits + " commits (1 means every leaf re-absorbed its predecessor)"
  );

  // Position is the assembly order: a condensation lands at the first position of
  // the run it merges and never past a shallower sibling, so a deeper node must
  // appear no later than a shallower one.
  const depths = onSurface.map((seq) => dag.nodeBySeq.get(seq).depth);
  for (let index = 1; index < depths.length; index += 1) {
    assert.ok(
      depths[index - 1] >= depths[index],
      "positional depths must be non-increasing, or surface order is not assembly order: " + JSON.stringify(depths)
    );
  }
  assert.ok(Math.max(...depths) >= 2, "at least one condensation must have happened: " + JSON.stringify(depths));
});

test("forty rounds condense logarithmically instead of growing linearly", { skip }, async () => {
  // The regression this pins: while condensation merged only the LEADING run it
  // fired exactly once per session (round 7, depth [2]) and then never again,
  // because the depth-2 node ahead of the depth-1 siblings kept them non-leading.
  // Measured on this exact replay before the fix: round 40 read
  // [2, 1 x 33] - 34 checkpoints on the surface, surface 49, maxDepth 2 - i.e. the
  // assembled context grew with the round count, which is what fanin exists to
  // prevent.
  //
  // After the fix the same replay peaks at 28 surface nodes and 7 checkpoints
  // (round 40: 21 nodes, 6 checkpoints) and reaches depth 3 at round 23. Both
  // ceilings below are the observed peaks, not estimates, and the shape is
  // deterministic (no model call, fixed pricing), so they are stable.
  const session = makeSession();
  const deps = makeDeps();
  const rounds = [];
  for (let round = 0; round < 40; round += 1) rounds.push(await runRound(session, deps, round));

  assert.ok(rounds.filter((row) => row.committed).length >= 30, "the replay must actually compact each round");

  // (b) Ordering is the invariant the whole fix rests on: the merged node inherits
  // the run's first position, so assembly order keeps reading deepest-first and the
  // context needs no sorting code.
  for (const row of rounds) {
    for (let index = 1; index < row.depths.length; index += 1) {
      assert.ok(
        row.depths[index - 1] >= row.depths[index],
        "positional depths must stay non-increasing at every round, broke at round " + (rounds.indexOf(row) + 1) + ": " + JSON.stringify(row.depths)
      );
    }
  }

  // (a) Condensation has to keep raising the level, not just once.
  assert.ok(rounds.at(-1).maxDepth >= 3, "the summary DAG must reach depth 3: maxDepth " + rounds.at(-1).maxDepth);

  // (c) Breadth stays bounded instead of tracking the round count. Before the fix
  // these two peaked at 34 and 49.
  const peakCheckpoints = Math.max(...rounds.map((row) => row.depths.length));
  const peakSurface = Math.max(...rounds.map((row) => row.surface));
  assert.ok(peakCheckpoints <= 7, "on-surface checkpoints must stay bounded, peaked at " + peakCheckpoints);
  assert.ok(peakSurface <= 28, "the surface must stay bounded, peaked at " + peakSurface);
});
