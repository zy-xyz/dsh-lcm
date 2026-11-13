// ── assertion extraction (lcm-x `assertion_extraction_enabled`, off) ──
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendAssertions, assertionKey, markMined, parseAssertions, readAssertions, readMined, searchAssertions, unminedCheckpoints
} from "../src/assertion.js";
import { resolveConfig } from "../src/config.js";

test("a fenced JSON answer is parsed, and an unparseable one yields nothing", () => {
  const fenced = "Here you go:\n```json\n[{\"subject\":\"host\",\"predicate\":\"was flashed to\",\"object\":\"192.168.2.121\"}]\n```";
  const rows = parseAssertions(fenced, 42);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { subject: "host", predicate: "was flashed to", object: "192.168.2.121", seq: 42 }, "seq is stamped from the checkpoint, not the answer");

  assert.deepEqual(parseAssertions("no json here at all", 1), [], "prose yields nothing");
  assert.deepEqual(parseAssertions("[{bad json", 1), [], "malformed yields nothing");
  assert.deepEqual(parseAssertions("[{\"subject\":\"a\",\"predicate\":\"\",\"object\":\"c\"}]", 1), [], "a blank field drops the row");
  assert.deepEqual(parseAssertions("[]", 7), [], "an empty array is a valid empty answer");
});

test("an assertion keys on its triple AND its seq", () => {
  // The same sentence asserted on two days is two claims with two citations.
  // Collapsing them would lose which checkpoint to expand.
  const a = { subject: "s", predicate: "p", object: "o", seq: 1 };
  assert.equal(assertionKey(a), assertionKey({ ...a }), "identical rows key identically");
  assert.notEqual(assertionKey(a), assertionKey({ ...a, seq: 2 }), "a different seq is a different claim");
  assert.notEqual(assertionKey(a), assertionKey({ ...a, object: "other" }), "a different object is a different claim");
});

test("rows and the mined ledger are separate, so an empty extraction leaves no fake fact", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lcm-assert-"));
  try {
    appendAssertions(dir, "s1", [{ subject: "host", predicate: "runs", object: "fnos", seq: 5 }]);
    // A checkpoint that yielded nothing: recorded in the ledger, NOT as a row.
    markMined(dir, "s1", 6, 0);
    markMined(dir, "s1", 5, 1);

    const rows = readAssertions(dir, "s1");
    assert.equal(rows.length, 1, "the empty extraction added no row");
    assert.deepEqual(readMined(dir, "s1"), new Set([5, 6]), "but both seqs are marked mined");

    const events = [
      { type: "compaction/summary", seq: 5, time: 2 },
      { type: "compaction/summary", seq: 6, time: 1 },
      { type: "compaction/summary", seq: 7, time: 3 },
      { type: "user/message", seq: 8, time: 4 }
    ];
    const pending = unminedCheckpoints(events, readMined(dir, "s1"));
    assert.deepEqual(pending.map((event) => event.seq), [7], "only the unmined checkpoint, and not the message");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("search matches the whole triple, case-insensitively, newest first", () => {
  const rows = [
    { subject: "192.168.2.121", predicate: "was flashed to", object: "kernel13e", seq: 9 },
    { subject: "trustcache", predicate: "was rebuilt", object: "build/trustcache-dyld.bin", seq: 8 },
    { subject: "host", predicate: "runs", object: "fnos", seq: 7 }
  ];
  assert.deepEqual(searchAssertions(rows, "TRUSTCACHE", 10).map((row) => row.seq), [8], "case-insensitive substring");
  assert.deepEqual(searchAssertions(rows, "192.168", 10).map((row) => row.seq), [9], "an IP fragment matches");
  assert.equal(searchAssertions(rows, "", 2).length, 2, "an empty query matches, bounded by the limit");
  assert.equal(searchAssertions(rows, "nothing-here", 10).length, 0);
});

test("assertion extraction ships off with lcm-x's two bounds", () => {
  const config = resolveConfig({});
  assert.equal(config.assertionExtraction, false, "lcm-x assertion_extraction_enabled defaults False");
  assert.equal(config.assertionMaxSourcesPerPass, 4, "lcm-x assertion_extraction_max_sources_per_pass");
  assert.equal(config.assertionTimeoutSeconds, 30, "lcm-x assertion_extraction_timeout_seconds");
});
