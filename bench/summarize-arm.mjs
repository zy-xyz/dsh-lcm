#!/usr/bin/env node
// bench/summarize-arm.mjs — produce ONE summary with the real instruction text.
//
// The older arms (c2-arm-*.txt) baked the instruction into a prompt file. That
// makes prompt edits unmeasurable: you cannot tell whether a token-count delta
// came from the model or from a stale copy of the instruction. This runner
// builds the instruction from the code under test, so "before vs after the
// narration cap" is a controlled comparison.
//
// Usage: node bench/summarize-arm.mjs <span.json> <basic|lcm|lcm-old> [budget|none] [model]
//
//   basic    — the built-in backend's instruction, frozen in bench/fixtures/
//   lcm      — buildInstruction() from src/summarize.js (the code under test)
//   lcm-old  — the pre-narration-cap instruction, frozen in bench/fixtures/
//
// Emits one JSON row: completion tokens, finish reason, and anchor carry both
// at natural length and truncated to the engine's own budget.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { complete } from "./llm.mjs";
import { buildInstruction } from "../src/summarize.js";
import { countTokens, defaultBudget, scoreAtBudget } from "./equal-budget.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = (name) => fs.readFileSync(path.join(HERE, "fixtures", name), "utf8").trim();

const [spanFile, arm, budgetArg, modelArg] = process.argv.slice(2);
if (spanFile === undefined || arm === undefined) {
  console.error("usage: node bench/summarize-arm.mjs <span.json> <basic|lcm|lcm-old> [budget|none] [model]");
  process.exit(2);
}

const span = JSON.parse(fs.readFileSync(spanFile, "utf8"));
const spanTokens = span.tokensEstimate ?? countTokens(span.text);
const budget = budgetArg === "none" ? defaultBudget(span) : Number(budgetArg ?? defaultBudget(span));
const model = modelArg ?? "balanced-lite";

// The "before" arm is derived from the code under test by removing exactly one
// sentence. A frozen copy would also freeze the token budget printed inside the
// instruction, so the two arms would differ in two places and the comparison
// would be worthless.
const CAP_CLAUSE = "后面四节**合计不超过 20 行**，每节几句话";
const instruction =
  arm === "lcm" ? buildInstruction(budget, spanTokens, 0)
  : arm === "lcm-old" ? buildInstruction(budget, spanTokens, 0).replace(CAP_CLAUSE, "后面四节各自最多几句话")
  : arm === "basic" ? FIXTURE("basic-instruction.txt")
  : null;
if (instruction === null) {
  console.error("unknown arm: " + arm);
  process.exit(2);
}

const prompt = "以下是本次会话的一段历史记录：\n\n" + span.text + "\n\n=== INSTRUCTION ===\n" + instruction;
const out = await complete({ prompt, maxTokens: budgetArg === "none" ? undefined : budget, model, timeoutMs: 300000 });

const raw = out.content;
const natural = scoreAtBudget(span, raw, Number.MAX_SAFE_INTEGER);
const capped = scoreAtBudget(span, raw, budget);
const row = {
  span: path.basename(spanFile),
  arm,
  model,
  budget,
  completionTokens: out.usage.completion_tokens,
  finishReason: out.choices?.[0]?.finish_reason ?? out.finishReason ?? null,
  rawTokens: natural.rawTokens,
  anchorsNatural: natural.anchorHit + "/" + natural.anchorTotal,
  anchorRateNatural: natural.anchorRate,
  anchorsAtBudget: capped.anchorHit + "/" + capped.anchorTotal,
  anchorRateAtBudget: capped.anchorRate,
};
const tag = [path.basename(spanFile, ".json"), arm, budgetArg ?? "auto", model].join("-");
fs.writeFileSync("/tmp/" + tag + ".txt", raw);
fs.appendFileSync("/tmp/summarize-arms.jsonl", JSON.stringify(row) + "\n");
console.log(JSON.stringify(row, null, 1));
