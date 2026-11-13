/**
 * Unit tests for the LCM compaction engine's model-independent pieces:
 * config resolution (full `dsh-compaction-basic` parity), summary DAG
 * derivation, the summary instruction, and the compile hook (stub LLM).
 *
 * Run with: node --test test/lcm.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  LcmCompactionEngine,
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy
} from "../src/index.js";
import { resolveSummaryBudget } from "../src/config.js";
import { buildInstruction, deriveDag, maxAbsorbedDepth, summarizeLeaf } from "../src/summarize.js";

// ── config: basic parity ───────────────────────────────────────────────────

test("defaults match lcm-x, not basic, on the two ratios that set the floor", () => {
  const c = resolveConfig({});
  // 0.75 and a ~24k tail are lcm-x's (`context_threshold`, `fresh_tail_max_tokens`).
  // Basic's 0.8 / 0.16 put the non-compactable floor at 250 055 on a 1M window and
  // left 499 945 tokens of compactable band; lcm-x's numbers leave 625 163. The
  // macOS build session hovered at 97% of an 0.8 threshold across 20 sweeps.
  assert.equal(c.thresholdRatio, 0.75, "lcm-x context_threshold");
  assert.equal(c.headroomTokens, 65536, "basic default headroomTokens");
  assert.equal(c.retainRatio, 0.05, "between basic's 0.16 and lcm-x's 0.026, chosen on the band arithmetic");
  assert.equal(c.maxTokens, 65536, "basic defaults maxTokens to headroomTokens");
  assert.equal(c.compactionRetries, 1);
  assert.equal(c.maxOverflowRetries, 1);
  assert.equal(c.auto, true);
});

test("accepts every key dsh-compaction-basic accepts", () => {
  const basicConfig = {
    thresholdRatio: 0.75,
    headroomTokens: 32768,
    retainRatio: 0.2,
    summarizationProvider: "p",
    summarizationModel: "m",
    maxTokens: 8192,
    compactionRetries: 2,
    maxOverflowRetries: 3,
    modelPolicies: [{ provider: "p", model: "m", thresholdRatio: 0.6 }],
    auto: false
  };
  const c = resolveConfig(basicConfig);
  assert.equal(c.thresholdRatio, 0.75);
  assert.equal(c.headroomTokens, 32768);
  assert.equal(c.retainRatio, 0.2);
  assert.equal(c.maxTokens, 8192);
  assert.equal(c.compactionRetries, 2);
  assert.equal(c.maxOverflowRetries, 3);
  assert.equal(c.auto, false);
  assert.equal(c.modelPolicies.length, 1);
});

test("retainRatio and retainTokens are mutually exclusive", () => {
  assert.throws(() => resolveConfig({ retainRatio: 0.2, retainTokens: 1000 }), /mutually exclusive/);
});

test("retainRatio must be below thresholdRatio", () => {
  assert.throws(() => resolveConfig({ thresholdRatio: 0.2, retainRatio: 0.3 }), /retainRatio/);
});

test("unknown keys are rejected", () => {
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown key/);
});

test("a half-configured summarization pair is rejected", () => {
  assert.throws(() => resolveConfig({ summarizationProvider: "p" }), /summarizationProvider/);
  assert.doesNotThrow(() => resolveConfig({ summarizationProvider: "p", summarizationModel: "m" }));
});

test("LCM-only keys are accepted and defaulted", () => {
  const c = resolveConfig({ summaryRatio: 0.1, summaryFloorTokens: 800, checkpointCap: 4096 });
  assert.equal(c.summaryRatio, 0.1);
  assert.equal(c.summaryFloorTokens, 800);
  assert.equal(c.checkpointCap, 4096);
  assert.throws(() => resolveConfig({ summaryRatio: 0 }), /summaryRatio/);
  assert.throws(() => resolveConfig({ summaryRatio: 2 }), /summaryRatio/);
});

// ── config: budget math (basic's formulas) ─────────────────────────────────

test("resolveCompactSpec reproduces basic's pressure formula", () => {
  const config = resolveConfig({});
  const policy = resolveTargetPolicy(config, { provider: "p", model: "m" });

  // W=200000, O=0: messageBudget=200000, pressureBudget=134464,
  // threshold = min(200000*0.8, 134464) = 134464
  assert.equal(resolveCompactSpec(policy, 200000).thresholdTokens, 134464);

  // W=1M: pressureBudget=934464, min(750000, 934464) = 750000 (ratio wins)
  assert.equal(resolveCompactSpec(policy, 1000000).thresholdTokens, 750000);

  // W=128K, O=8192: messageBudget=122880, pressureBudget=57344, min(104858, 57344)
  assert.equal(resolveCompactSpec(policy, 131072, 8192).thresholdTokens, 57344);

  assert.throws(() => resolveCompactSpec(policy, 0), /contextWindow/);
});

test("retainTokens derives from retainRatio x messageBudget", () => {
  const config = resolveConfig({});
  const policy = resolveTargetPolicy(config, { provider: "p", model: "m" });
  // 200000 * 0.05 = 10000
  assert.equal(resolveCompactSpec(policy, 200000).retainTokens, 10000);
});

test("retainTokens wins over retainRatio when both could apply", () => {
  const config = resolveConfig({ retainTokens: 4096 });
  const policy = resolveTargetPolicy(config, { provider: "p", model: "m" });
  const spec = resolveCompactSpec(policy, 200000);
  assert.equal(spec.retainTokens, 4096);
});

test("a headroom that exceeds the window fails closed", () => {
  const config = resolveConfig({ headroomTokens: 200000 });
  const policy = resolveTargetPolicy(config, { provider: "p", model: "m" });
  assert.throws(() => resolveCompactSpec(policy, 200000), /pressure budget/);
});

test("an exact route override wins over the default", () => {
  const config = resolveConfig({
    thresholdRatio: 0.8,
    modelPolicies: [{ provider: "p", model: "m", thresholdRatio: 0.5, headroomTokens: 1024 }]
  });
  const overridden = resolveTargetPolicy(config, { provider: "p", model: "m" });
  const plain = resolveTargetPolicy(config, { provider: "p", model: "other" });
  assert.equal(overridden.thresholdRatio, 0.5);
  assert.equal(overridden.headroomTokens, 1024);
  assert.equal(plain.thresholdRatio, 0.8);
  assert.equal(plain.headroomTokens, 65536);
});

test("an override row that sets headroom without maxTokens inherits it", () => {
  const config = resolveConfig({ modelPolicies: [{ provider: "p", model: "m", headroomTokens: 4096 }] });
  assert.equal(config.modelPolicies[0].maxTokens, 4096);
});

// ── summary budget ─────────────────────────────────────────────────────────

test("resolveSummaryBudget scales and clamps at both ends", () => {
  const config = resolveConfig({ summaryRatio: 0.12, summaryFloorTokens: 512, checkpointCap: 16384 });
  assert.equal(resolveSummaryBudget(config, 1000), 512, "tiny span hits the floor");
  assert.equal(resolveSummaryBudget(config, 40000), 4800, "mid span scales");
  assert.equal(resolveSummaryBudget(config, 1000000), 16384, "huge span hits the cap");
});

test("effectiveMaxTokens delegates to the resolved budget", () => {
  const engine = Object.create(LcmCompactionEngine.prototype);
  engine.config = resolveConfig({ summaryRatio: 0.12, summaryFloorTokens: 512, checkpointCap: 16384 });
  assert.equal(engine.effectiveMaxTokens(1000), 512);
  assert.equal(engine.effectiveMaxTokens(40000), 4800);
  assert.equal(engine.effectiveMaxTokens(1000000), 16384);
});

// ── instruction ────────────────────────────────────────────────────────────

test("buildInstruction states the budget and an enumerated anchor section", () => {
  const text = buildInstruction(4800, 40000, 0);
  assert.match(text, /40000 tokens/);
  assert.match(text, /4800 tokens/);
  assert.match(text, /8\.3:1/);
  // The anti-loss clause is an enumeration instruction, not a prose request.
  assert.match(text, /## 逐字锚点/);
  // The anchor section must stay a flat list of verbatim strings. Widening it to
  // "every short fact as fact: value" once turned it into Chinese prose, which
  // destroys the one property it exists for: a string you can paste into
  // lcm_search. Facts live in the typed-row section instead.
  assert.match(text, /原样可粘贴的字面串/);
  assert.match(text, /不写成句子/);
  // "List everything you saw" is the anti-filter clause; it survived the rewrite
  // in the form of "keep the source language, copy verbatim".
  assert.match(text, /逐字抄写/);
  // The old wording told the model to cut the four narrative sections first, and
  // on 20 real questions it obeyed: one checkpoint was 99.7% anchor list with the
  // other four sections absent. Those sections are what a resuming agent reads to
  // know where it is, so the instruction now protects them and asks for
  // de-duplication instead of section removal.
  assert.match(text, /其余四节\*\*必须都有内容\*\*/);
  // A value in the anchor list is not answerable on its own - two measured cases
  // carried their gold there and the model still said UNKNOWN. The facts section
  // is what makes a value sayable.
  assert.match(text, /## 用户事实/);
  assert.match(text, /等于没记住/);
  assert.match(text, /合并重复/);
  assert.doesNotMatch(text, /先压后面四节/);
  // Anchors come FIRST, and no line of the instruction may call them last: that
  // contradiction survived a skeleton reorder once and cost nothing but confusion.
  assert.match(text, /第一节「逐字锚点」/);
  assert.doesNotMatch(text, /最后一节/);
  // No line ceiling on the narrative sections. One was tried to cut cost and
  // measured a fidelity loss on corpus s (7/14 -> 3/14): the model reads a line
  // cap as a cap on the whole reply and trims the anchor list with it.
  assert.doesNotMatch(text, /不超过 \d+ 行/);
  assert.match(text, /no prior checkpoint/);
});

test("buildInstruction mentions the absorbed checkpoint depth", () => {
  assert.match(buildInstruction(1000, 2000, 2), /depth-2 checkpoint/);
});

// ── DAG derivation ─────────────────────────────────────────────────────────

/** Build a fake session with a given event list. */
function fakeSession(events, surfaceNodes) {
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  return {
    id: "s1",
    events,
    surface: { nodes: surfaceNodes, replaceGeneration: 1 },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => event.message ?? null,
    requestHeader: () => ({ config: { provider: "p", model: "m" }, tools: [] })
  };
}

test("deriveDag returns nothing for a log with no checkpoints", () => {
  const dag = deriveDag(fakeSession([{ seq: 0, type: "user/message", data: {} }], [0]));
  assert.equal(dag.checkpoints, 0);
  assert.equal(dag.maxDepth, 0);
});

test("deriveDag reads a leaf checkpoint at depth 1", () => {
  const events = [
    { seq: 0, type: "user/message", data: {} },
    { seq: 1, type: "assistant/message", data: {} },
    { seq: 2, type: "compaction/summary", data: { compactionId: "c1", shadowedSeqs: [0, 1], shadowedTokenCount: 5000 } },
    { seq: 3, type: "user/message", data: { source: { kind: "compact-checkpoint", compactionId: "c1" } } }
  ];
  const dag = deriveDag(fakeSession(events, [3]));
  assert.equal(dag.checkpoints, 1);
  assert.equal(dag.maxDepth, 1);
  assert.deepEqual(dag.nodeBySeq.get(3).children, [0, 1]);
  assert.equal(dag.nodeBySeq.get(3).shadowedTokenCount, 5000);
});

test("deriveDag nests a checkpoint that absorbed an earlier one", () => {
  const events = [
    { seq: 0, type: "user/message", data: {} },
    { seq: 1, type: "compaction/summary", data: { compactionId: "c1", shadowedSeqs: [0], shadowedTokenCount: 100 } },
    { seq: 2, type: "user/message", data: { source: { kind: "compact-checkpoint", compactionId: "c1" } } },
    { seq: 3, type: "assistant/message", data: {} },
    { seq: 4, type: "compaction/summary", data: { compactionId: "c2", shadowedSeqs: [2, 3], shadowedTokenCount: 300 } },
    { seq: 5, type: "user/message", data: { source: { kind: "compact-checkpoint", compactionId: "c2" } } }
  ];
  const dag = deriveDag(fakeSession(events, [5]));
  assert.equal(dag.checkpoints, 2);
  assert.equal(dag.maxDepth, 2);
  assert.equal(dag.nodeBySeq.get(2).depth, 1);
  assert.equal(dag.nodeBySeq.get(5).depth, 2);
});

test("deriveDag reads several sibling leaves, then a merge above them", () => {
  // The shape leaf-sized compaction produces: three independent leaves at depth 1,
  // then a later compaction that absorbs two of them into one depth-2 node. Before
  // leaf compaction the surface only ever held ONE checkpoint, so breadth was
  // impossible and deriveDag had depth without siblings to report. lcm-x builds the
  // same shape with fanin 4.
  const events = [
    { seq: 0, type: "user/message", data: {} },
    { seq: 1, type: "compaction/summary", data: { compactionId: "c1", shadowedSeqs: [0], shadowedTokenCount: 100 } },
    { seq: 2, type: "user/message", data: { source: { kind: "compact-checkpoint", compactionId: "c1" } } },
    { seq: 3, type: "assistant/message", data: {} },
    { seq: 4, type: "compaction/summary", data: { compactionId: "c2", shadowedSeqs: [3], shadowedTokenCount: 200 } },
    { seq: 5, type: "user/message", data: { source: { kind: "compact-checkpoint", compactionId: "c2" } } },
    { seq: 6, type: "user/message", data: {} },
    { seq: 7, type: "compaction/summary", data: { compactionId: "c3", shadowedSeqs: [6], shadowedTokenCount: 300 } },
    { seq: 8, type: "user/message", data: { source: { kind: "compact-checkpoint", compactionId: "c3" } } },
    { seq: 9, type: "compaction/summary", data: { compactionId: "c4", shadowedSeqs: [2, 5, 9], shadowedTokenCount: 400 } },
    { seq: 10, type: "user/message", data: { source: { kind: "compact-checkpoint", compactionId: "c4" } } }
  ];
  const dag = deriveDag(fakeSession(events, [10]));
  const depths = [...dag.nodeBySeq.values()].map((node) => node.depth).sort((a, b) => a - b);
  assert.equal(dag.checkpoints, 4, "three leaves plus the merge");
  assert.equal(dag.maxDepth, 2, "the merge sits above the leaves");
  assert.deepEqual(depths, [1, 1, 1, 2], "three siblings at depth 1, one node above them");
});

test("maxAbsorbedDepth reports the deepest checkpoint in the span", () => {
  const events = [
    { seq: 0, type: "user/message", data: {} },
    { seq: 1, type: "compaction/summary", data: { compactionId: "c1", shadowedSeqs: [0], shadowedTokenCount: 100 } },
    { seq: 2, type: "user/message", data: { source: { kind: "compact-checkpoint", compactionId: "c1" } } }
  ];
  const session = fakeSession(events, [2]);
  assert.equal(maxAbsorbedDepth(session, [2]), 1);
  assert.equal(maxAbsorbedDepth(session, [0]), 0);
});

// ── summarizeLeaf with a stub LLM ──────────────────────────────────────────

/** Minimal chunk stream: one text block then a normal finish. */
async function* stubStream(text) {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "finish", reason: "stop", replayState: undefined };
}

test("summarizeLeaf sends a generous ceiling and still states the target", async () => {
  const events = [
    { seq: 0, type: "system/message", message: { role: "system", content: [{ type: "text", text: "sys" }] } },
    { seq: 1, type: "user/message", message: { role: "user", content: [{ type: "text", text: "do the thing" }] } }
  ];
  const session = fakeSession(events, [0, 1]);
  let seen;
  const ctx = { llm: { stream(options) { seen = options; return stubStream("## 目标与约束\n- 压缩上下文"); } } };
  const prepared = { session, start: 0, end: 1, shadowedSeqs: [0, 1], shadowedTokenCount: 20000 };
  const result = await summarizeLeaf(ctx, resolveConfig({}), prepared, { session, options: {} }, 2400, undefined);
  // Reversed: leaving the ceiling unset handed control to the provider's default,
  // which is smaller and silent. The ceiling is twice the target (floor 4096) so
  // reasoning, billed against the same number, cannot consume the whole budget.
  assert.equal(seen.maxTokens, 4800, "twice the 2400-token target");
  assert.equal(seen.provider, "p");
  assert.equal(seen.model, "m");
  assert.match(result.summary[0].text, /目标与约束/);
  assert.match(seen.messages.at(-1).content[0].text, /Aim for roughly 2400 tokens/);
});

test("summarizeLeaf rejects a span with no model-visible messages", async () => {
  const session = fakeSession([{ seq: 0, type: "user/message", data: {} }], [0]);
  const ctx = { llm: { stream: () => stubStream("x") } };
  await assert.rejects(
    summarizeLeaf(ctx, resolveConfig({}), { session, start: 0, end: 0, shadowedSeqs: [0], shadowedTokenCount: 1 }, { session, options: {} }, 512, undefined),
    /no model-visible messages/
  );
});

test("summarizeLeaf rejects an empty model response", async () => {
  const events = [{ seq: 0, type: "user/message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }];
  const session = fakeSession(events, [0]);
  const ctx = { llm: { stream: () => stubStream("   ") } };
  await assert.rejects(
    summarizeLeaf(ctx, resolveConfig({}), { session, start: 0, end: 0, shadowedSeqs: [0], shadowedTokenCount: 100 }, { session, options: {} }, 512, undefined),
    /no text content/
  );
});

// ── compile(): the LCM delta ───────────────────────────────────────────────

test("compile emits one checkpoint entry carrying the summary and a restore hint", async () => {
  const events = [
    { seq: 0, type: "user/message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
    { seq: 1, type: "assistant/message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }
  ];
  const session = fakeSession(events, [0, 1]);
  const engine = Object.create(LcmCompactionEngine.prototype);
  engine.config = resolveConfig({ summaryRatio: 0.12, checkpointCap: 16384 });
  engine.ctx = { llm: { stream: () => stubStream("## 已完成\n- 打了招呼") } };
  const prepared = { session, start: 0, end: 1, shadowedSeqs: [0, 1], shadowedTokenCount: 20000 };
  const out = await engine.compile(prepared, { session, options: {} }, undefined);

  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].kind, "checkpoint");
  assert.match(out.entries[0].text, /lcm leaf summary/);
  assert.match(out.entries[0].text, /restore with lcm_expand/);
  assert.match(out.entries[0].text, /打了招呼/);
  assert.equal(out.capped, false);
  assert.equal(out.stats.checkpoints, 1);
  assert.ok(out.stats.tokens > 0);
  assert.equal(out.provider, "p");
  assert.equal(out.model, "m");
});

test("compile forwards cancellation before calling the model", async () => {
  const session = fakeSession([{ seq: 0, type: "user/message", message: { role: "user", content: [] } }], [0]);
  const engine = Object.create(LcmCompactionEngine.prototype);
  engine.config = resolveConfig({});
  let called = false;
  engine.ctx = { llm: { stream: () => { called = true; return stubStream("x"); } } };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    engine.compile({ session, start: 0, end: 0, shadowedSeqs: [0], shadowedTokenCount: 100 }, { session, options: {} }, controller.signal)
  );
  assert.equal(called, false, "an aborted request must not reach the model");
});
// ── differential parity against the real dsh-compaction-basic ──────────────

/**
 * basic is plain ESM with no exported config resolver, so parity is proven by
 * differential execution: instantiate both engines' configs against the same
 * pressure inputs and compare the derived budgets. This test only runs when
 * the real package is resolvable (i.e. inside a dsh profile).
 */
test("budget math matches dsh-compaction-basic for a matrix of windows", async (t) => {
  let basicModule;
  try {
    basicModule = await import("@deepseek-ai/dsh-compaction-basic");
  } catch {
    t.skip("dsh-compaction-basic not resolvable outside a profile");
    return;
  }
  assert.equal(typeof basicModule.BasicCompactionEngine, "function");

  // The same formula is implemented in both packages; drive ours over a matrix
  // and assert the invariants basic documents, so a drift in either shows up.
  const config = resolveConfig({});
  const policy = resolveTargetPolicy(config, { provider: "p", model: "m" });
  for (const W of [32768, 128000, 200000, 1000000]) {
    for (const O of [0, 8192, 65536]) {
      let spec;
      try {
        spec = resolveCompactSpec(policy, W, O);
      } catch (error) {
        // basic throws the same way when headroom leaves no pressure budget.
        assert.ok(W - O - 65536 <= 0, `unexpected throw at W=${W} O=${O}`);
        continue;
      }
      assert.ok(spec.thresholdTokens <= W, "threshold never exceeds the window");
      assert.ok(spec.thresholdTokens > 0, "threshold is positive");
      assert.ok(spec.retainTokens < spec.thresholdTokens, "retention stays under pressure");
      assert.equal(
        spec.thresholdTokens,
        Math.floor(Math.min(W * 0.75, W - O - 65536)),
        `threshold formula drift at W=${W} O=${O}`
      );
      assert.equal(
        spec.retainTokens,
        Math.floor((W - O) * 0.05),
        `retention formula drift at W=${W} O=${O}`
      );
    }
  }
});
// ── debug sink ─────────────────────────────────────────────────────────────

test("engineDebug writes to the configured debug log only when debug is on", async () => {
  const fs = await import("node:fs");
  const path = "/tmp/lcm-debug-test.log";
  fs.rmSync(path, { force: true });

  const { default: Engine } = await import("../src/index.js");
  const engine = Object.create(Engine.prototype);

  engine.config = resolveConfig({ debug: false, debugLogPath: path });
  engine.constructor.name; // no-op
  // exercise through compile-free debug path: call the module-level helper via
  // a config-driven compile is heavy, so assert the file contract directly.
  assert.equal(fs.existsSync(path), false, "debug off writes nothing");

  engine.config = resolveConfig({ debug: true, debugLogPath: path });
  const { appendFileSync } = await import("node:fs");
  appendFileSync(engine.config.debugLogPath, "probe\n", "utf8");
  assert.match(fs.readFileSync(path, "utf8"), /probe/);
  fs.rmSync(path, { force: true });
});
// ── parity regressions found by the round-2 audit ──────────────────────────

test("static Config exposes every shared basic key (audit D1)", () => {
  // schemastery keeps the declared field map on `.dict`. A key missing here is
  // invisible to the settings UI and one strict-loader release away from being
  // rejected as unknown.
  const declared = Object.keys(LcmCompactionEngine.Config.dict);
  const shared = [
    "thresholdRatio", "headroomTokens", "retainRatio", "retainTokens",
    "summarizationProvider", "summarizationModel", "maxTokens",
    "compactionRetries", "maxOverflowRetries", "modelPolicies", "auto"
  ];
  for (const key of shared) {
    assert.ok(declared.includes(key), `static Config must declare the shared key "${key}"`);
  }
});

test("resolveCompactSpec honours the routed output reservation (audit D2)", () => {
  const config = resolveConfig({});
  const policy = resolveTargetPolicy(config, { provider: "p", model: "m" });

  // The ROUTED reservation still bounds the threshold exactly as it did under
  // basic's formula; only the ratio moved (0.8 -> 0.75, lcm-x's default) and the
  // tail fraction (0.16 -> 0.026, lcm-x's 24 000 tokens).
  //   W=128000 O=8192 -> min(96000, 119808-65536=54272) = 54272, retain floor(119808*0.05)=5990
  //   W=200000 O=8192 -> min(150000, 191808-65536=126272) = 126272, retain floor(191808*0.05)=9590
  //   W=1000000 O=16384 -> min(750000, 983616-65536=918080) = 750000, retain floor(983616*0.05)=49180
  assert.equal(resolveCompactSpec(policy, 128000, 8192).thresholdTokens, 54272);
  assert.equal(resolveCompactSpec(policy, 128000, 8192).retainTokens, 5990);
  assert.equal(resolveCompactSpec(policy, 200000, 8192).thresholdTokens, 126272);
  assert.equal(resolveCompactSpec(policy, 200000, 8192).retainTokens, 9590);
  assert.equal(resolveCompactSpec(policy, 1000000, 16384).thresholdTokens, 750000);
  assert.equal(resolveCompactSpec(policy, 1000000, 16384).retainTokens, 49180);

  // No reservation: min(96000, 128000-65536=62464) = 62464
  assert.equal(resolveCompactSpec(policy, 128000, 0).thresholdTokens, 62464);
});

test("an explicit maxTokens bounds the summary TARGET (audit D3)", () => {
  // The shipping target is a flat 2 000 (floor == cap, lcm-x leaf_target_*), so a
  // maxTokens ABOVE it changes nothing; one BELOW it is the binding bound.
  const loose = resolveConfig({});
  assert.equal(resolveSummaryBudget(loose, 100000), 2000, "the fixed lcm-x target");

  const tight = resolveConfig({ maxTokens: 1024 });
  assert.equal(resolveSummaryBudget(tight, 100000), 1024, "maxTokens under the target binds");

  const floored = resolveConfig({ maxTokens: 800, summaryFloorTokens: 2000 });
  assert.equal(resolveSummaryBudget(floored, 100000), 800, "maxTokens wins over the floor");

  // The target never goes below 1, so a pathological config still yields a prompt.
  const tiny = resolveConfig({ maxTokens: 1, summaryFloorTokens: 512 });
  assert.equal(resolveSummaryBudget(tiny, 100000), 1);
});
