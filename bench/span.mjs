#!/usr/bin/env node
// bench/span.mjs — extract one real compaction span from a dsh session log for A/B.
//
// Outputs JSON on stdout: { span, text, tokensEstimate, canaries }
// Renders the conversation the way a summarizer would see it: role + text,
// tool calls as one line, tool results head/tail excerpted.
//
// Usage:
//   node bench/span.mjs <session.jsonl.zstd> [--max-tokens 8000]
//   node bench/span.mjs <session.jsonl.zstd> --last 60      # last N surface nodes
//   node bench/span.mjs <session.jsonl.zstd> --range 100-180
//
// Default source is the richest production compaction (the exact span a
// summarizer was asked about). --last/--range let any session act as corpus,
// so the A/B is not limited to the two sessions that happen to have compacted.

import fs from "node:fs";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const file = args[0];
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? (args[i + 1] ?? true) : d; };
const maxTokens = Number(opt("max-tokens", 40000));

function load(f) {
  const buf = fs.readFileSync(f);
  const text = f.endsWith(".zstd") ? zlib.zstdDecompressSync(buf).toString("utf8") : buf.toString("utf8");
  return text.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

const events = load(file);
const bySeq = new Map(events.map((e) => [e.seq, e]));

// Choose the span: explicit range > last-N surface nodes > richest compaction.
const rangeArg = opt("range", null);
const lastArg = opt("last", null);
let seqs;
let source;

if (typeof rangeArg === "string" && rangeArg.includes("-")) {
  const [a, b] = rangeArg.split("-").map(Number);
  seqs = events.map((e) => e.seq).filter((s) => s >= a && s <= b);
  source = `range ${rangeArg}`;
} else if (lastArg !== null) {
  const n = Number(lastArg);
  const surfaceSeqs = events.map((e) => e.seq);
  seqs = surfaceSeqs.slice(-Math.max(2, n));
  source = `last ${n} nodes`;
} else {
  // The richest compaction: exactly the span a summarizer was asked about.
  let best = null;
  for (const e of events) {
    if (e.type !== "compaction/summary") continue;
    const n = (e.data?.shadowedSeqs ?? []).length;
    if (best === null || n > best.n) best = { n, event: e };
  }
  if (best === null) {
    console.error("no compaction/summary in this log — pass --last N or --range A-B");
    process.exit(2);
  }
  seqs = best.event.data.shadowedSeqs;
  source = `compaction ${best.event.data.compactionId}`;
}

// Trim from the oldest end until we fit the token budget (keep the most recent
// context, which is what matters for the next step).
const estimate = (t) => Math.ceil(t.length / 4);
const render = (seq) => {
  const e = bySeq.get(seq);
  if (!e) return null;
  const d = e.data ?? {};
  if (e.type === "user/message") {
    const text = (d.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return text ? `USER:\n${text}` : null;
  }
  if (e.type === "assistant/message" || e.type === "tool/result") {
    const m = d.message ?? d;
    const parts = [];
    for (const b of m.content ?? []) {
      if (b.type === "text" && b.text) parts.push(b.text);
      else if (b.type === "tool-call") parts.push(`[tool-call ${b.name}] ${String(b.arguments ?? "").slice(0, 400)}`);
      else if (b.type === "image") parts.push("[image]");
    }
    if (parts.length === 0) return null;
    const role = e.type === "tool/result" ? "TOOL RESULT" : "ASSISTANT";
    return `${role}:\n${parts.join("\n")}`;
  }
  if (e.type === "tool/call") return `[tool-call ${d.name}] ${String(d.arguments ?? "").slice(0, 400)}`;
  return null;
};

const rendered = [];
for (let i = seqs.length - 1; i >= 0; i -= 1) {
  const r = render(seqs[i]);
  if (r) rendered.unshift(r);
  if (estimate(rendered.join("\n\n")) > maxTokens) break;
}
const text = rendered.join("\n\n");

// Anchors come from the audited extractor: nesting removed, types balanced,
// repeated dumps collapsed. See bench/anchors.mjs for why this matters.
const { buildAnchorSet } = await import("./anchors.mjs");
const anchorSet = buildAnchorSet(text);


console.log(JSON.stringify({
  source: file,
  spanSource: source,
  spanNodes: seqs.length,
  renderedNodes: rendered.length,
  chars: text.length,
  tokensEstimate: estimate(text),
  canariesTotal: anchorSet.anchors.length,
  canaryPool: anchorSet.poolSize,
  droppedNested: anchorSet.droppedNested,
  canaryTypes: anchorSet.typeCounts,
  canaries: anchorSet.anchors.map((a) => a.value),
  text
}, null, 0));
