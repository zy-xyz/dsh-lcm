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

/** Minimal chunk stream: one text block then a normal finish. */
async function* stubStream(text) {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "finish", reason: "stop", replayState: undefined };
}
