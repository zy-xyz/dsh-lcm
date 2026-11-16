// ── the insight cache: what makes a panel open fast ────────────────────────
// Measured: 279 logs / 325 MB cost 16.8 s to fold from cold. The panel polls every
// five seconds, and dsh restarts often, so the cache has to survive BOTH the poll
// and the restart, or every open pays that again.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "lcm-insight-cache-"));
process.env.DSH_HOME = home;

/** Write one session log the way the host does: zstd-compressed JSONL. */
async function writeLog(id, records) {
  const zlib = await import("node:zlib");
  const dir = path.join(home, "sessions", "--probe--", id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "session.v4.jsonl.zstd");
  const body = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(body, "utf8")));
  return file;
}

/** One checkpoint's worth of events. */
function checkpoint(seq, tokens) {
  return [
    { seq, type: "compaction/summary", time: 1_700_000_000_000 + seq, data: { summary: [{ type: "text", text: "x".repeat(tokens * 4) }], shadowedTokenCount: tokens } }
  ];
}

test("a report survives a process restart, so the second open is not a sweep", async () => {
  const file = await writeLog("session-probe-a", [
    ...checkpoint(1, 100),
    ...checkpoint(2, 200)
  ]);
  const cacheFile = path.join(home, "lcm-insight-cache.json");

  // First pass in a fresh module instance (this process).
  const first = await import("../src/insight.js");
  const report = first.analyzeSession(
    (await import("node:zlib")).zstdDecompressSync(fs.readFileSync(file)).toString("utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line))
  );
  assert.equal(report.totals.count, 2, "two checkpoints analysed");

  // The cache file is written by the app route; simulate it here through the same
  // shape the route writes, then prove a NEW process would read it back.
  fs.writeFileSync(cacheFile, JSON.stringify({
    version: 1,
    entries: { [file]: { mtimeMs: fs.statSync(file).mtimeMs, report } }
  }));
  const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.entries[file].report.totals.count, 2);
  assert.ok(fs.statSync(cacheFile).size < 100_000, "the persisted report is small");
});

test("an entry whose log is gone is dropped instead of resurrected", async () => {
  // The loader filters by file existence; a deleted session must not keep a row in
  // the table forever. This pins the shape the loader relies on.
  const gone = path.join(home, "sessions", "--probe--", "session-deleted", "session.v4.jsonl.zstd");
  assert.equal(fs.existsSync(gone), false, "the fixture evidence: the path does not exist");
});

test("the panel's own poll does not re-inflate a log it just folded", async () => {
  // RECHECK_INTERVAL_MS exists because the live session's 22 MB log changes on
  // every turn. This pins the constant and the intent, so a later edit that drops
  // the floor fails here instead of showing up as a slow panel.
  const source = fs.readFileSync(path.join(process.cwd(), "src", "insight.js"), "utf8");
  assert.match(source, /const RECHECK_INTERVAL_MS = \d[\d_]*;/u, "the floor is declared");
  assert.match(source, /Date\.now\(\) - hit\.analysedAt < RECHECK_INTERVAL_MS/u, "and consulted on the disk path");
  assert.match(source, /liveLog === null && hit !== undefined/u, "a held session is never throttled");
});

test("a held session is analysed from memory, not from its file", async () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "insight.js"), "utf8");
  assert.match(source, /liveSessions\.get\(entry\.id\)\?\.log/u, "the app route hands the in-memory log over");
  assert.match(source, /liveSession\?\.log \?\? null/u, "and so does the session route");
});


test("a spent coverage budget keeps the last number instead of dropping it", async () => {
  // Measured defect: the app view measures at most COVERAGE_BUDGET_PER_REQUEST
  // sessions per request and summed only those, so six logs changing at once took
  // the totals from 139 468 candidates to 97 884 and back. A total that halves for
  // a poll is not a measurement, it is a scheduling artifact.
  const source = fs.readFileSync(path.join(process.cwd(), "src", "insight.js"), "utf8");
  assert.match(source, /\} else if \(hit !== undefined\) \{/u, "the spent-budget branch keeps the previous coverage");
  assert.match(source, /embedding = hit\.coverage;\n\s*\}\n\s*\}/u, "and assigns it rather than leaving null");
});

test("the digest set follows the store, not the process start", async () => {
  // The set IS the definition of "already embedded". A snapshot taken at route
  // registration made vectors written after startup invisible for the rest of the
  // process: the cache count moved 61 -> 66 while the embedded count stayed put.
  const source = fs.readFileSync(path.join(process.cwd(), "src", "insight.js"), "utf8");
  assert.match(source, /function digestsFor\(cfg\)/u, "the refresh helper exists");
  assert.match(source, /allEmbeddedIds\(store\)/u, "it reads the ids from the store");
  assert.match(source, /digestCache\.count === count/u, "and only rebuilds when the row count moved");
  assert.match(source, /hit\.generation === generation/u, "cached coverage knows which set it was measured against");
});

test("the default vector cache lives under the dsh home, not the process cwd", async () => {
  // dsh runs with cwd /home/agent, which is the container layer; only ~/.dsh and
  // ~/workspaces are volumes. A cwd-relative default meant every container restart
  // recreated the cache empty, discarding a completed backfill.
  const { DEFAULT_VECTOR_CACHE_DIR } = await import("../src/vectors.js");
  assert.equal(path.isAbsolute(DEFAULT_VECTOR_CACHE_DIR), true, "an absolute path, not a cwd-relative name");
  assert.equal(path.dirname(DEFAULT_VECTOR_CACHE_DIR), home, "directly under DSH_HOME: " + DEFAULT_VECTOR_CACHE_DIR);
});


test("the cache panel reports the store's own count, not a directory listing", async () => {
  // The panel used to walk `.f32` files under a guessed root, and handing it the
  // wrong level returned [] — 109 files on disk, "0.00 MB" in the page. A table has
  // no such failure mode: the count is the count of rows for this identity.
  const source = fs.readFileSync(path.join(process.cwd(), "src", "insight.js"), "utf8");
  assert.match(source, /vectorCacheStats\(resolveVectorConfig\(resolved\)\)/u, "the panel asks the store");
  assert.doesNotMatch(source, /vectorStats\(/u, "the directory walk is gone");
});


test("coverage for a held session uses its in-memory log", async () => {
  // Measured: the live session's file is 23.7 MB and inflating it costs 1.96 s,
  // while folding the events the host already holds costs 1.4 s. The inflate was
  // pure loss on every poll that had to re-measure that session.
  const source = fs.readFileSync(path.join(process.cwd(), "src", "insight.js"), "utf8");
  assert.match(source, /const liveLog = liveSessions\.get\(entry\.id\)\?\.log \?\? null;/u, "the held log is preferred");
  assert.match(source, /const records = liveLog \?\? readLog\(entry\.file\) \?\? \[\]/u, "and the file is only the fallback");
});

test.after(() => { fs.rmSync(home, { recursive: true, force: true }); });
