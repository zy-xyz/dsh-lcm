// ── the ceiling must scale with the batch ──────────────────────────────────
// Measured failure: `vectorTimeoutMs` was a PER-REQUEST ceiling, so a 32-text
// batch shared one 30 s limit with a 1-text batch. At ~4.7 s per text the batch
// needed ~150 s, timed out every time, and the maintenance pass failed silently
// for days while the cache stayed frozen.
//
// The fix is a per-TEXT allowance with a request ceiling derived from it, and a
// batch size derived from the same rule. These tests pin that derivation, because
// the two numbers agreeing is the whole property — a batch sized for a ceiling it
// does not get is the original bug wearing a different hat.
import assert from "node:assert/strict";
import test from "node:test";

import { batchSizeFor, MAX_EMBED_BATCH, resolveVectorConfig, vectorSearchBudgetMs } from "../src/vectors.js";

const base = { vectorEnabled: true, vectorModel: "m", vectorDim: 4 };

test("a bigger batch is given a bigger ceiling", () => {
  // The property the old design violated: N texts must be allowed more wall clock
  // than 1 text, or the batch is judged by the wrong standard.
  const cfg = resolveVectorConfig({ ...base, vectorTimeoutMs: 12000 });
  const one = cfg.timeoutMs + Math.min(cfg.timeoutMs, 5000);
  const many = cfg.timeoutMs * 19 + Math.min(cfg.timeoutMs, 5000);
  assert.ok(many > one * 10, "19 texts must be allowed far more than one");
});

test("the batch is sized so its ceiling fits under the hard cap", () => {
  const CAP = 240_000;
  for (const perText of [2_000, 5_000, 12_000, 25_000, 60_000]) {
    const cfg = resolveVectorConfig({ ...base, vectorTimeoutMs: perText });
    const size = batchSizeFor(cfg);
    const ceiling = Math.min(perText, 5_000) + perText * size;
    assert.ok(ceiling <= CAP, `a ${size}-text batch at ${perText} ms/text wants ${ceiling} ms, over the ${CAP} ms cap`);
    assert.ok(size >= 1, "and a batch is never empty");
    assert.ok(size <= MAX_EMBED_BATCH, "nor bigger than the protocol allows");
  }
});

test("a slow allowance yields a small batch, a fast one the maximum", () => {
  assert.equal(batchSizeFor({ ...base, vectorTimeoutMs: 2_000 }), MAX_EMBED_BATCH,
    "a fast endpoint fills the protocol batch");
  const slow = batchSizeFor({ ...base, vectorTimeoutMs: 60_000 });
  assert.ok(slow <= 4, `a 60 s allowance must shrink the batch to fit the cap, got ${slow}`);
});

test("the search budget covers the batch a search will send", () => {
  // The budget used to be `max(default, timeoutMs)`, which under per-text semantics
  // would fall BELOW one request ceiling and refuse every search before its first
  // call. It now scales the same way the ceiling does.
  const cfg = resolveVectorConfig({ ...base, vectorTimeoutMs: 12_000 });
  const budget = vectorSearchBudgetMs(cfg);
  const ceiling = Math.min(cfg.timeoutMs, 5_000) + cfg.timeoutMs * batchSizeFor(cfg);
  assert.ok(budget >= ceiling, `the budget (${budget}) must cover one full request (${ceiling})`);
});
