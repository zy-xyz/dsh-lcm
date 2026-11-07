#!/usr/bin/env node
// bench/qa-run.mjs — one arm of the end-to-end QA comparison.
//
// Answers questions that are only answerable from the span, given ONLY what the
// agent would have after compaction: a summary (or, for the ceiling arm, the
// full span). Grading is exact-substring on the anchor, so it needs no judge.
//
// Usage:
//   node bench/qa-run.mjs summarize <span.json> <basic|lcm> [budget]
//   node bench/qa-run.mjs answer    <span.json> <armLabel> <summaryFile|full> [n]

import fs from "node:fs";
import { complete } from "./llm.mjs";
import { buildPrompts, grade } from "./qa-eval.mjs";

const [mode, spanFile, arm, extra, nArg] = process.argv.slice(2);
if (mode === undefined || spanFile === undefined || arm === undefined) {
  console.error("usage: node bench/qa-run.mjs summarize <span.json> <basic|lcm> [budget] | answer <span.json> <label> <summaryFile|full> [n]");
  process.exit(2);
}
const span = JSON.parse(fs.readFileSync(spanFile, "utf8"));
const model = "balanced-lite";

if (mode === "summarize") {
  const prompt = fs.readFileSync(spanFile.replace(/\.json$/, "-" + arm + ".txt"), "utf8");
  const out = await complete({ prompt, model, maxTokens: extra === undefined ? undefined : Number(extra), timeoutMs: 300000 });
  const file = "/tmp/sum-" + arm + ".txt";
  fs.writeFileSync(file, out.content);
  console.log(JSON.stringify({ mode, arm, tokens: out.usage.completion_tokens, chars: out.content.length, file }));
} else {
  const n = Number(nArg ?? 6);
  const context = arm === "full" || extra === "full" ? span.text : fs.readFileSync(extra, "utf8");
  const { questions, prompt } = buildPrompts(span, n, context);
  const out = await complete({ prompt, model, timeoutMs: 300000 });
  const g = grade(span, questions, out.content);
  fs.writeFileSync("/tmp/qa-answers-" + arm + ".txt", out.content);
  const row = {
    arm, n: questions.length, answered: g.answered, correct: g.correct, rate: g.rate,
    contextChars: context.length, completionTokens: out.usage.completion_tokens
  };
  fs.appendFileSync("/tmp/qa-compare.jsonl", JSON.stringify(row) + "\n");
  console.log(JSON.stringify(row));
}
