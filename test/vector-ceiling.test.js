// ── the ceiling must cover a whole batch ───────────────────────────────────
// Measured failure: `vectorTimeoutMs` was 30 s on the maintenance row while a
// 32-text batch costs ~150 s, so every batch timed out, twice in a row, and the
// breaker ended the pass silently for days.
//
// The first fix made the ceiling PER TEXT and derived the batch from it. That was
// wrong in the other direction: cost per text FALLS with batch size (8.9 s/text at
// 1, 4.7 at 8, 1.7 at 9), so forcing small batches pays the fixed overhead most
// often. These tests pin the shape the measurement actually supports.
import assert from "node:assert/strict";
import test from "node:test";

import { batchSizeFor, MAX_EMBED_BATCH, resolveVectorConfig, vectorSearchBudgetMs } from "../src/vectors.js";

const base = { vectorEnabled: true, vectorModel: "m", vectorDim: 4 };

/** The conservative measured cost per text, matching the implementation. */
const PER_TEXT_MS = 4_600;

test("the ceiling is per request and is returned unchanged", () => {
  const cfg = resolveVectorConfig({ ...base, vectorTimeoutMs: 150_000 });
  assert.equal(cfg.timeoutMs, 150_000, "one number, one meaning: the whole request");
});

test("a ceiling that covers 32 texts yields the full protocol batch", () => {
  // 32 texts at the measured cost is ~150 s. This is the configuration that makes
  // a backfill work at all.
  const cfg = resolveVectorConfig({ ...base, vectorTimeoutMs: 150_000 });
  assert.equal(batchSizeFor(cfg), MAX_EMBED_BATCH);
});

test("a ceiling too small for 32 texts shrinks the BATCH, not the request", () => {
  // The old bug was a 30 s ceiling with a fixed 32-text batch: a request that could
  // never finish. Shrinking the batch keeps every request achievable.
  const cfg = resolveVectorConfig({ ...base, vectorTimeoutMs: 30_000 });
  const size = batchSizeFor(cfg);
  assert.ok(size < MAX_EMBED_BATCH, "a 30 s ceiling cannot carry 32 texts");
  assert.ok(size * PER_TEXT_MS <= cfg.timeoutMs,
    `a ${size}-text batch costs ~${size * PER_TEXT_MS} ms, over the ${cfg.timeoutMs} ms ceiling`);
});

test("the batch never drops below one, whatever the ceiling", () => {
  const cfg = resolveVectorConfig({ ...base, vectorTimeoutMs: 1_000 });
  assert.equal(batchSizeFor(cfg), 1, "a tiny ceiling still makes progress, one text at a time");
});

test("the search budget covers one full request", () => {
  const cfg = resolveVectorConfig({ ...base, vectorTimeoutMs: 30_000 });
  assert.ok(vectorSearchBudgetMs(cfg) >= cfg.timeoutMs,
    "a budget below one request's ceiling would refuse every search before its first call");
});
