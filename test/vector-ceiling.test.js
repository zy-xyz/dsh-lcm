// ── batch, request, concurrency: what each number means ────────────────────
// 256 is the endpoint's hard limit, measured: 256 inputs return 200, 257 return
// HTTP 400 "Too many inputs in request". The previous 32 came from a note about a
// DIFFERENT endpoint and was never re-measured after the backend changed, so the
// backfill ran at one eighth of the capacity it was allowed.
//
// A cost-derived batch was tried and removed: per-text cost on this endpoint
// varies by two orders of magnitude with batch size and with upstream load (8.9 s
// at one text, 0.06 s at 256, 11.6 s at one text an hour later), so no single
// divisor is right in every regime.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { batchSizeFor, MAX_EMBED_BATCH, resolveVectorConfig, vectorSearchBudgetMs } from "../src/vectors.js";

const base = { vectorEnabled: true, vectorModel: "m", vectorDim: 4 };

test("the batch is the endpoint's hard limit, whatever the ceiling", () => {
  for (const timeoutMs of [5_000, 30_000, 150_000, 240_000]) {
    const cfg = resolveVectorConfig({ ...base, vectorTimeoutMs: timeoutMs });
    assert.equal(batchSizeFor(cfg), MAX_EMBED_BATCH,
      `a ${timeoutMs} ms ceiling must still carry the full batch; the ceiling is a wall clock, not a size`);
  }
});

test("the limit is 256 — the value the endpoint actually enforces", () => {
  // 257 was measured to return HTTP 400. If this constant changes, the reason has
  // to be a new measurement, not a preference.
  assert.equal(MAX_EMBED_BATCH, 256);
});

test("the ceiling is per request and is returned unchanged", () => {
  const cfg = resolveVectorConfig({ ...base, vectorTimeoutMs: 150_000 });
  assert.equal(cfg.timeoutMs, 150_000);
});

test("concurrency defaults to more than one", () => {
  // The gateway's OWN latency is ~140 ms (x-envoy-upstream-service-time 117 +
  // x-kong-proxy-latency 19); the slowness is the upstream model, which is what
  // concurrency is for. An earlier default of 1 was set from a probe that used
  // the smallest possible batch, where the measurement did not represent the
  // workload.
  const cfg = resolveVectorConfig(base);
  assert.ok(cfg.concurrency >= 2, `concurrency should allow overlapping requests, got ${cfg.concurrency}`);
});

test("an offline pass retries a timeout, a search does not", () => {
  // Measured: this endpoint degrades from 1.8 s to 11.6 s per text over an hour.
  // An offline pass has no outer deadline, and its ceiling exists so the endpoint's
  // tail can be ridden out — so a timeout there is worth one more attempt. A search
  // carries a deadline, and re-spending it inside a live turn is worse than
  // degrading to lexical.
  const source = fs.readFileSync(new URL("../src/vectors.js", import.meta.url), "utf8");
  assert.match(source, /isTransientBackendFailure\(error, deadline !== undefined\)/u,
    "the retry decision must know whether a deadline applies");
  assert.ok(source.includes("timed out|aborted"), "the timeout branch exists");
  assert.match(source, /return !hasDeadline;/u, "and a timeout is retried only without a deadline");
});

test("a failed request gets three retries, with backoff", () => {
  // Three retries after the first attempt = four attempts. The count is an operator
  // decision; the BOUND is what has to hold, because an offline pass at a 240 s
  // ceiling would otherwise wait 16 min per batch with no ceiling on the pass.
  const source = fs.readFileSync(new URL("../src/vectors.js", import.meta.url), "utf8");
  assert.match(source, /const TRANSIENT_ATTEMPTS = 4;/u, "one initial attempt plus three retries");
  assert.match(source, /TRANSIENT_RETRY_MS \* 2 \*\* \(attempt - 1\)/u,
    "the delay doubles, so a recovering upstream is not hammered");

  // The pass-level breaker is what keeps the total bounded: 4 attempts x 240 s x 2
  // consecutive failed batches = 32 min once, not once per batch.
  const command = fs.readFileSync(new URL("../src/command.js", import.meta.url), "utf8");
  assert.match(command, /const BACKFILL_FAILURE_LIMIT = 2;/u,
    "the breaker must still stop a pass after two dead batches");
});

test("the search budget covers one full request", () => {
  const cfg = resolveVectorConfig({ ...base, vectorTimeoutMs: 30_000 });
  assert.ok(vectorSearchBudgetMs(cfg) >= cfg.timeoutMs);
});
