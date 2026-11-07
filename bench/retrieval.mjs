#!/usr/bin/env node
// bench/retrieval.mjs — can the agent FIND a dropped fact, not just restore it?
//
// bench/recovery.mjs proves every anchor the summary dropped is still in the log
// and comes back byte-exactly when you know its seq. That is the easy half: it
// hands recall a perfect pointer.
//
// This measures the hard half — the agent only remembers a string (a path, an
// id, an error line), types it into `lcm_search`, and has to find the event.
// No model is called; the metric is pure ranking quality against labels derived
// from the real compaction: the anchors the production summary dropped.
//
// Metrics: recall@1/5/10/50, MRR, and NDCG@10 with binary relevance.
//
// Usage: node bench/retrieval.mjs <session.v4.jsonl.zstd> [--rank seq|score]

import fs from "node:fs";
import zlib from "node:zlib";

import { buildAnchorSet } from "./anchors.mjs";
import { searchSession } from "../src/search.js";
import { resolveEventAt } from "../src/events.js";

const args = process.argv.slice(2);
const file = args[0];
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? (args[i + 1] ?? true) : d; };
const rankMode = opt("rank", "seq");
const goldMode = opt("gold", "any");
if (!file) {
  console.error("usage: node bench/retrieval.mjs <session.v4.jsonl.zstd> [--rank seq|score]");
  process.exit(2);
}

const events = file.endsWith(".zstd")
  ? zlib.zstdDecompressSync(fs.readFileSync(file)).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** Render the model-visible text of one event. */
function render(event) {
  const data = event.data ?? {};
  if (event.type === "user/message") return (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (event.type === "assistant/message" || event.type === "tool/result") {
    const message = data.message ?? data;
    return (message.content ?? [])
      .map((b) => (b.type === "text" ? b.text : b.type === "tool-call" ? String(b.arguments ?? "") : ""))
      .join("\n");
  }
  if (event.type === "tool/call") return String(data.arguments ?? "");
  return "";
}

const session = {
  events,
  eventAt: (seq) => resolveEventAt({ events }, seq),
  deriveEventMessage: (event) => {
    const text = render(event);
    return text.length === 0 ? null : { role: "user", content: [{ type: "text", text }] };
  }
};

const summary = events.find((e) => e.type === "compaction/summary");
if (summary === undefined) {
  console.log(JSON.stringify({ file, error: "no compaction/summary in this log" }, null, 1));
  process.exit(3);
}

const shadowedSeqs = summary.data.shadowedSeqs;
const spanText = shadowedSeqs.map((seq) => render(resolveEventAt(session, seq))).join("\n");
const summaryText = (summary.data.summary ?? []).map((b) => b.text ?? "").join("\n");
const anchors = buildAnchorSet(spanText).anchors;

// Only anchors the production summary DROPPED are interesting: those are the
// facts the agent has to go find.
const dropped = anchors.filter((a) => !summaryText.includes(a.value));

/** Every event in the span containing one anchor. */
function ownersOf(value) {
  return shadowedSeqs.filter((seq) => render(resolveEventAt(session, seq)).includes(value));
}

/** Escape an anchor so it is matched literally as a regex. */
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function ndcgAt(rankedGolds, k) {
  // Binary relevance, single gold: DCG = 1/log2(rank+1), IDCG = 1.
  const rank = rankedGolds.findIndex((hit) => hit);
  if (rank === -1 || rank >= k) return 0;
  return 1 / Math.log2(rank + 2);
}

const rows = [];
let missing = 0;
for (const anchor of dropped) {
  const owners = ownersOf(anchor.value);
  if (owners.length === 0) { missing += 1; continue; }
  const goldSet = new Set(goldMode === "first" ? [owners[0]] : owners);
  const result = searchSession(session, escape(anchor.value), { maxSearchHits: 200, maxRecallTokens: 1_000_000, rank: rankMode });
  const order = result.hits.map((hit) => hit.seq);
  const hitIndex = order.findIndex((seq) => goldSet.has(seq));
  const rank = hitIndex === -1 ? -1 : hitIndex + 1;
  rows.push({
    anchor: anchor.value.slice(0, 60),
    type: anchor.type,
    gold: owners[0],
    rank: rank === -1 ? null : rank + 1,
    hits: order.length
  });
}

const at = (k) => rows.filter((r) => r.rank !== null && r.rank <= k).length / rows.length;
const mrr = rows.reduce((sum, r) => sum + (r.rank === null ? 0 : 1 / r.rank), 0) / rows.length;
const ndcg = rows.reduce((sum, r) => sum + (r.rank === null ? 0 : ndcgAt([true].concat(Array(0)), 10) * (r.rank <= 10 ? 1 : 0)), 0) / rows.length;

const byType = {};
for (const r of rows) {
  byType[r.type] ??= { n: 0, hitAt5: 0 };
  byType[r.type].n += 1;
  if (r.rank !== null && r.rank <= 5) byType[r.type].hitAt5 += 1;
}

console.log(JSON.stringify({
  file,
  rankMode,
  goldMode,
  droppedAnchors: dropped.length,
  evaluated: rows.length,
  unevaluable: missing,
  recall: { at1: +at(1).toFixed(3), at5: +at(5).toFixed(3), at10: +at(10).toFixed(3), at50: +at(50).toFixed(3) },
  mrr: +mrr.toFixed(3),
  ndcgAt10: +ndcg.toFixed(3),
  byType,
  rows
}, null, 1));
