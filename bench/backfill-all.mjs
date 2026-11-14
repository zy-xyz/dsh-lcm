// Full corpus backfill across every session, using the on-disk 0.35.0 code
// (batch 32, 240 s ceiling, concurrency 1). Writes progress to a log so the
// operator can watch, and re-reads the cache each pass so restarts are free.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { embedBackfill } from "/home/agent/workspaces/lcmx-study/dsh-lcm/src/command.js";
import { resolveConfig } from "/home/agent/workspaces/lcmx-study/dsh-lcm/src/tool.js";
import { batchSizeFor, resolveVectorConfig, vectorCacheDirOf } from "/home/agent/workspaces/lcmx-study/dsh-lcm/src/vectors.js";

const cfg = resolveConfig({
  vectorEnabled: true,
  vectorModel: "mistral-proxy/codestral-embed",
  vectorDim: 1536,
  vectorBaseUrl: "http://10.126.126.4:20128/v1",
  vectorApiKeyEnv: "OMNIROUTE_API_KEY",
  vectorCacheDir: "/home/agent/.lcm-vectors",
  vectorTimeoutMs: 240000
});
const rv = resolveVectorConfig(cfg);
const batch = batchSizeFor(rv);
const cacheDir = vectorCacheDirOf(rv);
const countCache = () => { try { return fs.readdirSync(cacheDir).filter((n) => n.endsWith(".f32")).length; } catch { return 0; } };

const log = (line) => {
  const stamp = new Date().toISOString().slice(11, 19);
  const text = `[${stamp}] ${line}`;
  console.log(text);
  fs.appendFileSync("/tmp/lcm-backfill.log", text + "\n");
};

const root = "/home/agent/.dsh/sessions";
const sessions = [];
for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
  if (!ws.isDirectory()) continue;
  for (const s of fs.readdirSync(path.join(root, ws.name), { withFileTypes: true })) {
    if (!s.isDirectory()) continue;
    const f = path.join(root, ws.name, s.name, "session.v4.jsonl.zstd");
    if (fs.existsSync(f)) sessions.push({ id: s.name, f, m: fs.statSync(f).mtimeMs });
  }
}
sessions.sort((a, b) => b.m - a.m);

log(`start: ${sessions.length} sessions, batch ${batch}, cache ${countCache()}`);
let done = 0;
let totalEmbedded = 0;
let totalFailed = 0;

for (const entry of sessions) {
  done += 1;
  let ev;
  try {
    ev = zlib.zstdDecompressSync(fs.readFileSync(entry.f)).toString("utf8")
      .split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean).filter((e) => Number.isSafeInteger(e.seq));
  } catch { continue; }
  const session = {
    id: entry.id,
    snapshotEvents: () => ev,
    get seq() { return ev.length; },
    eventAt: (s) => ev.find((e) => e.seq === s),
    deriveEventMessage: (e) => e?.data?.message ?? null
  };
  try {
    // 512 per pass: bounded so a single stuck session cannot hold the whole run,
    // and re-invoked until its remaining count stops moving.
    for (let round = 0; round < 200; round += 1) {
      const { report } = await embedBackfill(session, cfg, { apply: true, limit: 512 });
      totalEmbedded += report.embedded;
      totalFailed += report.failed;
      if (report.embedded === 0 && report.failed === 0) break;
      if (report.stopped !== "") { log(`  ${entry.id.slice(8, 20)} stopped: ${report.stopped}`); break; }
      if (report.remaining === 0) break;
    }
  } catch (error) {
    log(`  ${entry.id.slice(8, 20)} error: ${error.message}`);
  }
  if (done % 10 === 0) log(`progress ${done}/${sessions.length} | embedded ${totalEmbedded} | failed ${totalFailed} | cache ${countCache()}`);
}

log(`DONE: embedded ${totalEmbedded}, failed ${totalFailed}, cache ${countCache()}`);