#!/usr/bin/env node
// bench/span.mjs — extract one real compaction span from a dsh session log for A/B.
//
// Outputs JSON on stdout: { span, text, tokensEstimate, canaries }
// Renders the conversation the way a summarizer would see it: role + text,
// tool calls as one line, tool results head/tail excerpted.
//
// Usage: node bench/span.mjs <session.jsonl.zstd> [--max-tokens 40000] [--tail]

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

// Find the richest compaction and take its shadowed span (that is exactly the
// span a summarizer was asked about in production).
let best = null;
for (const e of events) {
  if (e.type !== "compaction/summary") continue;
  const n = (e.data?.shadowedSeqs ?? []).length;
  if (best === null || n > best.n) best = { n, event: e };
}
if (best === null) {
  console.error("no compaction/summary in this log");
  process.exit(2);
}
const seqs = best.event.data.shadowedSeqs;

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

// Objective canary set: strings the agent would need verbatim later.
// Auto-extracted, never hand-picked, so the test cannot be gamed.
const CANARY_PATTERNS = [
  /\/vol\d+\/[\w.\/-]+/g,          // absolute volume paths
  /\/[\w.-]+\/[\w.-]+\/[\w.\/-]+\.(?:img|sh|py|md|json|yaml|yml|txt|log|db)/g, // file paths
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/g,  // uuids/session ids
  /0x[0-9a-fA-F]{6,}/g,                    // addresses
  /\b[A-Z][A-Z0-9_]{3,}_[A-Z0-9_]{2,}\b/g, // ENV_VARS / CONSTANTS
  /\b(?:error|Error|ERROR|failed|FAILED)[^\n]{8,60}/g
];
const seen = new Set();
const canaries = [];
for (const pattern of CANARY_PATTERNS) {
  for (const match of text.match(pattern) ?? []) {
    const value = match.trim();
    if (value.length < 6 || value.length > 120) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    canaries.push(value);
  }
}
// Deterministic sample, spread across the span so recency bias cannot help.
const step = Math.max(1, Math.floor(canaries.length / 24));
const sample = canaries.filter((_, i) => i % step === 0).slice(0, 24);

console.log(JSON.stringify({
  source: file,
  compactionId: best.event.data.compactionId,
  spanNodes: seqs.length,
  renderedNodes: rendered.length,
  chars: text.length,
  tokensEstimate: estimate(text),
  canariesTotal: canaries.length,
  canaries: sample,
  text
}, null, 0));
