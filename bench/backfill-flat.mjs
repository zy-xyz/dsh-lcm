// Full corpus backfill, FLAT: every pending text from every session goes into one
// queue, so the worker pool is never starved by a session that has fewer groups
// than there are workers.
//
// Measured why this shape matters. Per-session passes left 8 of 19 workers idle:
// 187 of 203 sessions with pending work produced fewer than 19 request groups, and
// the driver waited for one session to drain before opening the next. 25 minutes
// produced 668 vectors, i.e. 75 hours for the remaining 122 308.
//
// The cache is content-addressed, so the queue can be built once up front and
// re-run freely: anything already on disk is skipped when the queue is built.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { resolveConfig } from "/home/agent/workspaces/lcmx-study/dsh-lcm/src/tool.js";
import { groupIntoRequests, resolveVectorConfig, vectorCacheDirOf, embedTextsTolerant } from "/home/agent/workspaces/lcmx-study/dsh-lcm/src/vectors.js";
import { collectVectorItems } from "/home/agent/workspaces/lcmx-study/dsh-lcm/src/search.js";

process.env.DSH_HOME = "/home/agent/.dsh";
const cfg = resolveConfig({
  vectorEnabled: true,
  vectorModel: "mistral-proxy/codestral-embed",
  vectorDim: 1536,
  vectorBaseUrl: "http://10.126.126.4:20128/v1",
  vectorApiKeyEnv: "OMNIROUTE_API_KEY",
  vectorCacheDir: "/home/agent/.dsh/.lcm-vectors",
  vectorTimeoutMs: 240000,
  vectorConcurrency: 19
});
const rv = resolveVectorConfig(cfg);
const cacheDir = vectorCacheDirOf(rv);
const countCache = () => { try { return fs.readdirSync(cacheDir).filter((n) => n.endsWith(".f32")).length; } catch { return 0; } };

const LOG = "/tmp/lcm-backfill.log";
const log = (line) => {
  const text = "[" + new Date().toISOString().slice(11, 19) + "] " + line;
  console.log(text);
  fs.appendFileSync(LOG, text + "\n");
};

// ── build one flat queue of texts ────────────────────────────────────────
const root = "/home/agent/.dsh/sessions";
const sessions = [];
for (const w of fs.readdirSync(root, { withFileTypes: true })) {
  if (!w.isDirectory()) continue;
  for (const s of fs.readdirSync(path.join(root, w.name), { withFileTypes: true })) {
    if (!s.isDirectory()) continue;
    const f = path.join(root, w.name, s.name, "session.v4.jsonl.zstd");
    try { sessions.push({ id: s.name, f, m: fs.statSync(f).mtimeMs }); } catch {}
  }
}
sessions.sort((a, b) => b.m - a.m);

const digests = new Set(fs.readdirSync(cacheDir).filter((n) => n.endsWith(".f32")).map((n) => n.slice(0, -4)));
const keyOf = (text) => createHash("sha256").update(rv.model + "\n" + text, "utf8").digest("hex");

const pending = [];
let scannedSessions = 0;
let alreadyCached = 0;
for (const entry of sessions) {
  let ev;
  try {
    ev = zlib.zstdDecompressSync(fs.readFileSync(entry.f)).toString("utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((x) => x && Number.isSafeInteger(x.seq));
  } catch { continue; }
  const session = { id: entry.id, snapshotEvents: () => ev, get seq() { return ev.length; }, eventAt: () => undefined, deriveEventMessage: (x) => x?.data?.message ?? null };
  let items;
  try { items = collectVectorItems(session, { events: Number.MAX_SAFE_INTEGER, tokens: Number.MAX_SAFE_INTEGER }).items ?? []; } catch { continue; }
  scannedSessions += 1;
  for (const item of items) {
    const text = String(item.text ?? "").slice(0, 4000);
    if (!text.trim()) continue;
    if (digests.has(keyOf(text))) { alreadyCached += 1; continue; }
    pending.push(text);
  }
}

// 12 000 tokens per request, not 56 000. The cap is 65 536, but the cap is not the
// binding constraint here: a request also has to finish inside vectorTimeoutMs
// (240 s), and this corridor measured 270 characters/second, so a 56k-token batch
// needs ~740 s and every batch times out. 12 000 tokens is ~3 long CJK texts,
// ~45 s at that speed, with 5x headroom for the jitter (tiny requests measured
// anywhere from 2.8 s to 36 s).
const GROUPS_PER_REQUEST_TOKENS = Number(process.env.LCM_BACKFILL_REQUEST_TOKENS ?? 12_000);
const groups = groupIntoRequests(pending, GROUPS_PER_REQUEST_TOKENS);
log("queue: " + scannedSessions + " sessions | pending " + pending.length + " texts | " + groups.length + " groups | already cached " + alreadyCached);
log("workers " + rv.concurrency + " | " + GROUPS_PER_REQUEST_TOKENS + " tokens/request | cache " + countCache() + " files");

// ── drain the queue with a fixed worker pool ─────────────────────────────
let cursor = 0;
let embedded = 0;
let failed = 0;
let successesSinceFailure = 0;
let consecutiveFailures = 0;
let stopped = "";
const t0 = Date.now();

const worker = async () => {
  for (;;) {
    if (stopped !== "") return;
    const index = cursor;
    cursor += 1;
    if (index >= groups.length) return;
    const batch = groups[index];
    let result;
    try {
      result = await embedTextsTolerant(cfg, batch);
      successesSinceFailure += 1;
      consecutiveFailures = 0;
    } catch (error) {
      failed += batch.length;
      consecutiveFailures += 1;
      // Same rule as the engine: a failure only counts when nothing has succeeded
      // since the previous one, so a live endpoint that drops a batch continues.
      const tripped = successesSinceFailure === 0 && consecutiveFailures >= 2;
      successesSinceFailure = 0;
      if (tripped) { stopped = "failures: " + String(error.message).slice(0, 80); return; }
      continue;
    }
    for (let i = 0; i < batch.length; i += 1) {
      const vector = result.vectors[i];
      if (vector === undefined) { failed += 1; continue; }
      try { fs.writeFileSync(path.join(cacheDir, keyOf(batch[i]) + ".f32"), Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)); embedded += 1; } catch { failed += 1; }
    }
    const done = embedded + failed;
    if (done % 2000 < batch.length) {
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      const rate = (embedded / (mins / 60)).toFixed(0);
      log("progress: embedded " + embedded + " failed " + failed + " of " + pending.length + " | " + mins + "min | " + rate + "/h");
    }
  }
};

await Promise.all(Array.from({ length: Math.max(1, rv.concurrency) }, worker));
const mins = ((Date.now() - t0) / 60000).toFixed(1);
log("DONE: embedded " + embedded + ", failed " + failed + ", cache " + countCache() + " files in " + mins + "min" + (stopped ? " | stopped: " + stopped : ""));
