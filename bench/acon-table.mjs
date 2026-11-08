#!/usr/bin/env node
/**
 * bench/acon-table.mjs — render the mechanical failure table from one
 * bench/acon-loop.mjs run as Markdown. Pure: reads the JSON, prints, no models.
 *
 * Usage: node bench/acon-table.mjs bench/results/acon-before-20261108.json
 *
 * @module bench/acon-table
 */
import fs from "node:fs";

const file = process.argv[2];
if (file === undefined) {
  console.error("usage: node bench/acon-table.mjs <acon-*.json>");
  process.exit(2);
}
const run = JSON.parse(fs.readFileSync(file, "utf8"));

const cell = (value) => String(value ?? "-").replace(/\|/gu, "\\|").replace(/\n/gu, " ");
const short = (value, max) => {
  const text = String(value ?? "");
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
};

const lines = [];
lines.push("| # | question_id | type | gold | form | gold in haystack (first) | gold in checkpoint | ck chars | anchor % | narrative chars | missing sections | answer | judge | string |");
lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
run.rows.forEach((row, index) => {
  const hit = row.goldLocation?.hits?.[0];
  const where = row.goldLocation === null || row.goldLocation === undefined
    ? "-"
    : (hit === undefined
        ? "not found verbatim (0)"
        : "s" + hit.sessionIndex + " " + hit.sessionId + " seq " + hit.seq + " (" + row.goldLocation.hits.length + "×)");
  lines.push([
    String(index + 1),
    cell(row.question_id),
    cell(row.question_type),
    cell("`" + short(row.gold, 42) + "`"),
    cell(row.form ?? "-"),
    cell(where),
    row.goldInCheckpoint ? "YES" : "**NO**",
    String(row.compress?.checkpointChars ?? "-"),
    row.sections === null ? "-" : (row.sections.anchorShare * 100).toFixed(1) + "%",
    String(row.sections?.narrativeChars ?? "-"),
    cell(row.sections?.missingSections?.length > 0 ? row.sections.missingSections.join(",") : "none"),
    cell("`" + short(row.answer, 26) + "`"),
    cell(row.judge?.verdict ?? "-"),
    row.stringCorrect ? "YES" : "no"
  ].join(" | ").replace(/^/u, "| ").replace(/$/u, " |"));
});

lines.push("");
lines.push("totals: " + JSON.stringify(run.totals));
console.log(lines.join("\n"));
