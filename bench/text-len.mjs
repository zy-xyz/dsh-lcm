// How much are we actually losing to the 4 000-char slice?
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { collectVectorItems } from "/home/agent/workspaces/lcmx-study/dsh-lcm/src/search.js";

const root = "/home/agent/.dsh/sessions/--home-agent-workspaces--";
const files = fs.readdirSync(root)
  .map((n) => { const f = path.join(root, n, "session.v4.jsonl.zstd"); return fs.existsSync(f) ? { id: n, f, m: fs.statSync(f).mtimeMs } : null; })
  .filter(Boolean).sort((a, b) => b.m - a.m).slice(0, 5);

let total = 0;
let over = 0;
let lostChars = 0;
const buckets = { "<1k": 0, "1-4k": 0, "4-12k": 0, "12-32k": 0, ">32k": 0 };
for (const entry of files) {
  const ev = zlib.zstdDecompressSync(fs.readFileSync(entry.f)).toString("utf8")
    .split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean).filter((e) => Number.isSafeInteger(e.seq));
  const session = { id: entry.id, snapshotEvents: () => ev, get seq() { return ev.length; }, eventAt: () => undefined, deriveEventMessage: (e) => e?.data?.message ?? null };
  let items = [];
  try { items = collectVectorItems(session, { events: Number.MAX_SAFE_INTEGER, tokens: Number.MAX_SAFE_INTEGER }).items; } catch { continue; }
  for (const item of items) {
    const len = String(item.text ?? "").length;
    if (len === 0) continue;
    total += 1;
    if (len > 4000) { over += 1; lostChars += len - 4000; }
    if (len < 1000) buckets["<1k"] += 1;
    else if (len <= 4000) buckets["1-4k"] += 1;
    else if (len <= 12000) buckets["4-12k"] += 1;
    else if (len <= 32000) buckets["12-32k"] += 1;
    else buckets[">32k"] += 1;
  }
}
console.log("texts:", total);
console.log("over 4000 chars:", over, "(" + (100 * over / Math.max(1, total)).toFixed(1) + "%)");
console.log("chars lost:", lostChars, "->", (100 * lostChars / Math.max(1, lostChars + total * 1200)).toFixed(1) + "% of the corpus text");
console.log("length distribution:");
for (const [k, v] of Object.entries(buckets)) console.log("  " + k.padEnd(8) + String(v).padStart(6) + "  " + (100 * v / Math.max(1, total)).toFixed(1) + "%");