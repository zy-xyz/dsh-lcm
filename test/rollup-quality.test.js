// ── the first real rollup run, and what it exposed ─────────────────────────
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendRollup, buildRollupInstruction, buildRollupRecord, isChronology, pendingRollups, planDayRollups, readRollups
} from "../src/rollup.js";

const DAY = 86400000;
const T0 = Date.parse("2026-11-13T10:00:00Z");

function checkpoint(seq, time, text) {
  return { type: "compaction/summary", seq, time, data: { summary: [{ type: "text", text }] } };
}

test("a body that talks about the task is not a chronology", () => {
  // The measured failure. A 3 070-token day came back as one sentence of preamble,
  // and the store accepted it because the only check was "non-empty".
  assert.equal(isChronology("I'll start by locating the checkpoint bodies."), false,
    "the exact body that shipped as a 14-token rollup");
  assert.equal(isChronology(""), false);
  assert.equal(isChronology("   \n  "), false, "whitespace is not a chronology");
  assert.equal(isChronology("Here is the timeline:\n\n(seq 1) did a thing"), false,
    "one shaped line under a prose heading is still prose");
});

test("a chronology is lines that start with (seq N)", () => {
  assert.equal(isChronology("(seq 1) did a thing"), true, "one line is enough");
  assert.equal(isChronology("(seq 1) did a thing\n(seq 2) did another"), true);
  assert.equal(isChronology("(seq 1) did a thing\n\n(seq 2) did another\n"), true,
    "blank lines are presentation, not content");
  assert.equal(isChronology("(seq 0) nothing durable"), true,
    "the documented empty answer is a valid chronology");
});

test("rewriting a period replaces its body instead of appending a dead copy", async () => {
  // Measured: 2026-11-08 was written at 17:16:45 with 1 330 tokens and again at
  // 17:17:24 with 2 652. Both stayed in the file; readRollups kept the last, so the
  // superseded body was dead weight nobody would ever see.
  const dir = await mkdtemp(path.join(tmpdir(), "lcm-rollup-replace-"));
  try {
    const planned = planDayRollups([checkpoint(10, T0, "a".repeat(400))]);
    appendRollup(dir, "s", buildRollupRecord(planned[0], "(seq 10) first body"));
    appendRollup(dir, "s", buildRollupRecord(planned[0], "(seq 10) second body"));

    const raw = (await readFile(path.join(dir, "s.jsonl"), "utf8")).split("\n").filter(Boolean);
    assert.equal(raw.length, 1, "one line on disk, not two");
    assert.match(raw[0], /second body/u, "and it is the newer one");
    assert.equal(readRollups(dir, "s").length, 1, "the reader agrees");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rewriting one period leaves the other periods alone", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lcm-rollup-keep-"));
  try {
    const planned = planDayRollups([
      checkpoint(10, T0, "a".repeat(400)),
      checkpoint(11, T0 + DAY, "b".repeat(400))
    ]);
    appendRollup(dir, "s", buildRollupRecord(planned[0], "(seq 10) day one"));
    appendRollup(dir, "s", buildRollupRecord(planned[1], "(seq 11) day two"));
    appendRollup(dir, "s", buildRollupRecord(planned[0], "(seq 10) day one again"));

    const lines = (await readFile(path.join(dir, "s.jsonl"), "utf8")).split("\n").filter(Boolean);
    assert.equal(lines.length, 2, "still one record per period");
    const stored = readRollups(dir, "s");
    assert.equal(stored.length, 2);
    assert.match(stored.find((r) => r.periodStart === "2026-11-13").text, /again/u);
    assert.match(stored.find((r) => r.periodStart === "2026-11-14").text, /day two/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a rejected body leaves the day pending, so the next idle retries it", async () => {
  // Rejection must not mark the day done: `pendingRollups` decides from the
  // fingerprint, so an unwritten day stays owed and is retried.
  const dir = await mkdtemp(path.join(tmpdir(), "lcm-rollup-retry-"));
  try {
    const planned = planDayRollups([checkpoint(10, T0, "a".repeat(400))]);
    assert.equal(pendingRollups(planned, readRollups(dir, "s")).length, 1, "starts pending");
    // A rejected answer writes nothing at all.
    assert.equal(pendingRollups(planned, readRollups(dir, "s")).length, 1, "still pending after a rejection");
    appendRollup(dir, "s", buildRollupRecord(planned[0], "(seq 10) accepted"));
    assert.equal(pendingRollups(planned, readRollups(dir, "s")).length, 0, "cleared once written");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the instruction constrains the output shape, not just the content", () => {
  const text = buildRollupInstruction("2026-11-07", 5000);
  assert.match(text, /\(seq N\)/u, "shows the line shape");
  assert.match(text, /first character/u, "states the opening-character rule");
  assert.match(text, /about 5000 tokens/u, "carries the budget");
});
