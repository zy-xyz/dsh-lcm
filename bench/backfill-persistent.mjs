// Full corpus backfill across every session log, writing into the PERSISTENT
// cache (~/.dsh/.lcm-vectors). Re-reads the cache each pass, so a restart or a
// killed run resumes instead of starting over.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { embedBackfill } from "/home/agent/workspaces/lcmx-study/dsh-lcm/src/command.js";
import { resolveConfig } from "/home/agent/workspaces/lcmx-study/dsh-lcm/src/tool.js";
import { batchSizeFor, resolveVectorConfig, vectorCacheDirOf } from "/home/agent/workspaces/lcmx-study/dsh-lcm/src/vectors.js";

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
const batch = batchSizeFor(rv);
const cacheDir = vectorCacheDirOf(rv);
const countCache = () => { try { return fs.readdirSync(cacheDir).filter((n) => n.endsWith(".f32")).length; } catch { return 0; } };

const LOG = "/tmp/lcm-backfill.log";
const log = (line) => {
  const text = "[" + new Date().toISOString().slice(11, 19) + "] " + line;
  console.log(text);
  fs.appendFileSync(LOG, text + "\n");
};

const root = "/home/agent/.dsh/sessions";
const sessions = [];
for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
  if (!ws.isDirectory()) continue;
  for (const s of fs.readdirSync(path.join(root, ws.name), { withFileTypes: true })) {
    if (!s.isDirectory()) continue;
    const f = path.join(root, ws.name, s.name, "session.v4.jsonl.zstd");
    try { sessions.push({ id: s.name, f, m: fs.statSync(f).mtimeMs, size: fs.statSync(f).size }); } catch {}
  }
}
sessions.sort((a, b) => b.m - a.m);

log("start: " + sessions.length + " sessions | batch " + batch + " | concurrency " + rv.concurrency + " | cache " + countCache() + " files");
log("cache dir: " + cacheDir);

let done = 0;
let totalEmbedded = 0;
let totalFailed = 0;
const t0 = Date.now();

for (const entry of sessions) {
  done += 1;
  let ev;
  try {
    ev = zlib.zstdDecompressSync(fs.readFileSync(entry.f)).toString("utf8")
      .split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && Number.isSafeInteger(e.seq));
  } catch { continue; }
  const session = {
    id: entry.id,
    snapshotEvents: () => ev,
    get seq() { return ev.length; },
    eventAt: (s) => ev.find((e) => e.seq === s),
    deriveEventMessage: (e) => e?.data?.message ?? null
  };
  try {
    for (let round = 0; round < 500; round += 1) {
      const { report } = await embedBackfill(session, cfg, { apply: true, limit: 1024, scope: "corpus" });
      totalEmbedded += report.embedded;
      totalFailed += report.failed;
      if (report.failed > 0 && report.embedded === 0) { log("  " + entry.id.slice(8, 20) + " stopped: " + report.stopped); break; }
      if (report.remaining === 0) break;
    }
  } catch (error) {
    log("  " + entry.id.slice(8, 20) + " error: " + String(error.message).slice(0, 90));
  }
  if (done % 10 === 0) {
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    log("progress " + done + "/" + sessions.length + " | embedded " + totalEmbedded + " | failed " + totalFailed + " | cache " + countCache() + " | " + mins + "min");
  }
}

const mins = ((Date.now() - t0) / 60000).toFixed(1);
log("DONE: embedded " + totalEmbedded + ", failed " + totalFailed + ", cache " + countCache() + " files in " + mins + "min");
