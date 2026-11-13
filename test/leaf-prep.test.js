// ── background leaf preparation (lcm-x `background_leaf_prep_enabled`) ──
import assert from "node:assert/strict";
import test from "node:test";

import { LeafPrepCache, preparedLeafKey } from "../src/prep.js";
import { resolveConfig } from "../src/config.js";

test("a prepared leaf keys on span AND route AND body content", () => {
  // lcm-x pre-summarises the next leaf in a daemon thread and promotes it later.
  // The property that makes that safe: an entry is usable ONLY for the exact span
  // and route it was computed from, because a checkpoint committed from a stale
  // summary would replace different text with a description of the first one.
  const events = [
    { seq: 1, type: "user/message", time: 1, data: { message: { role: "user", content: [{ type: "text", text: "alpha" }] } } },
    { seq: 2, type: "assistant/message", time: 1, data: { message: { role: "assistant", content: [{ type: "text", text: "beta" }] } } }
  ];
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const session = {
    id: "prep",
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => event?.data?.message ?? null
  };
  const prepared = { session, shadowedSeqs: [1, 2], shadowedTokenCount: 200 };
  const route = { provider: "p", model: "m" };

  const key = preparedLeafKey(prepared, route);
  assert.match(key, /^[0-9a-f]{64}$/u, "the key is a digest");
  assert.equal(preparedLeafKey(prepared, route), key, "an identical span keys identically");
  assert.notEqual(preparedLeafKey(prepared, { provider: "p", model: "other" }), key, "a different model must miss");

  const edited = { ...events[1], data: { message: { role: "assistant", content: [{ type: "text", text: "BETA" }] } } };
  const editedSession = { ...session, eventAt: (seq) => (seq === 2 ? edited : bySeq.get(seq)) };
  assert.notEqual(preparedLeafKey({ ...prepared, session: editedSession }, route), key, "an edited body must miss");
});

test("taking a prepared leaf removes it, so it cannot be promoted twice", () => {
  const cache = new LeafPrepCache(2);
  assert.equal(cache.hasCapacity, true);
  cache.put("k", { summary: [{ type: "text", text: "prepared" }] });
  assert.equal(cache.has("k"), true, "the entry is stored");
  assert.equal(cache.take("k").summary[0].text, "prepared", "and returned");
  assert.equal(cache.take("k"), undefined, "but only once");
  assert.match(cache.describe(), /hits=1 misses=1 computed=1/u, cache.describe());
});

test("the prep cache is bounded and evicts the oldest entry", () => {
  const cache = new LeafPrepCache(2);
  cache.put("a", { summary: [] });
  cache.put("b", { summary: [] });
  assert.equal(cache.hasCapacity, false, "full at its capacity");
  cache.put("c", { summary: [] });
  assert.equal(cache.has("a"), false, "the oldest was evicted");
  assert.equal(cache.has("b"), true);
  assert.equal(cache.has("c"), true);
});

test("backgroundLeafPrep ships off, like the reference", () => {
  assert.equal(resolveConfig({}).backgroundLeafPrep, false, "off unless asked");
  assert.equal(resolveConfig({ backgroundLeafPrep: true }).backgroundLeafPrep, true, "and switchable on");
});
