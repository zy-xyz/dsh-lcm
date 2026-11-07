#!/usr/bin/env node
// bench/qa-recall.mjs — type-grouped verbatim recall: does the summary still let
// the model produce the exact values that appeared in the span?
//
// Why not one question per anchor: naming the anchor leaks it, and pointing at a
// "near ..." locator makes the model answer UNKNOWN when the summary drops that
// locator even though the value is present (measured: lcm carried 5 of 6 anchors
// and still scored 0/6). Grouping by kind asks for everything of a kind, leaks
// nothing, and has no ambiguity to resolve.
//
// Usage: node bench/qa-recall.mjs <span.json> <label> <contextFile|full>

import fs from "node:fs";
import { complete } from "./llm.mjs";
import { classifyAnchor } from "./qa-eval.mjs";

const [spanFile, label, contextArg] = process.argv.slice(2);
const span = JSON.parse(fs.readFileSync(spanFile, "utf8"));
const context = contextArg === "full" ? span.text : fs.readFileSync(contextArg, "utf8");

const anchors = span.canaries.map((value) => ({ value, type: classifyAnchor(value) }));
const byType = {};
for (const a of anchors) (byType[a.type] = byType[a.type] || []).push(a.value);

const KIND = {
  path: "absolute file paths",
  hex: "hexadecimal values written as 0x...",
  uuid: "UUIDs (8-4-4-4-12)",
  env: "environment-variable names in UPPER_CASE",
  error: "error or failure message text",
  command: "shell command lines",
  number: "numbers with units",
  other: "other exact literal strings"
};

const asks = Object.entries(byType).map(([type, vals]) =>
  "- " + (KIND[type] || type) + ": list every one you can see, one per line, verbatim."
).join("\n");

const prompt = "You are given a record of a work session.\n\n=== RECORD ===\n" + context +
  "\n\n=== TASK ===\nList the exact literal values that appear in the record, grouped by kind:\n" + asks +
  "\n\nRules: copy verbatim, do not translate, do not summarise, one value per line. If a kind has none, write \"(none)\".\nStart each group with \"## <kind>\".";

const out = await complete({ prompt, model: "balanced-lite", maxTokens: 1500, timeoutMs: 300000 });
const content = out.content;
const hit = anchors.filter((a) => content.includes(a.value));
const missed = anchors.filter((a) => !content.includes(a.value)).map((a) => a.value.slice(0, 30));
const row = { arm: label, ctxChars: context.length, hit: hit.length, total: anchors.length,
  rate: +(hit.length / anchors.length).toFixed(3), completionTokens: out.usage.completion_tokens };
fs.writeFileSync("/tmp/recall-" + label + ".txt", content);
fs.appendFileSync("/tmp/qa-recall.jsonl", JSON.stringify(row) + "\n");
console.log(JSON.stringify({ ...row, missed }, null, 1));
