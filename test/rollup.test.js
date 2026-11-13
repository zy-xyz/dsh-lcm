// ── temporal rollups (lcm-x `temporal_rollups_enabled`, on by default) ──
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendRollup, buildRollupRecord, pendingRollups, planDayRollups, readRollups, rollupFingerprint, utcDay
} from "../src/rollup.js";
import { resolveConfig } from "../src/config.js";

const DAY = 86400000;
const T0 = Date.parse("2026-11-13T10:00:00Z");

/** One checkpoint event on a given day. */
function checkpoint(seq, time, text) {
  return { type: "compaction/summary", seq, time, data: { summary: [{ type: "text", text }] } };
}

test("checkpoints are grouped by UTC day, oldest first", () => {
  const events = [
    checkpoint(10, T0, "a".repeat(400)),
    checkpoint(11, T0 + 3600000, "b".repeat(400)),
    checkpoint(12, T0 + DAY, "c".repeat(400)),
    { type: "user/message", seq: 13, time: T0, data: { message: { role: "user", content: [] } } }
  ];
  const planned = planDayRollups(events);
  assert.equal(planned.length, 2, "two days");
  assert.deepEqual(planned.map((day) => day.periodStart), ["2026-11-13", "2026-11-14"], "oldest first");
  assert.deepEqual(planned[0].entries.map((entry) => entry.seq), [10, 11], "only checkpoints, both on day one");
  assert.equal(planned[1].entries.length, 1);
  assert.ok(planned[0].tokens > 0, "the source is priced");
});

test("utcDay is a UTC slice, not local time", () => {
  assert.equal(utcDay(Date.parse("2026-11-13T23:30:00Z")), "2026-11-13");
  assert.equal(utcDay(Date.parse("2026-11-14T00:30:00Z")), "2026-11-14");
});

test("a stored rollup is stale when its covered checkpoints change", () => {
  const events = [checkpoint(10, T0, "a".repeat(400)), checkpoint(11, T0, "b".repeat(400))];
  const planned = planDayRollups(events);
  const built = buildRollupRecord(planned[0], "## 时间线\n- (seq 10) did a thing");

  assert.deepEqual(pendingRollups(planned, []).length, 1, "a day with no rollup is pending");
  assert.equal(pendingRollups(planned, [built]).length, 0, "and not pending once built");

  // A deeper checkpoint replaces the two leaves with one: same day, different sources.
  const replaced = planDayRollups([checkpoint(12, T0, "c".repeat(400))]);
  assert.equal(pendingRollups(replaced, [built]).length, 1, "a changed source set makes it pending again");
  assert.notEqual(rollupFingerprint(replaced[0].entries), built.fingerprint, "the fingerprint is what changed");
});

test("rollups round-trip through the sidecar, last write wins", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lcm-rollup-"));
  try {
    const planned = planDayRollups([checkpoint(10, T0, "a".repeat(400))]);
    appendRollup(dir, "session-1", buildRollupRecord(planned[0], "first"));
    appendRollup(dir, "session-1", buildRollupRecord(planned[0], "second"));
    const stored = readRollups(dir, "session-1");
    assert.equal(stored.length, 1, "one record per period, not one per write");
    assert.equal(stored[0].text, "second", "the newest write wins");
    assert.equal(stored[0].periodKind, "day");
    assert.deepEqual(readRollups(dir, "no-such-session"), [], "an absent file is empty, not an error");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rollups ship on with lcm-x's two bounds", () => {
  const config = resolveConfig({});
  assert.equal(config.temporalRollups, true, "lcm-x temporal_rollups_enabled defaults True");
  assert.equal(config.rollupBuildsPerPass, 2, "lcm-x rollup_builds_per_pass");
  assert.equal(config.rollupMaintenanceBudgetMs, 5000, "lcm-x rollup_maintenance_budget_ms");
  assert.equal(config.rollupDailyTargetTokens, 5000);
  assert.equal(config.rollupDailyMaxTokens, 15000);
});
