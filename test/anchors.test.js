/**
 * Verbatim-anchor pointers — the anchor list carries its own provenance.
 *
 * A summary's anchor list is only useful if the agent can act on it, and acting
 * on it means \`lcm_expand (seq N)\`. Asking the model for pointers is not an
 * option: the summarizer input is the verbatim span replayed to reuse the
 * provider prefix cache, so seq markers cannot be inserted into it. Pointers are
 * therefore attributed after the fact against the same rendered bytes
 * \`lcm_search\` searches, and an anchor the span never contained keeps no
 * pointer at all — a guessed seq would send \`lcm_expand\` to the wrong event.
 *
 * Run with: node --test test/anchors.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfig } from "../src/config.js";
import { LcmCompactionEngine } from "../src/index.js";
import { attributeAnchorPointers, summarizeLeaf } from "../src/summarize.js";

/** A session whose events each render one line of text. */
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
    deriveEventMessage: (event) => event.message ?? null,
    requestHeader: () => ({ config: { provider: "p", model: "m" }, tools: [] })
  };
}

/** A three-anchor summary; the third anchor is nowhere in the span. */
const SUMMARY = [
  "## 逐字锚点",
  "- /vol3/1000/work/notes/baseline.md",
  "- LD_LIBRARY_PATH",
  "- 0xfffffe00075b9000",
  "",
  "## 目标与约束",
  "- 把 baseline.md 的结论写进报告"
].join("\n");

const SPAN = [
  "读了 /vol3/1000/work/notes/baseline.md，结论是缓存失效",
  "导出 LD_LIBRARY_PATH=/opt/lib 之后重跑",
  "其余无关的一行"
];

test("anchors the span contained get their seq; the rest stay untouched", async () => {
  const session = sessionOf(SPAN);
  const out = attributeAnchorPointers(SUMMARY, session, [0, 1, 2]);
  const lines = out.split("\n");
  assert.equal(lines[1], "- /vol3/1000/work/notes/baseline.md (seq 0)");
  assert.equal(lines[2], "- LD_LIBRARY_PATH (seq 1)");
  assert.equal(lines[3], "- 0xfffffe00075b9000", "an anchor the span never held keeps no pointer");
  // The narrative section is never rewritten.
  assert.equal(lines[6], "- 把 baseline.md 的结论写进报告");
  // Default-on wiring: an unconfigured run goes through summarizeLeaf and lands
  // the same pointers, so the feature is not opt-in by accident.
  const ctx = { llm: { stream: () => stubStream(SUMMARY) } };
  const prepared = { session, start: 0, end: 2, shadowedSeqs: [0, 1, 2], shadowedTokenCount: 20000 };
  const result = await summarizeLeaf(ctx, resolveConfig({}), prepared, { session, options: {} }, 2400, undefined);
  assert.equal(result.summary[0].text, out, "anchorPointers defaults to true");
});

test("anchorPointers: false is byte-identical to the model output", () => {
  const session = sessionOf(SPAN);
  let seen;
  const ctx = {
    llm: {
      stream(options) {
        seen = options;
        return stubStream(SUMMARY);
      }
    }
  };
  const prepared = { session, start: 0, end: 2, shadowedSeqs: [0, 1, 2], shadowedTokenCount: 20000 };
  return summarizeLeaf(ctx, resolveConfig({ anchorPointers: false }), prepared, { session, options: {} }, 2400, undefined)
    .then((result) => {
      assert.equal(result.summary[0].text, SUMMARY, "off means untouched");
      // The instruction is unchanged either way: attribution never reaches the input.
      assert.match(seen.messages.at(-1).content[0].text, /## 逐字锚点/);
    });
});

test("an anchor in several events resolves to the first occurrence", () => {
  const session = sessionOf([
    "第一处提到 LD_LIBRARY_PATH",
    "第二处又提到 LD_LIBRARY_PATH",
    "第三处还是 LD_LIBRARY_PATH"
  ]);
  const out = attributeAnchorPointers("## 逐字锚点\n- LD_LIBRARY_PATH\n", session, [0, 1, 2]);
  assert.equal(out, "## 逐字锚点\n- LD_LIBRARY_PATH (seq 0)\n");
});

test("anchors full of regex metacharacters attribute as literals", () => {
  const session = sessionOf([
    "no match here",
    "pattern .* (foo) [bar] a+b?c | d$ ^e 出现在这一行"
  ]);
  const out = attributeAnchorPointers("## 逐字锚点\n- .* (foo) [bar] a+b?c | d$ ^e\n", session, [0, 1]);
  assert.equal(out, "## 逐字锚点\n- .* (foo) [bar] a+b?c | d$ ^e (seq 1)\n");
});

test("attribution never reaches outside the shadowed span", () => {
  const session = sessionOf(["区间内没有这一串", "区间外才有 ZZZ_TOKEN_XYZ"]);
  const inside = attributeAnchorPointers("## 逐字锚点\n- ZZZ_TOKEN_XYZ\n", session, [0]);
  assert.equal(inside, "## 逐字锚点\n- ZZZ_TOKEN_XYZ\n", "a seq outside the span is out of scope");
  const covering = attributeAnchorPointers("## 逐字锚点\n- ZZZ_TOKEN_XYZ\n", session, [0, 1]);
  assert.equal(covering, "## 逐字锚点\n- ZZZ_TOKEN_XYZ (seq 1)\n");
});

test("the anchor section stops at its 120-line bound, keeping the verified ones", () => {
  const probes = Array.from({ length: 200 }, (_, index) => `probe_${String(index).padStart(3, "0")}`);
  // Only probes 150..199 occur in the span, so exactly 50 anchors are verified.
  const session = sessionOf(["span head", ...probes.slice(150)]);
  const summary = ["## 逐字锚点", ...probes.map((probe) => `- ${probe}`), "", "## 目标与约束", "- 把结论写进报告"].join("\n");
  const lines = attributeAnchorPointers(summary, session, session.events.map((event) => event.seq)).split("\n");
  const section = lines.slice(1, lines.indexOf(""));
  assert.equal(section.length, 120, "the 120-line bound is enforced in code, not only asked for in the prompt");
  assert.ok(section.includes("- probe_150 (seq 1)"), "a verified anchor keeps its pointer and its slot");
  assert.ok(section.includes("- probe_199 (seq 50)"));
  assert.equal(section.filter((line) => !line.includes("(seq ")).length, 70, "the remaining 70 slots hold unverified anchors");
  assert.ok(section.includes("- probe_000"));
  assert.ok(!section.includes("- probe_070"), "later unverified anchors are the first to go");
  assert.equal(lines.at(-1), "- 把结论写进报告", "the sections after the list are untouched");
});

test("a line holding only a backtick, and a copied section heading, are dropped", () => {
  const session = sessionOf([
    "这里有一个 ` 反引号",
    "模型把标题 ## 目标与约束 抄进了词表",
    "真正该留的 REAL_TOKEN 在第三行"
  ]);
  // Both garbage lines DO resolve in the span, so the drop is the prune and not a missing pointer.
  const summary = ["## 逐字锚点", "`", "`## 目标与约束`", "- REAL_TOKEN", "", "## 目标与约束", "- 写报告"].join("\n");
  const out = attributeAnchorPointers(summary, session, [0, 1, 2]);
  assert.equal(out, ["## 逐字锚点", "- REAL_TOKEN (seq 2)", "", "## 目标与约束", "- 写报告"].join("\n"));
});

test("a path, a URL, a bare number and a one-word anchor all survive the prune", () => {
  const session = sessionOf(["cp /tmp/x 之后 curl https://example.com/a?b=c 跑了 42 次，这只是一个 fact"]);
  const summary = ["## 逐字锚点", "- /tmp/x", "- https://example.com/a?b=c", "- 42", "- fact", "", "## 目标与约束", "- 写报告"].join("\n");
  const lines = attributeAnchorPointers(summary, session, [0]).split("\n");
  assert.deepEqual(lines.slice(1, 5), [
    "- /tmp/x (seq 0)",
    "- https://example.com/a?b=c (seq 0)",
    "- 42 (seq 0)",
    "- fact (seq 0)"
  ]);
});

test("anchorPointers: false returns even a dirty over-long section untouched", async () => {
  const session = sessionOf(["probe_000 和 ` 都在这一行"]);
  const dirty = ["## 逐字锚点", "`", ...Array.from({ length: 200 }, (_, index) => `- probe_${index}`), "", "## 目标与约束", "- 写报告"].join("\n");
  const ctx = { llm: { stream: () => stubStream(dirty) } };
  const prepared = { session, start: 0, end: 0, shadowedSeqs: [0], shadowedTokenCount: 20000 };
  const off = await summarizeLeaf(ctx, resolveConfig({ anchorPointers: false }), prepared, { session, options: {} }, 2400, undefined);
  assert.equal(off.summary[0].text, dirty, "off is the escape hatch: no pointers, no prune, no cap");
  const on = await summarizeLeaf(ctx, resolveConfig({}), prepared, { session, options: {} }, 2400, undefined);
  assert.ok(on.summary[0].text.length < dirty.length, "and the default path is where the bound lives");
});

test("overflow cuts the anchor the span repeats most before a one-off literal", () => {
  // `uniq_1` is a PREFIX of `uniq_10`..`uniq_128` on purpose: a bare substring count
  // scored it ~20 repeats and cut it before `the`, the word the span really repeats.
  const unique = Array.from({ length: 129 }, (_, index) => `uniq_${index}`);
  const session = sessionOf([`${"the ".repeat(9)}the ${unique.join(" ")}`]);
  const summary = ["## 逐字锚点", "- the", ...unique.map((token) => `- ${token}`), "", "## 目标与约束", "- 写报告"].join("\n");
  const lines = attributeAnchorPointers(summary, session, [0]).split("\n");
  const section = lines.slice(1, lines.indexOf(""));
  assert.equal(section.length, 120);
  assert.ok(!section.some((line) => line.startsWith("- the")), "the word the span repeats is the cheapest line");
  assert.ok(section.includes("- uniq_1 (seq 0)"), "being a prefix of longer anchors is not being repeated");
  assert.ok(section.includes("- uniq_0 (seq 0)"), "a literal mentioned once keeps its slot");
  assert.ok(!section.some((line) => line.startsWith("- uniq_128")), "ties drop the latest-listed");
});

test("a copied pointer that names the wrong event is re-attributed to the right one", () => {
  // The measured shape: checkpoint seq 39 is a REWORDED summary, so a pointer
  // copied forward from it names an event whose text does not hold the literal.
  const session = sessionOf([
    "命令: `echo alpha`, `echo beta`, `echo gamma`",
    "这一条是被改写过的摘要，原命令不在里面"
  ]);
  const summary = ["## 逐字锚点", "- 命令: `echo alpha`, `echo beta`, `echo gamma` (seq 1)", "", "## 目标与约束", "- 写报告"].join("\n");
  const lines = attributeAnchorPointers(summary, session, [0, 1]).split("\n");
  assert.equal(lines[1], "- 命令: `echo alpha`, `echo beta`, `echo gamma` (seq 0)", "the verified event wins over the copied claim");

  // A copied pointer that IS right costs nothing: the line comes back byte-identical.
  const correct = "## 逐字锚点\n- 命令: `echo alpha`, `echo beta`, `echo gamma` (seq 0)\n";
  assert.equal(attributeAnchorPointers(correct, session, [0, 1]), correct);
});

test("a pointer whose anchor is nowhere in the span is dropped, the text kept", () => {
  // Only the provenance is disproven: the line may still be real text, so it stays.
  const session = sessionOf(["span 里没有这条命令", "也没有别的"]);
  const summary = ["## 逐字锚点", "rm -rf /tmp/never_written (seq 1)", "", "## 目标与约束", "- 写报告"].join("\n");
  const lines = attributeAnchorPointers(summary, session, [0, 1]).split("\n");
  assert.equal(lines[1], "rm -rf /tmp/never_written", "a provably wrong pointer goes; the text does not");
  assert.equal(lines[4], "- 写报告");
});

test("a capped anchor section says how many it kept, and the note is not an anchor", () => {
  // The measured run: 300 in-span anchors, 120 kept, 180 dropped, nothing said.
  const probes = Array.from({ length: 300 }, (_, index) => `probe_${String(index).padStart(3, "0")}`);
  const session = sessionOf(["span head", ...probes]);
  const summary = ["## 逐字锚点", ...probes.map((probe) => `- ${probe}`), "", "## 目标与约束", "- 把结论写进报告"].join("\n");
  const lines = attributeAnchorPointers(summary, session, session.events.map((event) => event.seq)).split("\n");
  const section = lines.slice(1, lines.indexOf(""));
  assert.equal(section.length, 120, "the note consumes no anchor slot");
  const note = lines.find((line) => /保留 120 \/ 300/.test(line));
  assert.ok(note !== undefined, "the cut is stated, not silent");
  assert.ok(!section.includes(note), "and the note is not counted as an anchor");
  const noteAt = lines.indexOf(note);
  assert.ok(noteAt > lines.indexOf("") && noteAt < lines.indexOf("## 目标与约束"), "it closes the section, before the next heading");
  assert.match(note, /lcm_search/u, "and it names where the dropped strings still live");
});

test("a section that drops nothing carries no note", () => {
  const out = attributeAnchorPointers(SUMMARY, sessionOf(SPAN), [0, 1, 2]);
  assert.ok(!/保留 \d+ \/ \d+/u.test(out), "no cut, no claim of one");
});

test("the deterministic rung says it was cut only when it cut something", async () => {
  // Measured: a 6-node span that fit completely (397 tokens, 6/6 seqs present) still
  // told the reader the tail had been cut deterministically.
  const fits = await compileDeterministic(6, 397);
  assert.match(fits, /DETERMINISTIC fallback/, "fixture check: this is the deterministic rung");
  assert.match(fits, /line 5 with some words here/, "all six seqs are present");
  assert.ok(!/truncat/iu.test(fits), "a body that fit must not claim a cut");

  const cut = await compileDeterministic(40, 100);
  assert.match(cut, /truncat/iu, "a body that WAS cut still says so");
  assert.match(cut, /lcm_search|lcm_expand/u, "and still names the recovery path");
});

/**
 * Compile a span through the deterministic rung: the model answers with reasoning
 * only, so compile() falls through to the no-model body.
 * @param nodes - how many span events.
 * @param shadowedTokens - the shrink bound the body is measured against.
 * @returns the committed checkpoint entry text.
 */
async function compileDeterministic(nodes, shadowedTokens) {
  const texts = Array.from({ length: nodes }, (_, index) => `line ${index} with some words here`);
  const session = sessionOf(texts);
  async function* reasoningOnly() {
    yield { type: "block-start", index: 0, blockType: "reasoning" };
    yield { type: "reasoning-delta", index: 0, text: "thinking" };
    yield { type: "finish", reason: { kind: "stop" }, replayState: undefined };
  }
  const engine = Object.create(LcmCompactionEngine.prototype);
  engine.config = resolveConfig({ summaryRatio: 0.12, summaryFloorTokens: 512, checkpointCap: 16384 });
  engine.ctx = { llm: { stream: () => reasoningOnly() } };
  const prepared = {
    session,
    start: 0,
    end: nodes - 1,
    shadowedSeqs: texts.map((_, index) => index),
    shadowedTokenCount: shadowedTokens
  };
  const out = await engine.compile(prepared, { session, options: {} }, undefined);
  return out.entries.map((entry) => entry.text).join("\n");
}

/** Minimal chunk stream: one text block then a normal finish. */
async function* stubStream(text) {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "finish", reason: "stop", replayState: undefined };
}
