#!/usr/bin/env node
// bench/recovery.mjs — the engine-level question the prompt A/B could not answer.
//
// The prompt A/B measured how many verbatim anchors a *summary* carries. That is
// the only metric a summarizer-only backend can offer, and on that metric this
// backend is not clearly ahead.
//
// The claim that actually distinguishes LCM is recoverability: a checkpoint is a
// view over an append-only log, so an anchor the summary dropped is still
// retrievable byte-for-byte through recall. This script measures that against a
// real session log — the real summary that the engine produced, and the real
// recall implementation shipped in src/recall.js. No model is called.
//
// Usage: node bench/recovery.mjs <session.v4.jsonl.zstd> [> evidence.json]
//
// @module bench/recovery

import fs from "node:fs";
import zlib from "node:zlib";

import { buildAnchorSet } from "./anchors.mjs";
import { recallSession } from "../src/recall.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: node bench/recovery.mjs <session.v4.jsonl.zstd>");
  process.exit(2);
}

function load(path) {
  const buf = fs.readFileSync(path);
  const text = path.endsWith(".zstd") ? zlib.zstdDecompressSync(buf).toString("utf8") : buf.toString("utf8");
  return text.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

const events = load(file);
const bySeq = new Map(events.map((e) => [e.seq, e]));

/** Render the model-visible text of one event, the way the checkpoint saw it. */
function renderEvent(event) {
  const data = event.data ?? {};
  if (event.type === "user/message") {
    return (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }
  if (event.type === "assistant/message" || event.type === "tool/result") {
    const message = data.message ?? data;
    return (message.content ?? [])
      .map((b) => (b.type === "text" ? b.text : b.type === "tool-call" ? String(b.arguments ?? "") : ""))
      .join("\n");
  }
  if (event.type === "tool/call") return String(data.arguments ?? "");
  return "";
}

/** The session-shaped value recall.js expects. */
const session = {
  events,
  eventAt: (seq) => bySeq.get(seq),
  deriveEventMessage: (event) => {
    const text = renderEvent(event);
    return text.length === 0 ? null : { role: "user", content: [{ type: "text", text }] };
  }
};

const summaries = events.filter((e) => e.type === "compaction/summary");
if (summaries.length === 0) {
  console.log(JSON.stringify({ file, error: "no compaction/summary in this log" }, null, 1));
  process.exit(3);
}

const report = { file, compactions: [] };
for (const summary of summaries) {
  const shadowedSeqs = summary.data.shadowedSeqs ?? [];
  const spanText = shadowedSeqs.map((seq) => renderEvent(bySeq.get(seq))).join("\n");
  const summaryText = (summary.data.summary ?? []).map((b) => b.text ?? "").join("\n");
  const anchorSet = buildAnchorSet(spanText);

  const inSummary = [];
  const recovered = [];
  const lost = [];
  for (const anchor of anchorSet.anchors) {
    if (summaryText.includes(anchor.value)) { inSummary.push(anchor.value); continue; }
    // Not in the summary: can the agent still get it verbatim?
    const ownerSeq = shadowedSeqs.find((seq) => renderEvent(bySeq.get(seq)).includes(anchor.value));
    if (ownerSeq === undefined) { lost.push({ value: anchor.value, why: "not found in span" }); continue; }
    const recalled = recallSession(session, [{ start: ownerSeq, end: ownerSeq }], { maxRecallTokens: 20000 });
    const text = Array.isArray(recalled.entries)
      ? recalled.entries.map((entry) => (typeof entry === "string" ? entry : entry.text)).join("\n")
      : String(recalled.text ?? "");
    if (text.includes(anchor.value)) recovered.push({ value: anchor.value, seq: ownerSeq });
    else lost.push({ value: anchor.value, seq: ownerSeq, why: "recall did not return it" });
  }

  const total = anchorSet.anchors.length;
  report.compactions.push({
    compactionId: summary.data.compactionId,
    provider: summary.data.provider,
    model: summary.data.model,
    spanNodes: shadowedSeqs.length,
    shadowedTokenCount: summary.data.shadowedTokenCount,
    anchors: total,
    anchorTypes: anchorSet.typeCounts,
    summaryCarried: inSummary.length,
    summaryRetention: +(inSummary.length / total).toFixed(3),
    recoveredByRecall: recovered.length,
    availableToAgent: inSummary.length + recovered.length,
    availableRetention: +((inSummary.length + recovered.length) / total).toFixed(3),
    lost,
    recovered
  });
}

console.log(JSON.stringify(report, null, 1));
