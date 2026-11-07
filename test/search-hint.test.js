/**
 * Zero-hit guidance — the search tool teaches the shape of a query that works.
 *
 * Two measured facts drive this: pasting a natural-language question into a
 * line-by-line literal search returns nothing (499 of LongMemEval_S's 500
 * questions), and a multi-word pattern is one adjacent phrase, not an AND. A
 * zero-hit result therefore carries one short line saying why and what to try
 * instead. It is advice only: the pattern is never rewritten and never re-run,
 * and a search that does match must stay byte-for-byte what it always was.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { searchSession, zeroHitHint } from "../src/search.js";
import { SEARCH_DESCRIPTION, defineSearchTool, resolveConfig } from "../src/tool.js";

/** A session with two events that both mention one phrase. */
function fixture() {
  const events = [
    { type: "session", id: "s" },
    { type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: "we chose integer[] for the target token column" }] } },
    { type: "assistant/message", seq: 1, time: 1, data: { message: { role: "assistant", content: [{ type: "text", text: "noted; target token again" }] } } }
  ];
  return {
    events,
    eventAt: (seq) => events.find((e) => e.seq === seq),
    deriveEventMessage: (event) => event.data?.message ?? (event.data?.content === undefined ? null : { role: "user", content: event.data.content })
  };
}

const CONFIG = { maxSearchHits: 50, maxRecallTokens: 100000 };
const QUESTION = "how did we configure the domain controller";

test("a zero-hit result carries one actionable next step", () => {
  const result = searchSession(fixture(), QUESTION, CONFIG);
  const hint = result.text.split("\n\n")[1];
  assert.match(hint, /^\[a sentence, an adjacent phrase or an escaped metacharacter/, "the hint is its own block, right after the header");
  assert.match(hint, /\bcontroller\b/, "it offers a distinctive word to retry with");
  assert.match(hint, /controller\|configure/, "it offers the | alternative form, built from this pattern");
  assert.ok(hint.length < 200, "one or two lines, not a tutorial");
});

test("the zero-hit hint does not change the result structure", () => {
  const result = searchSession(fixture(), QUESTION, CONFIG);
  assert.deepEqual(result.hits, [], "hits stays an empty array");
  assert.equal(result.totalMatches, 0);
  assert.equal(result.omitted, 0);
  assert.equal(result.truncated, false);
  assert.equal(result.tokens, 0);
  assert.equal(result.pattern, QUESTION);
  assert.equal(result.rank, "density");
});

test("a search that matches is unchanged, byte for byte", () => {
  // The exact pre-change rendering of this fixture, pinned.
  const expected = [
    '[search "target token": 2 matching event(s)]',
    "[seq 1: assistant]\n  1: noted; target token again",
    "[seq 0: user]\n  1: we chose integer[] for the target token column",
    "[use recall with a (seq N) pointer to restore any hit's full original content]"
  ].join("\n\n");
  const result = searchSession(fixture(), "target token", CONFIG);
  assert.equal(result.text, expected);
  assert.ok(!result.text.includes("one literal string here"), "no hint on a matching search");
  assert.equal(result.totalMatches, 2);
});

test("the hint is derived from the pattern, and never rewrites it", () => {
  const result = searchSession(fixture(), "a b", CONFIG);
  assert.equal(result.pattern, "a b", "the pattern is reported exactly as given");
  assert.match(zeroHitHint("a b"), /timeout\|ETIMEDOUT/, "short tokens fall back to a generic example");
  assert.match(zeroHitHint("ETIMEDOUT timeout"), /ETIMEDOUT\|timeout/, "the longest token leads");
  assert.doesNotMatch(zeroHitHint("timeout|ETIMEDOUT"), /either\/or/, "a pattern that already uses | gets no lesson about |");
});

test("the tool description teaches the query shape", () => {
  assert.match(SEARCH_DESCRIPTION, /natural-language question almost never hits/);
  assert.match(SEARCH_DESCRIPTION, /timeout\|ETIMEDOUT/);
  assert.match(SEARCH_DESCRIPTION, /Escape regex special characters/);
  const schema = defineSearchTool(resolveConfig({})).parameters.properties.pattern;
  assert.match(schema.description, /distinctive word/);
  assert.match(schema.description, /\|/);
});
