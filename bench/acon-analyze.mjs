#!/usr/bin/env node
/**
 * bench/acon-analyze.mjs — the ACON step: hand the paired failures to a strong
 * model and ask which INSTRUCTION CLAUSE caused them, with clause-level rewrites.
 *
 * Input is the mechanical table from bench/acon-loop.mjs plus the current
 * instruction text; output is the model's reply, stored verbatim. Nothing here
 * paraphrases or improves the model's answer — if it says nothing, the report
 * says it said nothing.
 *
 * Usage: node bench/acon-analyze.mjs [--input=bench/results/acon-before-*.json]
 *        [--model=best] [--tag=before]
 *
 * @module bench/acon-analyze
 */
import fs from "node:fs";
import path from "node:path";
import { buildInstruction, SUMMARY_SKELETON } from "../src/summarize.js";
import { complete } from "./llm.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RESULTS = path.join(HERE, "results");

const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const TAG = String(arg("tag", "before"));
const MODEL = String(arg("model", "best"));
const MAX_TOKENS = Number(arg("max-tokens", "16000")) || 16000;
const DRY = String(arg("dry-run", "0")) === "1";
const AUGMENT = String(arg("augment", ""));

/** Read a finished run (JSON) or a per-question journal (JSONL, possibly torn). */
function readRows(file) {
  const text = fs.readFileSync(file, "utf8");
  if (file.endsWith(".jsonl")) {
    const rows = [];
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      try { rows.push(JSON.parse(line)); } catch { /* torn tail after a kill */ }
    }
    return { rows, totals: null };
  }
  return JSON.parse(text);
}

const inputPath = String(arg("input", "")).length > 0
  ? String(arg("input"))
  : fs.readdirSync(RESULTS)
      .filter((name) => name.startsWith("acon-" + TAG + "-") && !name.includes("analysis") && (name.endsWith(".json") || name.endsWith(".jsonl")))
      .sort()
      .pop();
const collect = readRows(path.join(RESULTS, inputPath));
// A mechanical-only pass has no checkpoint; its gold location and shape are the
// only facts it owns, so they are merged into the rows that do.
if (AUGMENT.length > 0) {
  const extra = readRows(path.join(RESULTS, AUGMENT)).rows;
  const byId = new Map(extra.map((row) => [row.question_id, row]));
  for (const row of collect.rows) {
    const source = byId.get(row.question_id);
    if (source === undefined) continue;
    row.form = row.form ?? source.form;
    row.goldLocation = row.goldLocation ?? source.goldLocation;
  }
}

/** One compact evidence block per paired failure. */
function evidenceText(row) {
  const hits = row.goldLocation?.hits ?? [];
  const sections = (row.sections?.sections ?? [])
    .map((section) => "    " + section.name + ": " + section.chars + " chars / " + section.lineCount + " lines")
    .join("\n");
  const blocks = [];
  for (const line of (row.checkpoint ?? "").split("\n")) {
    if (/^#{1,6}\s/u.test(line.trim())) blocks.push({ heading: line.trim(), lines: [] });
    else if (blocks.length > 0) blocks.at(-1).lines.push(line);
    else blocks.push({ heading: "", lines: [line] });
  }
  const anchorBlock = blocks.find((block) => block.heading.includes("逐字锚点"));
  const anchorBody = (anchorBlock?.lines ?? []).slice(0, 12);
  const narrative = blocks
    .filter((block) => block.heading.length > 0 && !block.heading.includes("逐字锚点"))
    .map((block) => block.heading + "\n" + block.lines.join("\n").trim())
    .join("\n\n");
  return [
    "### QUESTION_ID: " + row.question_id + " (" + row.question_type + ")",
    "Q: " + row.question,
    "GOLD: " + JSON.stringify(row.gold) + "  (" + row.goldChars + " chars)",
    "GOLD APPEARS IN CHECKPOINT: " + (row.goldInCheckpoint ? "YES" : "NO"),
    "GOLD IN ORIGINAL HAYSTACK: " + (hits.length === 0 ? "not found verbatim" : hits.length + " occurrences, first at session " + hits[0].sessionId + " (" + hits[0].date + ") seq " + hits[0].seq + ", role " + hits[0].role) +
      (hits.length > 0 ? "\n  SOURCE SENTENCE: " + JSON.stringify(hits[0].snippet) : ""),
    "CHECKPOINT: " + (row.compress?.checkpointChars ?? 0) + " chars, budget " + row.budget + " tokens, finish " + (row.compress?.finishReason ?? "?"),
    "SECTION CHARS (anchor " + ((row.sections?.anchorShare ?? 0) * 100).toFixed(0) + "% of the checkpoint):",
    sections,
    "FIRST ANCHOR LINES:",
    anchorBody.map((line) => "    " + line).join("\n"),
    "NARRATIVE SECTIONS AS WRITTEN:",
    narrative.slice(0, 2200),
    "ANSWER GIVEN FROM THIS CHECKPOINT: " + JSON.stringify(row.answer) + " -> judge " + (row.judge?.verdict ?? "-")
  ].join("\n");
}

const instructionText = buildInstruction(16384, 150000, 0);
const rows = collect.rows.filter((row) => row.error === null);

const prompt = [
  "You are analysing a FAILURE MODE of a context-compression instruction, in the manner of ACON (arXiv 2510.00615): paired trajectories where the full context answers correctly and the compressed context fails, and the instruction itself is the artifact under repair.",
  "",
  "SETUP. A long conversation history (a user's chat log, ~150k tokens of many unrelated sessions) is compressed into a checkpoint by the instruction below. A later agent that only has the checkpoint is asked one question and must answer it or say UNKNOWN. Everything below was measured, not hypothesised:",
  "  - the compression model saw the full original history and wrote the checkpoint;",
  "  - the gold answer exists verbatim in the original history (the row shows where);",
  "  - every pair below answered CORRECTLY with the full history and FAILED with the checkpoint.",
  "",
  "THE INSTRUCTION CURRENTLY SENT TO THE COMPRESSION MODEL:",
  "----- BEGIN INSTRUCTION -----",
  instructionText,
  "----- END INSTRUCTION -----",
  "",
  "MEASURED GOLD-ANSWER SHAPE ACROSS THE 15 PAIRED FAILURES (computed, not guessed):",
  "  numeric/time (pure number or counting answer): 7",
  "  prose-short (a short noun phrase: a name, a degree, a place, a size phrase): 6",
  "  prose-long (a multi-sentence preference description, a multi-step event order): 2",
  "  identifier (path, command, URL, error string, uuid, function or variable name): 0",
  "",
  "Note what the instruction's anchor section asks for, above, and what those 15 gold answers actually are.",
  "",
  "THE 15 PAIRED FAILURES:",
  rows.map(evidenceText).join("\n\n"),
  "",
  "YOUR TASK. These checkpoints all successfully compressed the original text, yet the agent that received them could not answer these questions.",
  "1. Name which clauses in the instruction caused these failures. Merge the 15 failures into a SMALL number of failure modes (do not write one per question) and say how many pairs each mode explains.",
  "2. For each mode, quote the exact instruction sentence responsible (quote it in Chinese as it appears).",
  "3. For each mode, give the CONCRETE rewrite: the current sentence, and the replacement sentence you would put in its place. It must be a drop-in replacement for the text in the instruction above, in the same Chinese register, and it must not contradict the instruction's hard ordering rules.",
  "4. Judge one open question explicitly, without assuming the answer: are the failures explained by (a) the anchor section's definition being too narrow, (b) a missing section for numeric/prose facts, or (c) something else in the instruction? State which, and what evidence in the table decided it.",
  "5. State what would falsify your proposal: if your rewrite were applied and the 15 questions were re-measured, what number should move, and which part of your diagnosis is wrong if it does not.",
  "",
  "Rules: your rewrites must be sent verbatim into the same prompt that carries the rest of this instruction, so they must not reference this analysis, must not add new sections to the section list unless you also say exactly where the extra heading goes, and must not disturb the rule that the anchor section is written FIRST. Do not give generic advice such as 'be more careful with numbers' — every recommendation must be a specific sentence to replace a specific sentence.",
  "Output Markdown, with headers: ## 失败模式, ## 责任条款与改法, ## 未决判断, ## 可证伪条件."
].join("\n");

process.stderr.write("analysing " + rows.length + " pairs with model=" + MODEL + ", prompt " + prompt.length + " chars\n");

// Dry run exists so the prompt can be inspected and fired by someone else
// without spending a second gateway call.
if (DRY) {
  const dryPath = path.join(RESULTS, "acon-analysis-prompt-" + TAG + ".txt");
  fs.writeFileSync(dryPath, prompt);
  fs.writeFileSync(path.join(RESULTS, "acon-analysis-prompt-" + TAG + ".rows.json"), JSON.stringify({ input: inputPath, augment: AUGMENT, pairs: rows.length, promptChars: prompt.length }, null, 1));
  console.log(JSON.stringify({ dryRun: true, prompt: dryPath, rows: rows.length, chars: prompt.length }, null, 1));
  process.exit(0);
}

const out = await complete({ prompt, maxTokens: MAX_TOKENS, model: MODEL, timeoutMs: 900_000, temperature: 0 });

const day = new Date().toISOString().slice(0, 10).replace(/-/gu, "");
const base = path.join(RESULTS, "acon-analysis-" + TAG + "-" + day);
fs.writeFileSync(base + ".json", JSON.stringify({
  generatedAt: new Date().toISOString(),
  input: inputPath,
  model: { requested: MODEL, resolved: out.model },
  maxTokens: MAX_TOKENS,
  finishReason: out.finishReason,
  usage: out.usage,
  reasoningTokens: out.reasoningTokens,
  visibleCompletionTokens: out.visibleCompletionTokens,
  promptChars: prompt.length,
  pairsAnalyzed: rows.length,
  verdicts: collect.totals === null ? null : { judgeCorrect: collect.totals.judgeCorrect, stringCorrect: collect.totals.stringCorrect, goldInCheckpoint: collect.totals.goldInCheckpoint },
  raw: out.content
}, null, 1));
fs.writeFileSync(base + ".prompt.txt", prompt);
fs.writeFileSync(base + ".md", out.content);
process.stderr.write("WROTE " + base + ".md (" + out.content.length + " chars, finish " + out.finishReason + ")\n");
console.log(JSON.stringify({ file: base + ".md", model: out.model, finish: out.finishReason, chars: out.content.length, reasoning: out.reasoningTokens }, null, 1));
