#!/usr/bin/env node
/**
 * bench/acon-loop.mjs — ACON-style failure-driven instruction tuning.
 *
 * Two jobs, both mechanical:
 *   1. COLLECT: for the paired failures in a saved layer2-qa result (full-context
 *      CORRECT, lcm-oneshot not CORRECT), rebuild the haystack, re-compress it
 *      with the CURRENT buildInstruction(), re-ask the question of the fresh
 *      checkpoint, re-judge, and record every mechanical fact around it:
 *      where the gold string lives in haystack_sessions, whether it survived
 *      into the checkpoint, and how the checkpoint's characters split across
 *      sections.
 *   2. RERUN: the same pipeline with whatever instruction src/summarize.js now
 *      builds. Running --tag before and --tag after on the same 15 questions is
 *      the A/B; nothing else in the pipeline moves.
 *
 * Usage:
 *   node bench/acon-loop.mjs --tag=before
 *   node bench/acon-loop.mjs --tag=after
 *   node bench/acon-loop.mjs --tag=after --instructions=bench/results/x.json
 *
 * @module bench/acon
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { countTokens, defaultBudget } from "./equal-budget.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");
const RESULTS = path.join(HERE, "results");

const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const TAG = String(arg("tag", "before"));
const DATASET = String(arg("dataset", "/home/agent/workspaces/lcmx-study/data/longmemeval_s.json"));
const SOURCE = String(arg("source", path.join(RESULTS, "layer2-qa-sample20-20261108.json")));
const COMPRESS_MODEL = String(arg("compress-model", "balanced-lite"));
const ANSWER_MODEL = String(arg("answer-model", "balanced-lite"));
const JUDGE_MODEL = String(arg("judge-model", "deepseek-v4-flash-auto"));
const CONCURRENCY = Math.max(1, Number(arg("concurrency", "2")) || 2);
// Mechanical-only pass: locate the gold in the haystack and measure nothing else.
// Zero model calls, so it can run while another agent owns the gateway.
const NO_MODEL = arg("no-model", "0") === "1";
// The instruction builder is an INPUT, not a global: a sibling agent may be
// editing src/summarize.js while this runs, and an A/B whose "before" text
// mutates mid-run measures nothing. Pass a frozen module to pin it.
const MODULE = String(arg("instruction-module", "../src/summarize.js"));
const BUILDER = await import(MODULE.startsWith(".") ? new URL(MODULE, import.meta.url).href : MODULE);
const buildInstruction = BUILDER.buildInstruction;
const SUMMARY_SKELETON = BUILDER.SUMMARY_SKELETON;
const PAIR_IDS = String(arg("pairs", "")).split(",").map((s) => s.trim()).filter(Boolean);

const BASE_URL = (process.env.OMNIROUTE_BASE_URL ?? "http://10.126.126.4:20128/v1").replace(/\/$/, "");

function readKey() {
  for (const name of ["OMNIROUTE_API_KEY", "OPENAI_API_KEY"]) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  const file = path.join(process.env.HOME ?? "/root", ".dsh", ".credentials.yaml");
  return /sk-[A-Za-z0-9_-]{20,}/.exec(fs.readFileSync(file, "utf8"))[0];
}
const KEY = readKey();

async function chatOnce(messages, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 600_000);
  const started = Date.now();
  try {
    const response = await fetch(BASE_URL + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
      body: JSON.stringify({ model: options.model, messages, max_tokens: options.maxTokens, temperature: 0 })
    });
    const text = await response.text();
    if (!response.ok) throw new Error("gateway " + response.status + ": " + text.slice(0, 200));
    const parsed = JSON.parse(text);
    const choice = parsed.choices?.[0] ?? {};
    return {
      message: choice.message ?? { role: "assistant", content: "" },
      finishReason: choice.finish_reason ?? "unknown",
      usage: parsed.usage ?? {},
      model: parsed.model ?? options.model,
      elapsedMs: Date.now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Transport retries only: a 4xx is a harness bug, not load. */
async function chat(messages, options) {
  const attempts = 3;
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await chatOnce(messages, options);
    } catch (error) {
      last = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/fetch failed|ECONNRESET|socket hang up|ETIMEDOUT|aborted|gateway 5\d\d|gateway 429/u.test(message) || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** (attempt - 1)));
    }
  }
  throw last;
}

/* -------------------------------------------------------------- dataset --- */

function extractQuestions(filePath, wanted) {
  const text = fs.readFileSync(filePath, "utf8");
  const found = new Map();
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { depth += 1; if (depth === 2) start = i; continue; }
    if (ch === "[") { depth += 1; continue; }
    if (ch === "}") {
      if (depth === 2 && start >= 0) {
        const at = text.indexOf('"question_id"', start);
        if (at >= 0 && at < i) {
          let cursor = at + 15;
          while (cursor < i && text[cursor] !== '"') cursor += 1;
          const begin = cursor + 1;
          const end = text.indexOf('"', begin);
          const id = text.slice(begin, end);
          if (wanted.has(id) && !found.has(id)) found.set(id, JSON.parse(text.slice(start, i + 1)));
        }
        start = -1;
      }
      depth -= 1;
      continue;
    }
    if (ch === "]") { depth -= 1; continue; }
  }
  return found;
}

function renderHaystack(question) {
  const sessions = question.haystack_sessions ?? [];
  const ids = question.haystack_session_ids ?? [];
  const dates = question.haystack_dates ?? [];
  const lines = [];
  for (let s = 0; s < sessions.length; s += 1) {
    lines.push("[session " + String(ids[s] ?? "session_" + s) + " | " + String(dates[s] ?? "") + "]");
    for (const message of sessions[s] ?? []) lines.push(String(message.role ?? "user") + ": " + String(message.content ?? ""));
  }
  return lines.join("\n");
}

/**
 * Bucket one gold answer by shape. Deliberately coarse and printed in the table
 * so a reader can disagree with a specific row instead of the whole taxonomy.
 * @param gold - the reference answer.
 * @returns numeric | prose-short | prose-long.
 */
function goldForm(gold) {
  const text = String(gold ?? "").trim();
  if (/^\d+(?:[.,]\d+)?$/u.test(text)) return "numeric/time";
  if (text.length > 120 || (text.match(/[.!?。！？]/gu) ?? []).length > 1) return "prose-long";
  return "prose-short";
}

const normalize = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9\u3400-\u4dbf\u4e00-\u9fff]+/gu, " ").trim().replace(/\s+/gu, " ");

/** Every place the gold (normalized) appears in the haystack, with a global seq. */
function locateGold(question, gold) {
  const sessions = question.haystack_sessions ?? [];
  const ids = question.haystack_session_ids ?? [];
  const dates = question.haystack_dates ?? [];
  const target = normalize(gold);
  const hits = [];
  let seq = 0;
  for (let s = 0; s < sessions.length; s += 1) {
    const messages = sessions[s] ?? [];
    for (let t = 0; t < messages.length; t += 1) {
      const body = normalize(messages[t]?.content);
      if (target.length > 0 && body.includes(target)) {
        hits.push({
          sessionIndex: s,
          sessionId: String(ids[s] ?? "session_" + s),
          date: String(dates[s] ?? ""),
          turn: t,
          seq,
          role: String(messages[t]?.role ?? "user"),
          snippet: String(messages[t]?.content ?? "").slice(0, 240)
        });
      }
      seq += 1;
    }
  }
  return { hits, totalMessages: seq, totalSessions: sessions.length };
}

/** Split a checkpoint on its own headings and measure characters per section. */
const HEADING_RE = /^#{1,6}\s*(.*)$/u;
function sectionStats(checkpoint) {
  const lines = checkpoint.split("\n");
  const sections = [];
  let current = { name: "(preamble)", lines: [] };
  for (const line of lines) {
    const match = HEADING_RE.exec(line.trim());
    if (match !== null) {
      sections.push(current);
      current = { name: match[1].trim(), lines: [] };
    } else current.lines.push(line);
  }
  sections.push(current);
  const measured = sections
    .filter((section) => section.lines.join("\n").trim().length > 0 || section.name !== "(preamble)")
    .map((section) => ({ name: section.name, chars: section.lines.join("\n").trim().length, lineCount: section.lines.filter((l) => l.trim().length > 0).length }));
  const totalChars = measured.reduce((sum, section) => sum + section.chars, 0);
  const anchor = measured.find((section) => section.name.includes("逐字锚点"));
  const present = SUMMARY_SKELETON.map((heading) => heading.replace(/^#{1,6}\s*/u, "").trim());
  const names = measured.map((section) => section.name);
  return {
    totalChars,
    sections: measured,
    anchorChars: anchor?.chars ?? 0,
    anchorShare: totalChars === 0 ? 0 : +((anchor?.chars ?? 0) / totalChars).toFixed(3),
    narrativeChars: totalChars - (anchor?.chars ?? 0),
    missingSections: present.filter((heading) => !names.some((name) => name.includes(heading)))
  };
}

/* --------------------------------------------------------- pair selection -- */

const source = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
const byArm = Object.fromEntries(Object.entries(source.perQuestion).map(([arm, rows]) => [arm, new Map(rows.map((row) => [row.question_id, row]))]));
const pairIds = PAIR_IDS.length > 0
  ? PAIR_IDS
  : [...byArm["full-context"].keys()].filter((id) => {
      const full = byArm["full-context"].get(id);
      const one = byArm["lcm-oneshot"]?.get(id);
      return full?.judge?.verdict === "CORRECT" && one !== undefined && one.judge?.verdict !== "CORRECT";
    });

process.stderr.write("pairs: " + pairIds.length + " -> " + pairIds.join(",") + "\n");

const wanted = new Set(pairIds);
const datasetQuestions = extractQuestions(DATASET, wanted);
for (const id of pairIds) if (!datasetQuestions.has(id)) throw new Error("dataset missing " + id);

/* --------------------------------------------------------------- pipeline -- */

const OUT = path.join(RESULTS, "acon-" + TAG + "-" + new Date().toISOString().slice(0, 10).replace(/-/gu, "") + ".json");
const JOURNAL = OUT + ".jsonl";
// Per-question journal: a run killed mid-flight (this VM restarted once already
// during this experiment) loses only the questions in flight, not the whole arm.
const doneRows = new Map();
if (fs.existsSync(JOURNAL)) {
  for (const line of fs.readFileSync(JOURNAL, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const row = JSON.parse(line);
      if (row.error === null) doneRows.set(row.question_id, row);
    } catch { /* a torn last line is expected after a kill */ }
  }
  process.stderr.write("resuming: " + doneRows.size + " already-journaled\n");
}
const instructionProbe = countTokens("x") > 0 ? buildInstruction(16384, 150000, 0) : "";

async function oneQuestion(id, index) {
  const question = datasetQuestions.get(id);
  const gold = String(question.answer ?? "");
  const haystackText = renderHaystack(question);
  const haystackTokens = countTokens(haystackText);
  const budget = defaultBudget({ tokensEstimate: haystackTokens });
  const instruction = buildInstruction(budget, haystackTokens, 0);
  const prompt = "以下是本次会话的一段历史记录：\n\n" + haystackText + "\n\n=== INSTRUCTION ===\n" + instruction;
  const row = {
    question_id: id,
    question: question.question,
    question_type: question.question_type,
    gold,
    form: goldForm(gold),
    goldChars: gold.length,
    haystackTokensEst: haystackTokens,
    budget,
    instructionChars: instruction.length,
    goldLocation: null,
    compress: null,
    checkpoint: null,
    sections: null,
    goldInCheckpoint: null,
    goldInCheckpointRaw: null,
    answer: null,
    judge: null,
    stringCorrect: null,
    error: null
  };
  try {
    row.goldLocation = locateGold(question, gold);
    if (NO_MODEL) {
      row.elapsedMs = 0;
      fs.appendFileSync(JOURNAL, JSON.stringify(row) + "\n");
      process.stderr.write("[" + (index + 1) + "/" + pairIds.length + "] " + id + " gold=" + JSON.stringify(gold.slice(0, 30)) + " form=" + row.form + " hits=" + row.goldLocation.hits.length + "\n");
      return row;
    }
    const started = Date.now();
    const out = await chat([{ role: "user", content: prompt }], { model: COMPRESS_MODEL, maxTokens: budget, timeoutMs: 900_000 });
    const checkpoint = String(out.message.content ?? "").trim();
    row.compress = {
      checkpointChars: checkpoint.length,
      checkpointTokensEst: countTokens(checkpoint),
      promptTokens: out.usage.prompt_tokens ?? null,
      completionTokens: out.usage.completion_tokens ?? null,
      finishReason: out.finishReason,
      model: out.model,
      elapsedMs: out.elapsedMs
    };
    row.checkpoint = checkpoint;
    row.sections = sectionStats(checkpoint);
    row.goldInCheckpoint = normalize(checkpoint).includes(normalize(gold));
    row.goldInCheckpointRaw = checkpoint.toLowerCase().includes(gold.toLowerCase());
    const answered = await chat(
      [{
        role: "user",
        content:
          "You are answering a question about a long conversation history with a user.\n\n<context>\n" + checkpoint + "\n</context>\n\n" +
          "Question: " + question.question + "\n\n" +
          "Answer with a short phrase or sentence. Do not explain your reasoning. If the context does not contain the answer, say UNKNOWN."
      }],
      { model: ANSWER_MODEL, maxTokens: 256, timeoutMs: 900_000 }
    );
    row.answer = String(answered.message.content ?? "").trim();
    row.answerFinish = answered.finishReason;
    const judged = await chat(
      [{
        role: "user",
        content:
          "You are grading one answer against a gold reference answer.\n\n" +
          "Question: " + question.question + "\nGold answer: " + gold + "\nModel answer: " + row.answer + "\n\n" +
          "The model answer is CORRECT if it states the same fact as the gold answer, allowing paraphrase, extra words, or a more specific form. " +
          "It is WRONG if it states a different fact, contradicts the gold, says UNKNOWN, or is empty.\n\n" +
          "Output exactly one line, either CORRECT or WRONG. No other text."
      }],
      { model: JUDGE_MODEL, maxTokens: 512, timeoutMs: 300_000 }
    );
    const content = String(judged.message.content ?? "").trim();
    const reasoning = String(judged.message.reasoning_content ?? "");
    const hit = /\bCORRECT\b|\bWRONG\b/u.exec(content.toUpperCase()) ?? /\bCORRECT\b|\bWRONG\b/u.exec(reasoning.toUpperCase());
    row.judge = {
      verdict: hit === null ? null : (hit[0] === "CORRECT" ? "CORRECT" : "WRONG"),
      raw: (content || reasoning).slice(0, 120),
      model: judged.model,
      viaReasoning: hit !== null && !/\bCORRECT\b|\bWRONG\b/u.test(content.toUpperCase())
    };
    row.stringCorrect = normalize(row.answer).includes(normalize(gold));
    row.elapsedMs = Date.now() - started;
  } catch (error) {
    row.error = error instanceof Error ? error.message.slice(0, 300) : String(error);
  }
  fs.appendFileSync(JOURNAL, JSON.stringify(row) + "\n");
  process.stderr.write(
    "[" + (index + 1) + "/" + pairIds.length + "] " + id +
    " gold=" + JSON.stringify(gold.slice(0, 30)) +
    " ck=" + (row.compress?.checkpointChars ?? "-") +
    " anchor=" + (row.sections === null ? "-" : (row.sections.anchorShare * 100).toFixed(1) + "%") +
    " inCk=" + (row.goldInCheckpoint ? "Y" : "N") +
    " judge=" + (row.judge?.verdict ?? "-") +
    " ans=" + JSON.stringify(String(row.answer ?? "").slice(0, 40)) +
    (row.error === null ? "" : " ERROR " + row.error.slice(0, 100)) + "\n"
  );
  return row;
}

/** Bounded worker pool; the gateway degrades under wide parallelism. */
const rows = new Array(pairIds.length);
let cursor = 0;
async function worker() {
  for (;;) {
    const index = cursor;
    cursor += 1;
    if (index >= pairIds.length) return;
    const id = pairIds[index];
    const cached = doneRows.get(id);
    if (cached !== undefined) {
      rows[index] = cached;
      process.stderr.write("[" + (index + 1) + "/" + pairIds.length + "] " + id + " (from journal)\n");
      continue;
    }
    rows[index] = await oneQuestion(id, index);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pairIds.length) }, () => worker()));

const ok = rows.filter((row) => row.error === null);
const correct = ok.filter((row) => row.judge?.verdict === "CORRECT").length;
const stringCorrect = ok.filter((row) => row.stringCorrect === true).length;
const inCheckpoint = ok.filter((row) => row.goldInCheckpoint === true).length;
const payload = {
  tag: TAG,
  generatedAt: new Date().toISOString(),
  source: SOURCE,
  dataset: { path: DATASET, sha256: crypto.createHash("sha256").update(fs.readFileSync(DATASET)).digest("hex") },
  models: { compress: COMPRESS_MODEL, answer: ANSWER_MODEL, judge: JUDGE_MODEL },
  instruction: {
    module: MODULE,
    probe: instructionProbe,
    summarySkeleton: SUMMARY_SKELETON,
    perQuestionBudget: defaultBudget({ tokensEstimate: 150000 })
  },
  totals: {
    n: rows.length,
    ran: ok.length,
    judgeCorrect: correct,
    judgeAccuracy: ok.length === 0 ? 0 : +(correct / ok.length).toFixed(4),
    stringCorrect,
    stringAccuracy: ok.length === 0 ? 0 : +(stringCorrect / ok.length).toFixed(4),
    goldInCheckpoint: inCheckpoint,
    meanAnchorShare: ok.length === 0 ? 0 : +(ok.reduce((sum, row) => sum + (row.sections?.anchorShare ?? 0), 0) / ok.length).toFixed(3),
    meanCheckpointChars: ok.length === 0 ? 0 : Math.round(ok.reduce((sum, row) => sum + (row.compress?.checkpointChars ?? 0), 0) / ok.length),
    meanNarrativeChars: ok.length === 0 ? 0 : Math.round(ok.reduce((sum, row) => sum + (row.sections?.narrativeChars ?? 0), 0) / ok.length)
  },
  rows
};
fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
process.stderr.write("\nWROTE " + OUT + "\n" + JSON.stringify(payload.totals) + "\n");
console.log(JSON.stringify({ out: OUT, totals: payload.totals }, null, 1));
