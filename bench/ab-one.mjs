#!/usr/bin/env node
// bench/ab-one.mjs — one arm-rep of the equal-budget A/B, generation-capped.
//
// The route matters: `deepseek-v4-flash-auto` silently ignores `max_tokens`
// (asked 40, got 654), while `balanced-lite` honours it exactly. A generation
// cap is the only honest way to make "equal budget" true by construction, so
// this runner fixes the route and asserts the cap was respected.
//
// Usage: node bench/ab-one.mjs <span.json> <basic|lcm> <rep> [budget] [model]

import fs from "node:fs";
import { complete } from "./llm.mjs";
import { countTokens, defaultBudget, scoreAtBudget } from "./equal-budget.mjs";

const [spanFile, arm, repArg, budgetArg, modelArg] = process.argv.slice(2);
if (spanFile === undefined || arm === undefined) {
  console.error("usage: node bench/ab-one.mjs <span.json> <basic|lcm> <rep> [budget] [model]");
  process.exit(2);
}
const span = JSON.parse(fs.readFileSync(spanFile, "utf8"));
// "none" runs uncapped: the natural comparison is "let each arm write what it
// wants, then compare fidelity AND cost", not "clip both at an arbitrary
// number". A cap is still available for the equal-budget variant.
const uncapped = budgetArg === "none";
const budget = uncapped ? undefined : Number(budgetArg ?? defaultBudget(span));
const model = modelArg ?? "balanced-lite";
const prompt = fs.readFileSync(spanFile.replace(/\.json$/, "-" + arm + ".txt"), "utf8");

const out = await complete({ prompt, maxTokens: budget, model, timeoutMs: 180000 });
const capped = uncapped || (out.usage.completion_tokens !== undefined && out.usage.completion_tokens <= budget);
const scored = uncapped ? scoreAtBudget(span, out.content, 1e9) : scoreAtBudget(span, out.content, budget);
const row = {
  span: spanFile.split("/").pop(),
  arm,
  rep: Number(repArg ?? 1),
  model: out.model,
  requestedBudget: budget ?? "none",
  completionTokens: out.usage.completion_tokens,
  finishReason: out.finishReason,
  capRespected: capped,
  anchorHit: scored.anchorHit,
  anchorTotal: scored.anchorTotal,
  anchorRate: scored.anchorRate,
  elapsedMs: out.elapsedMs
};
fs.appendFileSync("/tmp/abcap.jsonl", JSON.stringify(row) + "\n");
console.log(JSON.stringify(row));
