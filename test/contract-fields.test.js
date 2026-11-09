/**
 * Contract fields of the \`compaction/summary\` record and the summary-recovery seam.
 *
 * Four defects found by audit, each asserted here on the real shape:
 *   1. \`shadowedTokenCount\` must be the HEURISTIC price, not the route price.
 *      \`dsh-token-meter\` folds this field into a claim and then prices the next
 *      replacement as \`estimateMessage(replacement) - claim.tokens\`, while its
 *      own surface total is summed from \`node.heuristicTokens\`. Writing the
 *      route price there drifts the projected surface total, which makes
 *      \`contextPressure\` under-report forever and the threshold never fire.
 *   2. The durable field names are the CONTRACT's: \`maxTokens\`, never
 *      \`targetTokens\`. The released v0/v1 payload validator rejects an
 *      unexpected member, so a renamed field is a record the migration refuses —
 *      and the field's VALUE is the contract's too: the generation cap the
 *      summarize call sent, not the instruction target this backend used to
 *      write under a comment that claimed no cap was sent at all.
 *   3. A summarization failure must be an \`Error\` (specifically \`LlmError\`),
 *      not the frozen plain snapshot the LLM seam reports, because every
 *      downstream recovery listener routes on \`instanceof LlmError\`.
 *   4. The \`compaction/summary-error\` waterfall must exist: without it no
 *      listener can recover a failed summary (\`dsh-compaction-image-offload\`
 *      is the shipped one) and an image-heavy region is unrecoverable.
 *
 * Run with: node --test test/contract-fields.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { compactSurfaceRegion } from "../src/region.js";
import { summarizeLeaf } from "../src/summarize.js";

let foldSurface;
let LlmError;
let releasedValidator;
try {
  ({ foldSurface } = await import("@deepseek-ai/dsh-session/surface"));
  ({ LlmError } = await import("@deepseek-ai/dsh-llm"));
} catch {
  foldSurface = null;
}
try {
  releasedValidator = await import("@deepseek-ai/dsh-session-format-v0-to-v1");
} catch {
  releasedValidator = null;
}

const skip = foldSurface === null || LlmError === undefined;

// ── fixture ────────────────────────────────────────────────────────────────

/** Event types the harness's surface fold accepts as appends. */
const SURFACE_TYPES = new Set(["system/message", "developer/message", "user/message", "assistant/message", "tool/result"]);

/** Normalize one seeded event to the marker the canonical fold expects. */
function withMarker(event) {
  if (SURFACE_TYPES.has(event.type)) {
    return event.surfaceOp === undefined ? { ...event, surfaceOp: "append" } : event;
  }
  const { surfaceOp, sourceEventSeqs, ...rest } = event;
  return rest;
}

function makeSession(events) {
  const list = events.map(withMarker);
  return {
    id: "s1",
    get events() {
      return list;
    },
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

/** A turn of user/assistant messages, no compaction. */
function plainEvents(turns = 3) {
  const events = [
    { type: "system/message", seq: 0, time: 1, data: { message: { role: "system", content: [{ type: "text", text: "sys" }] } } }
  ];
  let seq = 1;
  for (let turn = 1; turn <= turns; turn += 1) {
    events.push({ type: "turn/start", seq: seq++, time: 1, data: { turn } });
    events.push({
      type: "user/message",
      seq: seq++,
      time: 1,
      data: { content: [{ type: "text", text: "question " + turn + " " + "x".repeat(200) }] }
    });
    events.push({
      type: "assistant/message",
      seq: seq++,
      time: 1,
      data: { turn, step: 1, message: { role: "assistant", content: [{ type: "text", text: "answer " + turn + " " + "y".repeat(200) }] } }
    });
    events.push({ type: "turn/end", seq: seq++, time: 1, data: { turn } });
  }
  return events;
}

/** Deterministic compile stub: one checkpoint entry, tiny framed price. */
function stubCompile(prepared) {
  return {
    entries: [{ seq: prepared.shadowedSeqs[0], text: "## 目标与约束\n- summarized", kind: "checkpoint" }],
    stats: { nodes: prepared.shadowedSeqs.length, entries: 1, toolCalls: 0, toolResults: 0, images: 0,
             documents: 0, reasoningElided: 0, noiseElided: 0, checkpoints: 1, tokens: 8,
             elidedToolRows: 0, elidedRows: 0 },
    capped: false,
    provider: "p",
    model: "m",
    // The cap the summarize call SENT (`max(4096, 2 x target)`), not the target.
    maxTokens: 4096
  };
}

/**
 * Dependencies whose meter prices every node TWICE, and differently: the route
 * price (what the request costs) and the heuristic price (what the fixed
 * estimator says). The gap is the whole point of the first test.
 */
const ROUTE = 60;
const HEURISTIC = 100;

function makeDeps(overrides = {}) {
  return {
    meter: {
      measure: (session) => ({
        nodes: session.surface.nodes.map((seq) => ({ seq, tokens: ROUTE, heuristicTokens: HEURISTIC })),
        totalTokens: session.surface.nodes.length * ROUTE
      }),
      estimateMessage: () => 10
    },
    compile: async (prepared) => stubCompile(prepared),
    ...overrides
  };
}

/** The one compaction/summary record of a session. */
function summaryEventOf(session) {
  const matches = session.events.filter((event) => event.type === "compaction/summary");
  assert.equal(matches.length, 1, "expected exactly one compaction/summary record");
  return matches[0];
}

// ── 1: the durable shadow price is the heuristic price ─────────────────────

test("compaction/summary records the heuristic shadow price, not the route price", { skip }, async () => {
  const session = makeSession(plainEvents(3));
  const nodes = session.surface.nodes;
  const prepared = await compactSurfaceRegion(
    makeDeps(),
    session,
    nodes[1],
    nodes[nodes.length - 2],
    { session },
    { owner: null, stability: "selected-span" }
  );

  const spanNodes = nodes.length - 2; // nodes[1] .. nodes[len-2] inclusive
  const summary = summaryEventOf(session);

  // The heuristic sum, exactly. If this were the route price the recorded value
  // would be spanNodes * ROUTE, so the two assertions together pin the basis.
  assert.equal(summary.data.shadowedTokenCount, spanNodes * HEURISTIC, "the shadow price is the heuristic sum");
  assert.notEqual(summary.data.shadowedTokenCount, spanNodes * ROUTE, "the route price must not leak into the shadow price");
  assert.equal(prepared.shadowedTokenCount, summary.data.shadowedTokenCount, "the result and the record agree");
  assert.equal(prepared.shadowedRouteTokenCount, spanNodes * ROUTE, "the route price is still carried, under its own name");
});

test("the shrink guarantee is judged against the route price", { skip }, async () => {
  const session = makeSession(plainEvents(3));
  const nodes = session.surface.nodes;
  const spanNodes = nodes.length - 2;

  // Framed price sits BETWEEN the two bases: it is >= the route sum (so the
  // correct, route-based guard must reject) but < the heuristic sum (so the
  // old, heuristic-based guard would have accepted). That gap is what makes
  // this fixture discriminate between the two bases.
  const framed = spanNodes * ROUTE + 1;
  const deps = makeDeps({
    meter: {
      measure: (s) => ({ nodes: s.surface.nodes.map((seq) => ({ seq, tokens: ROUTE, heuristicTokens: HEURISTIC })), totalTokens: s.surface.nodes.length * ROUTE }),
      estimateMessage: () => framed
    }
  });

  await assert.rejects(
    compactSurfaceRegion(deps, session, nodes[1], nodes[nodes.length - 2], { session }, { owner: null, stability: "selected-span" }),
    (error) => {
      const chain = [error, error.cause, error.cause?.cause].filter(Boolean).map((e) => String(e.message));
      assert.ok(
        chain.some((message) => /not smaller than the shadowed content/.test(message)),
        "the shrink guard must fire on the route price: " + chain.join(" | ")
      );
      return true;
    }
  );
});

// ── 2: the contract field names ────────────────────────────────────────────

test("compaction/summary writes maxTokens and never targetTokens", { skip }, async () => {
  const session = makeSession(plainEvents(3));
  const nodes = session.surface.nodes;
  await compactSurfaceRegion(makeDeps(), session, nodes[1], nodes[nodes.length - 2], { session }, { owner: null, stability: "selected-span" });

  const summary = summaryEventOf(session);
  assert.equal("maxTokens" in summary.data, true, "the contract field maxTokens must be written");
  // The contract type documents this field as "the generation cap the summarize
  // call sent" (dsh-compaction/types), and `dsh-compaction-basic` fills it from
  // its own `options.maxTokens`. The instruction TARGET used to be written here
  // instead, under a comment claiming no cap was sent - while the request carried
  // `max(4096, 2 x target)`. So the record under-reported the cap by 2x or more,
  // which is exactly the number an operator reads to judge "could the response
  // have been cut off?".
  assert.equal(summary.data.maxTokens, 4096, "it carries the completion cap the call sent, not the instruction target");
  assert.equal("targetTokens" in summary.data, false, "targetTokens is not a compaction/summary member");
});

test("the written record passes the released v0/v1 payload validator", { skip }, async (t) => {
  if (releasedValidator === null) {
    t.skip("dsh-session-format-v0-to-v1 is not resolvable outside a profile");
    return;
  }
  const session = makeSession(plainEvents(3));
  const nodes = session.surface.nodes;
  await compactSurfaceRegion(makeDeps(), session, nodes[1], nodes[nodes.length - 2], { session }, { owner: null, stability: "selected-span" });

  for (const version of [0, 1]) {
    assert.doesNotThrow(
      () => releasedValidator.assertReleasedEventPayload(summaryEventOf(session), version),
      "the record must be admissible at released format v" + version
    );
  }
});

// ── 3: a summarization failure is an LlmError ──────────────────────────────

/** The provider-neutral failure SNAPSHOT the LLM seam reports: frozen, not an Error. */
const FROZEN_FAILURE = Object.freeze({ message: "image offload required", code: "IMAGE_OFFLOAD_REQUIRED", offloadImages: 2 });

/** One user event and a stream that ends on the given terminal reason. */
function failingSession(reason) {
  const events = [{ seq: 0, type: "user/message", message: { role: "user", content: [{ type: "text", text: "do the thing" }] } }];
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const session = {
    id: "s1",
    events,
    surface: { nodes: [0], replaceGeneration: 1 },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => event.message ?? null,
    requestHeader: () => ({ config: { provider: "p", model: "m" }, tools: [] })
  };
  const llm = {
    stream() {
      return (async function* () {
        yield { type: "finish", reason, replayState: undefined };
      })();
    }
  };
  return { session, llm };
}

test("a terminal failure finish throws an LlmError carrying the frozen snapshot as cause", { skip }, async () => {
  const { session, llm } = failingSession({ kind: "error", failure: FROZEN_FAILURE });
  const prepared = { session, start: 0, end: 0, shadowedSeqs: [0], shadowedTokenCount: 100 };

  await assert.rejects(
    summarizeLeaf({ llm }, { emptySummaryRetries: 0, summarizationProvider: "", summarizationModel: "", anchorPointers: true }, prepared, { session, options: {} }, 512, undefined),
    (error) => {
      assert.ok(error instanceof Error, "the thrown value must be an Error");
      assert.ok(error instanceof LlmError, "downstream listeners route on instanceof LlmError");
      assert.equal(error.code, "IMAGE_OFFLOAD_REQUIRED", "the provider-neutral code survives");
      assert.equal(error.message, FROZEN_FAILURE.message, "the provider message survives");
      assert.equal(error.cause, FROZEN_FAILURE, "the original frozen snapshot is retained as cause");
      assert.equal(error.failure?.offloadImages, 2, "the recovery facts survive onto error.failure");
      return true;
    }
  );
});

// ── 4: the summary-error waterfall ─────────────────────────────────────────

test("a failed summary asks compaction/summary-error and retries the re-priced span", { skip }, async () => {
  const session = makeSession(plainEvents(3));
  const nodes = session.surface.nodes;
  const calls = [];

  let attempts = 0;
  const deps = makeDeps({
    compile: async (prepared) => {
      attempts += 1;
      if (attempts === 1) throw new LlmError("image offload required", "IMAGE_OFFLOAD_REQUIRED", FROZEN_FAILURE);
      return stubCompile(prepared);
    },
    recover: (error, agent, sourceEventSeqs, signal) => {
      calls.push({ error, agent, sourceEventSeqs: [...sourceEventSeqs], signal });
      return true;
    }
  });

  const result = await compactSurfaceRegion(deps, session, nodes[1], nodes[nodes.length - 2], { session }, { owner: null, stability: "selected-span" });

  assert.equal(attempts, 2, "the recovery must re-run the compile step");
  assert.equal(calls.length, 1, "the waterfall is asked exactly once");
  assert.ok(calls[0].error instanceof LlmError, "the waterfall sees the typed failure");
  assert.deepEqual(calls[0].sourceEventSeqs, result.shadowedSeqs, "it receives the selected span, in surface order");
  assert.equal(calls[0].agent.session, session, "it receives the owning session");
  assert.ok(result.shadowedSeqs.length > 0, "the recovered attempt committed");
  assert.equal(session.events.filter((event) => event.type === "compaction/end").length, 1, "one clean close");
  assert.equal(session.events.find((event) => event.type === "compaction/end").data.error, undefined, "the failure left no error on the close marker");
});

test("a listener that declines leaves the original failure intact", { skip }, async () => {
  const session = makeSession(plainEvents(3));
  const nodes = session.surface.nodes;
  const deps = makeDeps({
    compile: async () => { throw new LlmError("no route", "NO_ADAPTER", { message: "no route", code: "NO_ADAPTER" }); },
    recover: () => false
  });

  await assert.rejects(
    compactSurfaceRegion(deps, session, nodes[1], nodes[nodes.length - 2], { session }, { owner: null, stability: "selected-span" }),
    (error) => {
      const chain = [error, error.cause, error.cause?.cause].filter(Boolean).map((e) => e.code);
      assert.ok(chain.includes("NO_ADAPTER"), "the original failure is what surfaces: " + JSON.stringify(chain));
      return true;
    }
  );
  assert.equal(session.events.filter((event) => event.type === "compaction/summary").length, 0, "no summary, no orphan");
});
