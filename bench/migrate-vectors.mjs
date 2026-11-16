// Migrate the file cache into the SQLite store.
//
// The old key was sha256(model + "\n" + text), so the filename alone cannot be
// re-keyed: the TEXT is not recoverable from it. The migration therefore walks the
// session logs (the only place the texts exist), recomputes each candidate's old
// filename, and if that file exists, reads the vector and writes it under the new
// (embedded_id, identity_hash) row.
process.env.DSH_HOME = "/home/agent/.dsh";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { collectVectorItems } from "/home/agent/workspaces/lcmx-study/dsh-lcm/src/search.js";
import { resolveConfig } from "/home/agent/workspaces/lcmx-study/dsh-lcm/src/tool.js";
import { resolveVectorConfig, vectorCacheDirOf } from "/home/agent/workspaces/lcmx-study/dsh-lcm/src/vectors.js";
import { openVectorStore, writeVector } from "/home/agent/workspaces/lcmx-study/dsh-lcm/src/vector-store.js";

const cfg = resolveConfig({
  vectorEnabled: true,
  vectorModel: "mistral-proxy/codestral-embed",
  vectorDim: 1536,
  vectorBaseUrl: "http://10.126.126.4:20128/v1",
  vectorApiKeyEnv: "OMNIROUTE_API_KEY",
  vectorCacheDir: "/home/agent/.dsh/.lcm-vectors"
});
const rv = resolveVectorConfig(cfg);
const legacyDir = vectorCacheDirOf(rv);   // ~/.dsh/.lcm-vectors/<tag>-1536
const store = openVectorStore(rv);

const oldKeyOf = (text) => createHash("sha256").update(rv.model + "\n" + text, "utf8").digest("hex");
const readLegacy = (text) => {
  try {
    const bytes = fs.readFileSync(path.join(legacyDir, oldKeyOf(text) + ".f32"));
    if (bytes.byteLength !== rv.dim * 4) return null;
    const out = new Float32Array(rv.dim);
    for (let i = 0; i < rv.dim; i += 1) out[i] = bytes.readFloatLE(i * 4);
    return out;
  } catch { return null; }
};

let legacyFiles = 0;
try { legacyFiles = fs.readdirSync(legacyDir).filter((n) => n.endsWith(".f32")).length; } catch {}
console.log("legacy files:", legacyFiles);

const root = "/home/agent/.dsh/sessions";
const sessions = [];
for (const w of fs.readdirSync(root, { withFileTypes: true })) {
  if (!w.isDirectory()) continue;
  for (const s of fs.readdirSync(path.join(root, w.name), { withFileTypes: true })) {
    if (!s.isDirectory()) continue;
    const f = path.join(root, w.name, s.name, "session.v4.jsonl.zstd");
    try { sessions.push({ f, m: fs.statSync(f).mtimeMs }); } catch {}
  }
}
sessions.sort((a, b) => b.m - a.m);

let migrated = 0, missing = 0, scanned = 0, texts = 0;
for (const entry of sessions) {
  let ev;
  try {
    ev = zlib.zstdDecompressSync(fs.readFileSync(entry.f)).toString("utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((x) => x && Number.isSafeInteger(x.seq));
  } catch { continue; }
  const session = { id: "m", snapshotEvents: () => ev, get seq() { return ev.length; }, eventAt: () => undefined, deriveEventMessage: (x) => x?.data?.message ?? null };
  let items;
  try { items = collectVectorItems(session, { events: Number.MAX_SAFE_INTEGER, tokens: Number.MAX_SAFE_INTEGER }).items ?? []; } catch { continue; }
  scanned += 1;
  for (const item of items) {
    const text = String(item.text ?? "").slice(0, 4000);
    if (!text.trim()) continue;
    texts += 1;
    const vector = readLegacy(text);
    if (vector === null) { missing += 1; continue; }
    writeVector(store, text, vector);
    migrated += 1;
  }
  if (scanned % 40 === 0) console.log("  " + scanned + "/" + sessions.length + " sessions | migrated " + migrated);
}
console.log("DONE: sessions " + scanned + " | texts " + texts + " | migrated " + migrated + " | still missing " + missing);
store.db.close();
