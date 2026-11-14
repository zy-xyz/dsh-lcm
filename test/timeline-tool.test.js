// ── the rollup store has a reader ──────────────────────────────────────────
// The audit found the store was write-only: `readRollups` was called by the
// maintenance pass and nothing else, `readAssertions` had zero references outside
// its own module, and there was no tool or command for either. The pass runs on
// every idle and costs up to `rollupBuildsPerPass` model calls, so unread output is
// not a cosmetic gap — it is spend with no consumer.
//
// lcm-x serves the same data through its `lcm_recent` tool. `lcm_timeline` is that
// read path, and these tests are the contract of the thing that reads it.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { appendRollup, buildRollupRecord, planDayRollups } from "../src/rollup.js";
import { defineTimelineTool, resolveConfig } from "../src/tool.js";

const DAY = 86400000;
const T0 = Date.parse("2026-11-13T10:00:00Z");

function checkpoint(seq, time, text) {
  return { type: "compaction/summary", seq, time, data: { summary: [{ type: "text", text }] } };
}

/** Seed a session's sidecar with the given days, each built from one checkpoint. */
async function seeded(days) {
  const dir = await mkdtemp(path.join(tmpdir(), "lcm-timeline-"));
  for (const [index, day] of days.entries()) {
    const events = [checkpoint(index + 1, T0 + index * DAY, "## work")];
    const planned = planDayRollups(events);
    appendRollup(dir, "s", buildRollupRecord(planned[0], "(seq " + (index + 1) + ") did day " + day));
  }
  return dir;
}

const AGENT = { session: { id: "s" }, options: {} };

test("an empty store says so instead of returning nothing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lcm-timeline-empty-"));
  try {
    const tool = defineTimelineTool(resolveConfig({ rollupDir: dir }));
    const out = await tool.execute({}, { agent: AGENT });
    assert.match(out.text, /no timeline/u, "the reader must explain the absence, not return an empty string");
    assert.equal(out.available, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("by default it returns the most recent days, newest first", async () => {
  const dir = await seeded(["2026-11-13", "2026-11-14", "2026-11-15"]);
  try {
    const tool = defineTimelineTool(resolveConfig({ rollupDir: dir }));
    const out = await tool.execute({}, { agent: AGENT });
    assert.equal(out.returned, 3, "three days fit the default limit");
    assert.deepEqual(out.days, ["2026-11-15", "2026-11-14", "2026-11-13"], "newest first");
    assert.match(out.text, /did day 2026-11-15/u, "and the body travels with it");
    assert.equal(out.available, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("limit bounds the answer without hiding how much exists", async () => {
  const dir = await seeded(["2026-11-13", "2026-11-14", "2026-11-15"]);
  try {
    const tool = defineTimelineTool(resolveConfig({ rollupDir: dir }));
    const out = await tool.execute({ limit: 1 }, { agent: AGENT });
    assert.equal(out.returned, 1);
    assert.deepEqual(out.days, ["2026-11-15"]);
    assert.equal(out.available, 3, "the caller still learns there are more");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("period selects one day, and an unknown day lists what is available", async () => {
  const dir = await seeded(["2026-11-13", "2026-11-14"]);
  try {
    const tool = defineTimelineTool(resolveConfig({ rollupDir: dir }));
    const one = await tool.execute({ period: "2026-11-13" }, { agent: AGENT });
    assert.deepEqual(one.days, ["2026-11-13"]);
    assert.match(one.text, /did day 2026-11-13/u);
    assert.doesNotMatch(one.text, /2026-11-14/u, "only the requested day");

    const missing = await tool.execute({ period: "2020-01-01" }, { agent: AGENT });
    assert.equal(missing.returned, 0);
    assert.match(missing.text, /Available: .*2026-11-13/u, "and it names the days that do exist");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("period: list returns the index without the bodies", async () => {
  const dir = await seeded(["2026-11-13", "2026-11-14"]);
  try {
    const tool = defineTimelineTool(resolveConfig({ rollupDir: dir }));
    const out = await tool.execute({ period: "list" }, { agent: AGENT });
    assert.deepEqual(out.days, ["2026-11-13", "2026-11-14"]);
    assert.doesNotMatch(out.text, /did day/u, "the index is an index");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("without a session the tool refuses instead of reading a directory", async () => {
  const tool = defineTimelineTool(resolveConfig({}));
  await assert.rejects(
    tool.execute({}, { agent: undefined }),
    (error) => error.code === "TIMELINE_AGENT_REQUIRED"
  );
});
