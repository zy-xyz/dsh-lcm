#!/usr/bin/env node
// bench/equal-budget.mjs — the scoring half of an EQUAL-BUDGET fidelity comparison.
//
// Why this exists: the first ablation let both arms write as much as they liked
// (the gateway ignored max_tokens), so cost was never a controlled variable and
// the fidelity numbers mixed "compressed better" with "wrote more". The claim
// this package has to defend is *non-inferiority*, which only means something at
// a fixed budget: truncate both outputs to the same token ceiling, then count
// how many verbatim anchors survived.
//
// This module is pure: it counts tokens, truncates to a ceiling, and scores
// anchors. The model call is made by the caller (the harness tool), so the
// measurement can be re-scored offline from saved text without re-calling.
//
// CLI: node bench/equal-budget.mjs --score <span.json> <textfile> [budget]

import fs from "node:fs";

/** Word-class + CJK-density token estimate, matching src/compiler.js. */
export function countTokens(text) {
  const words = text.match(/[a-zA-Z]+|[0-9]+|[^\sa-zA-Z0-9]/g) ?? [];
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const density = Math.ceil(((text.length - cjk) * 3 + cjk * 6) / 10);
  return Math.max(words.length, density);
}

/**
 * Cut text to a token ceiling on line boundaries.
 * @param text - the raw output.
 * @param limit - the shared token ceiling.
 * @returns the truncated text and whether anything was cut.
 */
export function truncateToBudget(text, limit) {
  if (countTokens(text) <= limit) return { text, truncated: false };
  const lines = text.split("\n");
  const kept = [];
  for (const line of lines) {
    const candidate = kept.concat(line).join("\n");
    if (countTokens(candidate) > limit) break;
    kept.push(line);
  }
  const out = kept.join("\n");
  if (out.length === 0) return { text: text.slice(0, Math.max(32, limit * 3)), truncated: true };
  return { text: out, truncated: true };
}

/**
 * Score one arm-rep at a fixed budget.
 * @param span - `{ canaries, tokensEstimate }` from bench/span.mjs.
 * @param raw - the raw model output.
 * @param budget - the shared token ceiling.
 * @returns the row to append to the results log.
 */
export function scoreAtBudget(span, raw, budget) {
  const cut = truncateToBudget(raw, budget);
  const hit = span.canaries.filter((anchor) => cut.text.includes(anchor));
  return {
    budget,
    rawTokens: countTokens(raw),
    budgetedTokens: countTokens(cut.text),
    truncated: cut.truncated,
    anchorHit: hit.length,
    anchorTotal: span.canaries.length,
    anchorRate: +(hit.length / span.canaries.length).toFixed(3),
    text: cut.text,
  };
}

/** Default ceiling for one summary: the same rule the engine applies. */
export function defaultBudget(span) {
  return Math.min(16384, Math.max(512, Math.floor(span.tokensEstimate * 0.12)));
}

// ── CLI: re-score saved text without calling a model ───────────────────────
if (process.argv[1] !== undefined && process.argv[1].endsWith("equal-budget.mjs")) {
  const args = process.argv.slice(2);
  if (args[0] === "--score" && args.length >= 3) {
    const span = JSON.parse(fs.readFileSync(args[1], "utf8"));
    const raw = fs.readFileSync(args[2], "utf8");
    const budget = args[3] === undefined ? defaultBudget(span) : Number(args[3]);
    const { text, ...row } = scoreAtBudget(span, raw, budget);
    void text;
    console.log(JSON.stringify(row, null, 1));
  } else {
    console.error("usage: node bench/equal-budget.mjs --score <span.json> <textfile> [budget]");
    process.exit(2);
  }
}
