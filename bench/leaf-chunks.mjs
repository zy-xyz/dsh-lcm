#!/usr/bin/env node
/**
 * bench/leaf-chunks.mjs — one total summary budget, two shapes:
 *   A "whole-span"  the entire haystack in one call, budget = defaultBudget(haystack).
 *   B "leaf-chunks" the same haystack cut on SESSION boundaries into ~30k-token
 *                   pieces, each compressed separately with totalBudget/pieces,
 *                   then concatenated in order.
 *
 * Why the instrument exists (do not delete this paragraph): a one-off /tmp probe
 * measured A = 1 call / 3 420 output tokens / gold ABSENT, B = 5 calls / 5 809
 * output tokens / gold PRESENT on LongMemEval_S question e47becba at the same
 * 16 384-token ceiling. That is a single observation of a claim about budget
 * allocation, so it needs a rerun and an instrument that survives review. The
 * unknown being measured is not "does the model write more" (it can only write
 * up to max_tokens) but "does splitting the span let the model spend the same
 * ceiling on the facts that matter instead of on breadth".
 *
 * Pre-flight arithmetic (mandatory, because a previous probe measured its own
 * truncation instead of the compressor):
 *   1. the gold text must literally occur in the rendered haystack;
 *   2. the haystack session that carries it must be identified, and the piece it
 *      lands in recorded with that piece's token count;
 *   3. the number of occurrences of the gold in the whole haystack is recorded.
 * A question that fails (1) or (2) is SKIPPED with a printed reason; it is never
 * silently scored.
 *
 * Usage:
 *   node --max-old-space-size=8192 bench/leaf-chunks.mjs --sample 3 [--dry-run]
 *        [--limit N | --ids id1,id2] [--dataset PATH] [--model balanced-lite]
 *        [--chunk-tokens 30000] [--min-chunk-ratio 0.5] [--attempts 3]
 *        [--out PATH] [--overwrite] [--json]
 *
 *   --sample  even stride over the split. LongMemEval_S is grouped by question
 *             type, so --limit takes a single-type head; use --sample for any
 *             partial run whose per-type numbers will be read.
 *   --dry-run arithmetic and chunking only: no model call, no file written.
 *
 * Writes bench/results/leaf-chunks-<YYYYMMDD>.json and .md.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { complete } from "./llm.mjs";
import { buildInstruction } from "../src/summarize.js";
import { countTokens, defaultBudget } from "./equal-budget.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const DEFAULT_DATASET = "/home/agent/workspaces/lcmx-study/data/longmemeval_s.json";
const DATASET_REVISION = "2ec2a557f339b6c0369619b1ed5793734cc87533";

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf("--" + k);
  return i >= 0 ? (argv[i + 1] ?? true) : d;
};

const datasetPath = String(opt("dataset", DEFAULT_DATASET));
const limitRaw = opt("limit", null);
const limit = limitRaw === null ? 0 : Math.max(1, Number(limitRaw) || 0);
const sampleRaw = opt("sample", null);
const sample = sampleRaw === null ? 0 : Math.max(1, Number(sampleRaw) || 0);
const idsArg = opt("ids", null);
const ids = idsArg === null ? null : String(idsArg).split(",").map((s) => s.trim()).filter(Boolean);

const model = String(opt("model", "balanced-lite"));
const chunkTokens = Math.max(1000, Number(opt("chunk-tokens", 30000)) || 30000);
/** A trailing piece smaller than this share of the target is folded into its neighbour. */
const minChunkRatio = Math.min(0.95, Math.max(0, Number(opt("min-chunk-ratio", 0.5)) || 0.5));
/** 1 initial call + 3 retries, the retry budget the measurement contract asks for. */
const attempts = Math.max(1, Number(opt("attempts", 4)) || 4);
const promptTimeoutMs = Math.max(30000, Number(opt("timeout-ms", 900000)) || 900000);
const dryRun = argv.includes("--dry-run");
const printJson = argv.includes("--json");
const overwrite = argv.includes("--overwrite");

const stamp = new Date();
const ymd = String(stamp.getUTCFullYear()) + String(stamp.getUTCMonth() + 1).padStart(2, "0") + String(stamp.getUTCDate()).padStart(2, "0");
const outBase = path.resolve(REPO, String(opt("out", path.join("bench", "results", "leaf-chunks-" + ymd))));

/* ---------------------------------------------------------- question pick -- */

/** Even stride for --sample (keeps every question type), head for --limit. */
function pickQuestions(all) {
  if (ids !== null) {
    const byId = new Map(all.map((q) => [String(q.question_id), q]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      console.error("unknown question_id: " + missing.join(", "));
      process.exit(2);
    }
    return ids.map((id) => byId.get(id));
  }
  if (sample > 0) {
    const step = Math.max(1, Math.floor(all.length / sample));
    const picked = [];
    for (let i = 0; i < all.length && picked.length < sample; i += step) picked.push(all[i]);
    return picked;
  }
  return limit > 0 ? all.slice(0, limit) : all;
}

/* --------------------------------------------------------------- render ---- */

/**
 * Render one haystack session as a text block. Byte-identical to the block
 * layer2-qa.mjs / longmemeval.mjs put in front of the model, so both layers and
 * this instrument see the same haystack.
 */
function sessionBlock(question, s) {
  const id = String(question.haystack_session_ids?.[s] ?? "session_" + s);
  const date = String(question.haystack_dates?.[s] ?? "");
  const lines = ["[session " + id + " | " + date + "]"];
  for (const message of question.haystack_sessions?.[s] ?? []) {
    lines.push(String(message.role ?? "user") + ": " + String(message.content ?? ""));
  }
  return { index: s, id, date, text: lines.join("\n"), tokens: 0 };
}

/** Render the whole haystack, one block per session, in haystack order. */
function renderBlocks(question) {
  const blocks = [];
  for (let s = 0; s < (question.haystack_sessions?.length ?? 0); s += 1) {
    const block = sessionBlock(question, s);
    block.tokens = countTokens(block.text);
    blocks.push(block);
  }
  return blocks;
}

/* --------------------------------------------------------------- chunks ---- */

/**
 * Cut the session list into pieces of at most ~targetTokens, never splitting a
 * session. A trailing piece below minChunkRatio*target is folded into the
 * previous piece so the last call is not a scrap that cannot even afford the
 * instruction overhead.
 */
function chunkBlocks(blocks, targetTokens, minRatio) {
  const groups = [];
  let current = [];
  let tokens = 0;
  for (const block of blocks) {
    if (current.length > 0 && tokens + block.tokens > targetTokens) {
      groups.push(current);
      current = [];
      tokens = 0;
    }
    current.push(block);
    tokens += block.tokens;
  }
  if (current.length > 0) groups.push(current);

  let mergedTrailing = false;
  if (groups.length > 1) {
    const last = groups[groups.length - 1];
    const lastTokens = last.reduce((sum, b) => sum + b.tokens, 0);
    if (lastTokens < targetTokens * minRatio) {
      groups.pop();
      groups[groups.length - 1].push(...last);
      mergedTrailing = true;
    }
  }

  return {
    mergedTrailing,
    chunks: groups.map((group, index) => ({
      index,
      sessionIndex0: group.map((b) => b.index),
      sessionIds: group.map((b) => b.id),
      text: group.map((b) => b.text).join("\n"),
      tokens: 0,
      budget: 0
    }))
  };
}

/* ------------------------------------------------------------ pre-flight --- */

/** Count non-overlapping occurrences of needle in haystack, case-insensitively. */
function occurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  const hay = haystack.toLowerCase();
  const pin = needle.toLowerCase();
  let count = 0;
  let at = hay.indexOf(pin);
  while (at >= 0) {
    count += 1;
    at = hay.indexOf(pin, at + pin.length);
  }
  return count;
}

/**
 * The arithmetic that has to pass before a single model call is spent.
 * Returns 'failures' for anything that would make the measurement meaningless.
 */
function preflight(question, blocks, chunked, haystackText, haystackTokens, budget) {
  const gold = String(question.answer ?? "");
  const failures = [];
  if (gold.trim().length === 0) failures.push("gold answer is empty");

  const goldOccurrences = occurrences(haystackText, gold);
  if (goldOccurrences === 0) failures.push("gold text does not occur in the rendered haystack");

  const goldSessionIds = (question.answer_session_ids ?? []).map(String);
  const sessionIds = blocks.map((b) => b.id);
  // A question may label several gold sessions (multi-session type). All of them
  // are tracked; "the piece that carries gold" is every piece carrying one.
  const goldSessionIndices0 = goldSessionIds.map((id) => sessionIds.indexOf(id)).filter((index) => index >= 0);
  const missingGoldSessions = goldSessionIds.filter((id) => !sessionIds.includes(id));
  if (goldSessionIndices0.length === 0) {
    failures.push("no gold session id " + JSON.stringify(goldSessionIds) + " is in the haystack session list");
  } else if (missingGoldSessions.length > 0) {
    failures.push("gold session(s) " + JSON.stringify(missingGoldSessions) + " are not in the haystack session list");
  }

  const goldSessions = goldSessionIndices0.map((index) => ({
    index0: index,
    index1: index + 1,
    id: blocks[index].id,
    tokens: blocks[index].tokens,
    hasGold: occurrences(blocks[index].text, gold) > 0
  }));
  const sessionsWithoutGold = goldSessions.filter((s) => !s.hasGold).map((s) => s.id);
  if (sessionsWithoutGold.length > 0) failures.push("gold session(s) " + JSON.stringify(sessionsWithoutGold) + " do not contain the gold text");

  const goldSessionIndex = goldSessionIndices0.length > 0 ? goldSessionIndices0[0] : -1;
  const goldChunkIndices0 = [...new Set(goldSessionIndices0
    .map((index) => chunked.chunks.findIndex((c) => c.sessionIndex0.includes(index)))
    .filter((index) => index >= 0))].sort((a, b) => a - b);
  if (goldSessionIndices0.length > 0 && goldChunkIndices0.length === 0) failures.push("gold session falls in no chunk");

  const covered = chunked.chunks.reduce((sum, c) => sum + c.sessionIndex0.length, 0);
  if (covered !== blocks.length) failures.push("chunking covered " + covered + "/" + blocks.length + " sessions");

  const chunkBudgetTotal = chunked.chunks.reduce((sum, c) => sum + c.budget, 0);
  if (chunkBudgetTotal !== budget) failures.push("chunk budgets sum to " + chunkBudgetTotal + " != " + budget);

  return {
    gold,
    goldOccurrences,
    goldSessionIds,
    /** Occurrences <= this are treated as a usable containment signal. */
    containmentInformative: goldOccurrences > 0 && goldOccurrences <= 20,
    goldSessionIndices0,
    goldSessions,
    goldSessionIndex0: goldSessionIndex,
    goldSessionIndex1: goldSessionIndex + 1,
    goldSessionId: goldSessionIndex >= 0 ? blocks[goldSessionIndex].id : null,
    goldSessionTokens: goldSessionIndex >= 0 ? blocks[goldSessionIndex].tokens : null,
    goldSessionHasGold: goldSessions.length > 0 ? goldSessions.every((s) => s.hasGold) : null,
    goldChunkIndices0,
    goldChunkIndex0: goldChunkIndices0.length > 0 ? goldChunkIndices0[0] : -1,
    goldChunkIndex1: goldChunkIndices0.length > 0 ? goldChunkIndices0[0] + 1 : 0,
    goldChunkTokens: goldChunkIndices0.length > 0 ? chunked.chunks[goldChunkIndices0[0]].tokens : null,
    goldChunkBudget: goldChunkIndices0.length > 0 ? chunked.chunks[goldChunkIndices0[0]].budget : null,
    haystackTokens,
    budget,
    sessions: blocks.length,
    chunks: chunked.chunks.length,
    mergedTrailing: chunked.mergedTrailing,
    coveredSessions: covered,
    failures
  };
}


/* ------------------------------------------------------------- model call -- */

/** One completion with bounded retries. Transport/empty replies are retried; 4xx is not. */
async function callWithRetry(prompt, maxTokens) {
  let attemptsUsed = 0;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    attemptsUsed = attempt;
    // A retry must not replay the gateway's cached copy of a failed stream, so
    // every attempt after the first appends a one-line marker to the prompt.
    const effectivePrompt = attempt === 1 ? prompt : prompt + "\n\n[retry " + attempt + "]";
    try {
      const out = await complete({ prompt: effectivePrompt, maxTokens, model, timeoutMs: promptTimeoutMs });
      const text = String(out.content ?? "").trim();
      // The gateway reports a broken stream as finish_reason=error while still
      // returning partial text; that is a failed call, not a short summary.
      if (out.finishReason === "error" || out.finishReason === "failed") {
        throw new Error("gateway finish_reason=" + out.finishReason + " (partial " + text.length + " chars)");
      }
      if (text.length === 0) throw new Error("empty completion (finish_reason=" + out.finishReason + ")");
      return {
        ok: true,
        text,
        attempts: attemptsUsed,
        completionTokens: out.usage?.completion_tokens ?? countTokens(text),
        /**
         * Hidden reasoning tokens, billed inside completion_tokens. The routed
         * alias sometimes lands on a reasoning model, and those tokens consume
         * the same max_tokens ceiling without adding a single visible summary
         * token, so they have to be reported apart from the summary text.
         */
        reasoningTokens: out.usage?.completion_tokens_details?.reasoning_tokens
          ?? out.usage?.completion_tokens_details?.reasoning ?? 0,
        /** Provider-reported prompt size, null when the gateway omitted usage. */
        promptTokens: out.usage?.prompt_tokens ?? null,
        /** Our own estimate for the same prompt, for the calibration ratio (see promptRatio()). */
        promptEstimate: countTokens(effectivePrompt),
        /** Prefix-cache hits the provider reported, when it reports them. */
        cachedPromptTokens: out.usage?.prompt_cache_hit_tokens
          ?? out.usage?.prompt_tokens_details?.cached_tokens
          ?? null,
        resolvedModel: out.model ?? null,
        finishReason: out.finishReason,
        elapsedMs: out.elapsedMs,
        tokensPerSecond: out.elapsedMs > 0 ? +((out.usage?.completion_tokens ?? 0) / (out.elapsedMs / 1000)).toFixed(1) : null,
        error: null
      };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retryable = !/gateway 4\d\d/u.test(message);
      if (!retryable || attempt === attempts) break;
      // A credential-pool cooldown ("All credentials ... cooling down") needs a
      // longer wait than a dropped connection; 2s just burns an attempt.
      const poolWait = /rate limit|cooling down|429/u.test(message);
      const delayMs = poolWait ? Math.max(15000 * attempt, 2000 * 2 ** (attempt - 1)) : 2000 * 2 ** (attempt - 1);
      process.stderr.write("    retry " + attempt + "/" + attempts + " after " + (delayMs / 1000) + "s: " + message.slice(0, 160) + "\n");
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  return { ok: false, text: "", attempts: attemptsUsed, completionTokens: 0, reasoningTokens: 0, promptTokens: null, promptEstimate: countTokens(prompt), cachedPromptTokens: null, resolvedModel: null, finishReason: null, elapsedMs: 0, tokensPerSecond: null, error: message };
}

/** The prompt shape bench/summarize-arm.mjs and bench/layer2-qa.mjs use. */
function buildPrompt(spanText, instruction) {
  return "\u4ee5\u4e0b\u662f\u672c\u6b21\u4f1a\u8bdd\u7684\u4e00\u6bb5\u5386\u53f2\u8bb0\u5f55\uff1a\n\n" + spanText + "\n\n=== INSTRUCTION ===\n" + instruction;
}

/**
 * Is this arms' provider/estimate ratio far below the run's own pattern?
 *
 * countTokens() is not a tokenizer: on English prose it overcounts the provider
 * by roughly a third (measured: the same 148 023-token estimate billing 108 899
 * provider tokens in bench/results/layer2-qa-smoke.json). Comparing to the raw
 * estimate would therefore flag every call as "truncated". The honest test is
 * relative: if a call's ratio collapses to well under the run's median ratio, the
 * gateway sent materially less prompt than was built - and then that arm measures
 * the truncation, not the compressor, which is exactly how the previous probe
 * invalidated itself.
 */
const TRUNCATION_RATIO = 0.6;

/** Median of a numeric list, null when empty. */
function median(list) {
  if (list.length === 0) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Prompt ratio of one arm, null when the gateway reported no usage. */
function promptRatio(arm) {
  if (arm.promptTokens === null || arm.promptTokens === undefined) return null;
  if (arm.promptEstimate <= 0) return null;
  return +(arm.promptTokens / arm.promptEstimate).toFixed(4);
}

/** Case-insensitive literal containment, the pre-registered scoring rule. */
function goldContained(text, gold) {
  if (String(gold).trim().length === 0) return false;
  return String(text).toLowerCase().includes(String(gold).toLowerCase());
}

/* ---------------------------------------------------------------- arms ----- */

/** Arm A: the whole haystack as one span, one call, budget = defaultBudget(haystack). */
async function runArmA(ctx) {
  const { haystackText, pre } = ctx;
  const instruction = buildInstruction(pre.budget, pre.haystackTokens, 0);
  const started = Date.now();
  const out = await callWithRetry(buildPrompt(haystackText, instruction), pre.budget);
  const elapsedMs = Date.now() - started;
  return {
    arm: "A-whole",
    calls: out.attempts,
    failedPieces: out.ok ? 0 : 1,
    outputTokens: out.completionTokens,
    reasoningTokens: out.reasoningTokens,
    visibleTokens: Math.max(0, out.completionTokens - out.reasoningTokens),
    budget: pre.budget,
    budgetShare: pre.budget === 0 ? 0 : +(out.completionTokens / pre.budget).toFixed(4),
    compressionRatio: out.completionTokens === 0 ? null : +(pre.haystackTokens / out.completionTokens).toFixed(1),
    summary: out.text,
    summaryTokens: countTokens(out.text),
    goldInSummary: out.ok ? goldContained(out.text, pre.gold) : false,
    goldInGoldPiece: null,
    finishReasons: [out.finishReason],
    hitCeiling: out.finishReason === "length",
    errors: out.ok ? [] : ["A: " + out.error],
    promptTokens: out.promptTokens,
    promptEstimate: out.promptEstimate,
    cachedPromptTokens: out.cachedPromptTokens,
    tokensPerSecond: out.tokensPerSecond,
    promptRatio: null,
    promptShortfall: null,
    resolvedModels: out.resolvedModel === null ? [] : [out.resolvedModel],
    pieces: null,
    elapsedMs
  };
}

/**
 * Arm B: the same haystack in session-boundary pieces, each with
 * floor(total/pieces) (remainder to piece 1), summaries concatenated in order.
 */
async function runArmB(ctx) {
  const { chunks, pre } = ctx;
  const started = Date.now();
  const pieces = [];
  let totalOut = 0;
  let calls = 0;
  let failedPieces = 0;
  const errors = [];
  const finishReasons = [];
  let promptTokens = 0;
  let promptEstimate = 0;
  let reasoningTokens = 0;
  let cachedPromptTokens = null;
  const resolvedModels = new Set();

  for (const chunk of chunks) {
    const instruction = buildInstruction(chunk.budget, chunk.tokens, 0);
    const out = await callWithRetry(buildPrompt(chunk.text, instruction), chunk.budget);
    calls += out.attempts;
    finishReasons.push(out.finishReason);
    totalOut += out.completionTokens;
    reasoningTokens += out.reasoningTokens;
    promptTokens += out.promptTokens ?? 0;
    promptEstimate += out.promptEstimate;
    if (out.cachedPromptTokens !== null && out.cachedPromptTokens !== undefined) cachedPromptTokens = (cachedPromptTokens ?? 0) + out.cachedPromptTokens;
    if (out.resolvedModel !== null) resolvedModels.add(out.resolvedModel);
    if (!out.ok) {
      failedPieces += 1;
      errors.push("piece " + (chunk.index + 1) + ": " + out.error);
    }
    pieces.push({
      index: chunk.index,
      sessionIds: chunk.sessionIds,
      sessions: chunk.sessionIds.length,
      tokens: chunk.tokens,
      budget: chunk.budget,
      outputTokens: out.completionTokens,
      reasoningTokens: out.reasoningTokens,
      summaryTokens: countTokens(out.text),
      promptTokens: out.promptTokens,
      promptEstimate: out.promptEstimate,
      cachedPromptTokens: out.cachedPromptTokens,
      tokensPerSecond: out.tokensPerSecond,
      resolvedModel: out.resolvedModel,
      attempts: out.attempts,
      finishReason: out.finishReason,
      hitCeiling: out.finishReason === "length",
      ok: out.ok,
      carriesGoldSession: pre.goldSessionIndices0.some((index) => chunk.sessionIndex0.includes(index)),
      goldInPiece: out.ok ? goldContained(out.text, pre.gold) : false,
      summary: out.text,
      error: out.error
    });
  }

  const elapsedMs = Date.now() - started;
  const joined = pieces.map((p) => p.summary).join("\n\n");
  const goldPieces = pieces.filter((p) => p.carriesGoldSession);
  return {
    arm: "B-chunks",
    calls,
    failedPieces,
    outputTokens: totalOut,
    reasoningTokens,
    visibleTokens: Math.max(0, totalOut - reasoningTokens),
    budget: pre.budget,
    budgetShare: pre.budget === 0 ? 0 : +(totalOut / pre.budget).toFixed(4),
    compressionRatio: totalOut === 0 ? null : +(pre.haystackTokens / totalOut).toFixed(1),
    summary: joined,
    summaryTokens: countTokens(joined),
    goldInSummary: failedPieces === 0 ? goldContained(joined, pre.gold) : false,
    goldInGoldPiece: goldPieces.length === 0 ? null : goldPieces.every((p) => p.goldInPiece),
    goldPiecePlan: goldPieces.map((p) => ({ index: p.index, sessions: p.sessions, tokens: p.tokens, budget: p.budget, goldInPiece: p.goldInPiece })),
    finishReasons,
    hitCeilingPieces: pieces.filter((p) => p.hitCeiling).length,
    errors,
    promptTokens,
    promptEstimate,
    cachedPromptTokens,
    tokensPerSecond: elapsedMs > 0 ? +((totalOut / (elapsedMs / 1000))).toFixed(1) : null,
    promptRatio: null,
    promptShortfall: null,
    resolvedModels: [...resolvedModels],
    pieces,
    elapsedMs
  };
}


/* ------------------------------------------------------------------ run ---- */

if (!fs.existsSync(datasetPath)) {
  console.error("dataset not found: " + datasetPath);
  process.exit(2);
}

const datasetBytes = fs.statSync(datasetPath).size;
const datasetSha256 = crypto.createHash("sha256").update(fs.readFileSync(datasetPath)).digest("hex");
const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
if (!Array.isArray(dataset)) {
  console.error("unexpected dataset shape (expected an array of questions)");
  process.exit(2);
}

const questions = pickQuestions(dataset);
const runStarted = Date.now();
const rows = [];
const skipped = [];

for (let index = 0; index < questions.length; index += 1) {
  const question = questions[index];
  const blocks = renderBlocks(question);
  const haystackText = blocks.map((b) => b.text).join("\n");
  const haystackTokens = countTokens(haystackText);
  const budget = defaultBudget({ tokensEstimate: haystackTokens });

  const chunked = chunkBlocks(blocks, chunkTokens, minChunkRatio);
  for (const chunk of chunked.chunks) chunk.tokens = countTokens(chunk.text);
  // One total budget, split evenly; the remainder goes to the first piece.
  const per = Math.floor(budget / chunked.chunks.length);
  const remainder = budget - per * chunked.chunks.length;
  for (const chunk of chunked.chunks) chunk.budget = per + (chunk.index === 0 ? remainder : 0);

  const pre = preflight(question, blocks, chunked, haystackText, haystackTokens, budget);

  process.stderr.write("[" + (index + 1) + "/" + questions.length + "] " + question.question_id + " (" + question.question_type + ") sessions=" + blocks.length + " haystackTokens=" + haystackTokens + " budget=" + budget + " chunks=" + chunked.chunks.length + "\n");
  process.stderr.write("  gold=" + JSON.stringify(pre.gold) + " occurrences=" + pre.goldOccurrences + " goldSession=" + pre.goldSessionIndex1 + "/" + blocks.length + " goldPiece=" + pre.goldChunkIndex1 + "/" + chunked.chunks.length + " pieceTokens=" + pre.goldChunkTokens + "\n");

  if (pre.failures.length > 0) {
    skipped.push({ question_id: question.question_id, question_type: question.question_type, reason: pre.failures.join("; "), preflight: pre });
    process.stderr.write("  SKIPPED: " + pre.failures.join("; ") + "\n");
    continue;
  }

  const row = {
    question_id: question.question_id,
    question_type: question.question_type,
    gold: pre.gold,
    preflight: pre,
    chunkPlan: chunked.chunks.map((c) => ({
      index: c.index,
      sessions: c.sessionIds.length,
      sessionIndex0: c.sessionIndex0,
      sessionSpan: [c.sessionIndex0[0], c.sessionIndex0[c.sessionIndex0.length - 1]],
      tokens: c.tokens,
      budget: c.budget
    })),
    arms: {}
  };

  if (dryRun) {
    row.arms = {};
    rows.push(row);
    continue;
  }

  const ctx = { haystackText, haystackTokens, budget, pre, chunks: chunked.chunks };

  const a = await runArmA(ctx);
  process.stderr.write("  A calls=" + a.calls + " out=" + a.outputTokens + " gold=" + a.goldInSummary + " promptTok=" + a.promptTokens + "/" + a.promptEstimate + (a.promptShortfall === true ? " TRUNCATED-PROMPT" : "") + " " + (a.elapsedMs / 1000).toFixed(1) + "s\n");
  row.arms["A-whole"] = a;

  const b = await runArmB(ctx);
  process.stderr.write("  B calls=" + b.calls + " out=" + b.outputTokens + " gold=" + b.goldInSummary + " goldPiece=" + b.goldInGoldPiece + " failed=" + b.failedPieces + " promptTok=" + b.promptTokens + "/" + b.promptEstimate + (b.promptShortfall === true ? " TRUNCATED-PROMPT" : "") + " " + (b.elapsedMs / 1000).toFixed(1) + "s\n");
  row.arms["B-chunks"] = b;

  rows.push(row);
}

const elapsedMs = Date.now() - runStarted;
const scored = rows.filter((r) => r.arms["A-whole"] !== undefined);
const ARM_NAMES = ["A-whole", "B-chunks"];

/** Mean of a numeric list, null when empty. */
function mean(list) {
  return list.length === 0 ? null : list.reduce((s, v) => s + v, 0) / list.length;
}

/** Aggregate one arm across the scored questions. */
function aggregateArm(name) {
  const list = scored.map((r) => r.arms[name]).filter((a) => a !== undefined);
  return {
    n: list.length,
    calls: list.reduce((s, a) => s + a.calls, 0),
    failedPieces: list.reduce((s, a) => s + a.failedPieces, 0),
    outputTokens: list.reduce((s, a) => s + a.outputTokens, 0),
    reasoningTokens: list.reduce((s, a) => s + a.reasoningTokens, 0),
    visibleTokens: list.reduce((s, a) => s + a.visibleTokens, 0),
    summaryTokens: list.reduce((s, a) => s + a.summaryTokens, 0),
    budgetTotal: list.reduce((s, a) => s + a.budget, 0),
    budgetShare: mean(list.map((a) => a.budgetShare)),
    compressionRatio: mean(list.map((a) => a.compressionRatio).filter((v) => v !== null)),
    goldKept: list.filter((a) => a.goldInSummary).length,
    goldKeptInGoldPiece: name === "B-chunks" ? list.filter((a) => a.goldInGoldPiece === true).length : null,
    elapsedMs: list.reduce((s, a) => s + a.elapsedMs, 0)
  };
}

const aggregates = Object.fromEntries(ARM_NAMES.map((name) => [name, aggregateArm(name)]));

/* Calibrate the prompt-accounting check against this run's own pattern. Rationale
 * is on promptRatio(): countTokens() overcounts English prose by ~1.35x, so the
 * question is never "provider == estimate", it is "is this call far off the run". */
const runRatios = scored
  .flatMap((r) => ARM_NAMES.map((name) => promptRatio(r.arms[name])))
  .filter((v) => v !== null);
const medianPromptRatio = median(runRatios);
for (const row of scored) {
  for (const name of ARM_NAMES) {
    const arm = row.arms[name];
    if (arm === undefined) continue;
    arm.promptRatio = promptRatio(arm);
    arm.promptShortfall = arm.promptRatio === null || medianPromptRatio === null
      ? null
      : arm.promptRatio < medianPromptRatio * TRUNCATION_RATIO;
  }
}
const truncatedArms = scored.flatMap((r) => ARM_NAMES.filter((name) => r.arms[name]?.promptShortfall === true).map((name) => r.question_id + "/" + name));


const payload = {
  benchmark: "dsh-lcm/leaf-summary-shape",
  instrument: "bench/leaf-chunks.mjs",
  generatedAt: new Date().toISOString(),
  dryRun,
  elapsedMs,
  model,
  question: "At ONE total summary budget, does compressing the haystack in session-sized pieces retain facts that a single whole-span summary drops?",
  dataset: {
    path: datasetPath,
    bytes: datasetBytes,
    sha256: datasetSha256,
    revision: DATASET_REVISION,
    split: "LongMemEval_S",
    totalQuestions: dataset.length,
    selected: questions.length,
    scored: scored.length,
    skipped: skipped.length,
    sample: sample || null,
    limit: limit || null,
    ids
  },
  config: {
    instruction: "buildInstruction(budget, tokensOfThatPiece, 0) from src/summarize.js, built at run time",
    arms: {
      "A-whole": "entire haystack as one span; budget = defaultBudget(haystackTokens) = min(16384, max(512, floor(tokens*0.12)))",
      "B-chunks": "haystack cut on session boundaries into <= chunkTokens pieces; per-piece budget = floor(totalBudget/pieces) with the remainder to piece 1; summaries concatenated in order"
    },
    chunkTokens,
    minChunkRatio,
    modelsResolved: [...new Set(scored.flatMap((r) => ARM_NAMES.flatMap((n) => r.arms[n]?.resolvedModels ?? [])))],
    promptCalibration: {
      medianProviderOverEstimate: medianPromptRatio,
      truncationRatio: TRUNCATION_RATIO,
      truncatedArms,
      note: "countTokens() is the engine's own estimator (src/compiler.js), not a tokenizer; on English prose the provider reports about 0.74x the estimate. An arm is flagged only when its ratio falls below truncationRatio * medianProviderOverEstimate."
    },
    promptShape: "以下是本次会话的一段历史记录：\n\n<piece>\n\n=== INSTRUCTION ===\n<instruction>",
    maxTokens: "per-call max_tokens = that call's budget (the ceiling is enforced by the gateway)",
    scoring: "gold kept = case-insensitive literal containment of question.answer in the summary text",
    retries: { attempts, retries: attempts - 1, backoff: "2000ms * 2^(n-1), at least 15000ms*attempt on rate limit / credential cooldown", retriedOn: "transport errors, 5xx, 429, empty completion, finish_reason=error", retryMarker: "attempts 2+ append a '\n\n[retry N]' line so the gateway cannot replay a cached broken stream" }
  },
  arms: aggregates,
  preflight: rows.map((r) => ({
    question_id: r.question_id,
    question_type: r.question_type,
    gold: r.gold,
    goldOccurrences: r.preflight.goldOccurrences,
    containmentInformative: r.preflight.containmentInformative,
    sessions: r.preflight.sessions,
    goldSessions: r.preflight.goldSessions.map((s) => ({ index1: s.index1, id: s.id, tokens: s.tokens, hasGold: s.hasGold })),
    goldChunks: r.preflight.goldChunkIndices0.map((i) => i + 1),
    chunks: r.preflight.chunks,
    goldChunkTokens: r.preflight.goldChunkTokens,
    goldChunkBudget: r.preflight.goldChunkBudget,
    haystackTokens: r.preflight.haystackTokens,
    budget: r.preflight.budget,
    mergedTrailing: r.preflight.mergedTrailing,
    failures: r.preflight.failures
  })),
  perQuestion: rows.map((r) => ({
    question_id: r.question_id,
    question_type: r.question_type,
    gold: r.gold,
    chunkPlan: r.chunkPlan,
    arms: Object.fromEntries(ARM_NAMES.filter((n) => r.arms[n] !== undefined).map((n) => {
      const a = r.arms[n];
      const brief = {
        calls: a.calls,
        failedPieces: a.failedPieces,
        outputTokens: a.outputTokens,
        reasoningTokens: a.reasoningTokens,
        visibleTokens: a.visibleTokens,
        summaryTokens: a.summaryTokens,
        budget: a.budget,
        budgetShare: a.budgetShare,
        compressionRatio: a.compressionRatio,
        goldInSummary: a.goldInSummary,
        goldInGoldPiece: a.goldInGoldPiece,
        promptTokens: a.promptTokens,
        promptEstimate: a.promptEstimate,
        promptRatio: a.promptRatio,
        promptShortfall: a.promptShortfall,
        cachedPromptTokens: a.cachedPromptTokens,
        tokensPerSecond: a.tokensPerSecond,
        resolvedModels: a.resolvedModels,
        finishReasons: a.finishReasons,
        errors: a.errors,
        elapsedMs: a.elapsedMs,
        summary: a.summary
      };
      brief.hitCeiling = a.hitCeiling ?? a.hitCeilingPieces ?? null;
      if (a.pieces === null || a.pieces === undefined) return [n, brief];
      brief.pieces = a.pieces.map((p) => ({
        index: p.index,
        sessions: p.sessions,
        tokens: p.tokens,
        budget: p.budget,
        outputTokens: p.outputTokens,
        attempts: p.attempts,
        finishReason: p.finishReason,
        hitCeiling: p.hitCeiling,
        promptTokens: p.promptTokens,
        promptEstimate: p.promptEstimate,
        cachedPromptTokens: p.cachedPromptTokens,
        tokensPerSecond: p.tokensPerSecond,
        resolvedModel: p.resolvedModel,
        carriesGoldSession: p.carriesGoldSession,
        goldInPiece: p.goldInPiece,
        error: p.error
      }));
      return [n, brief];
    }))
  })),
  skipped,
  boundaries: [
    "n is disclosed, not implied: see dataset.scored. LongMemEval_S stores questions grouped by type, so --sample (even stride) is the only partial selection whose per-type mix is meaningful; --limit takes a single-type head.",
    "Gold retention is case-insensitive LITERAL containment of the dataset's answer string, not a correctness judgement. A one-token gold (for example the answer 5) occurs hundreds of times in a 147k-token haystack, so containment is near-free for that question and must not be read as fidelity. Per-question goldOccurrences is recorded for exactly this reason.",
    "The instrument compresses the haystack as text; it never runs src/summarize.js against a live session. Token counts are countTokens() estimates (word-class + CJK density), the same estimator the other bench harnesses use, not provider-side counts. Provider prompt_tokens/completion_tokens are recorded per call where the gateway returns them.",
    "Both arms spend the SAME total budget, but not the same number of prompt tokens: arm B re-sends the instruction once per piece and pays that input cost. The comparison holds the output ceiling constant, not total cost.",
    "Arm B budgets floor(total/pieces) per piece with the remainder to the first piece, so a piece's budget is not proportional to its own token count. That is deliberate (it is the shape a caller would use); per-piece tokens and budgets are recorded.",
    "A merged trailing piece (below minChunkRatio * chunkTokens) changes the piece count and therefore every per-piece budget; mergedTrailing is recorded per question.",
    "Failure policy: a piece that still fails after the configured retries marks the arm's gold result false and reports its error; failed pieces are never silently dropped from the totals.",
    "Prompt accounting: every call records the provider's prompt_tokens next to this instrument's own countTokens() estimate of the same prompt. A provider count below 90% of the estimate means the gateway sent less than was built (input truncation); the arm then measures the truncation instead of the compressor, and the Prompt accounting table flags it.",
    "The model is requested by the alias balanced-lite, which the gateway routes. The resolved model id reported by the gateway is recorded per call: a rerun that lands on a different backend is a different model, not a repeat. In this environment the same alias resolved to different backends on consecutive calls.",
    "Hidden reasoning: the routed backends are reasoning models, and their reasoning_tokens are billed inside completion_tokens against the same max_tokens ceiling. Output tokens therefore overstate how much summary text a call actually wrote; visible summary tokens are reported separately (billed minus reasoning, plus this instrument's countTokens() of the returned text).",
    "Retries: attempt 2 and later append a one-line '[retry N]' marker to the prompt, because the gateway replays an identical body from cache and would otherwise hand back the same broken stream forever. A retried call is therefore a marginally different prompt, at most a few tokens longer.",
    "Wall-clock is the gateway's own latency. The gateway replays an identical prompt (same body) from cache, in which case elapsed can drop by an order of magnitude; content at temperature 0 is the same either way, but do not read elapsed as generation speed."
  ]
};


/* ------------------------------------------------------------- markdown ---- */

const BT = String.fromCharCode(96);
const c = (s) => BT + s + BT;
const pct = (v) => (v === null || v === undefined ? "-" : (v * 100).toFixed(1) + "%");
const num = (v) => (v === null || v === undefined ? "-" : String(v));

const perQuestionRows = scored.map((r) => {
  const a = r.arms["A-whole"];
  const b = r.arms["B-chunks"];
  const goldSessions = r.preflight.goldSessions.map((s) => s.index1 + "/" + r.preflight.sessions).join(" + ");
  const goldPieces = r.preflight.goldChunkIndices0.map((i) => (i + 1) + "/" + r.preflight.chunks).join(" + ");
  const informative = r.preflight.containmentInformative ? "yes" : "no (" + r.preflight.goldOccurrences + "x)";
  return "| " + r.question_id + " | " + r.question_type + " | " + goldSessions + " | " + goldPieces + " | " + informative + " | " + a.calls + " | " + a.outputTokens + " | " + pct(a.budgetShare) + " | " + (a.goldInSummary ? "**true**" : "false") + " | " + b.calls + " | " + b.outputTokens + " | " + pct(b.budgetShare) + " | " + (b.goldInSummary ? "**true**" : "false") + " | " + (b.goldInGoldPiece === true ? "true" : "false") + " | " + ((a.elapsedMs + b.elapsedMs) / 1000).toFixed(0) + "s |";
}).join("\n");

const preflightRows = rows.map((r) => {
  const p = r.preflight;
  const goldSessions = p.goldSessions.map((s) => s.index1).join("+") || "-";
  const goldPieces = p.goldChunkIndices0.map((i) => i + 1).join("+") || "-";
  const informative = p.containmentInformative ? "yes" : "no";
  return "| " + r.question_id + " | " + JSON.stringify(p.gold) + " | " + p.goldOccurrences + " | " + informative + " | " + p.sessions + " | " + goldSessions + " | " + (p.goldSessionHasGold === true ? "true" : "false") + " | " + goldPieces + "/" + p.chunks + " (merged=" + p.mergedTrailing + ") | " + num(p.goldChunkTokens) + " | " + num(p.goldChunkBudget) + " | " + p.haystackTokens + " | " + p.budget + " |";
}).join("\n");

const skippedRows = skipped.map((s) => "| " + s.question_id + " | " + s.question_type + " | " + s.reason + " |").join("\n");

const a0 = aggregates["A-whole"];
const b0 = aggregates["B-chunks"];
const aKept = scored.filter((r) => r.arms["A-whole"].goldInSummary).length;
const bKept = scored.filter((r) => r.arms["B-chunks"].goldInSummary).length;
const bKeptPiece = scored.filter((r) => r.arms["B-chunks"].goldInGoldPiece === true).length;
const consistent = scored.every((r) => !r.arms["A-whole"].goldInSummary || r.arms["B-chunks"].goldInSummary);
// Only rows whose gold string is rare in the haystack carry a containment signal.
const informativeRows = scored.filter((r) => r.preflight.containmentInformative);
const informativeA = informativeRows.filter((r) => r.arms["A-whole"].goldInSummary).length;
const informativeB = informativeRows.filter((r) => r.arms["B-chunks"].goldInSummary).length;
const informativeConsistent = informativeRows.every((r) => !r.arms["A-whole"].goldInSummary || r.arms["B-chunks"].goldInSummary);
const verdict = scored.length === 0
  ? "No question passed the pre-flight arithmetic, so there is nothing to compare."
  : "n=" + scored.length + ": whole-span kept gold on " + aKept + "/" + scored.length + " question(s), session-chunked on " + bKept + "/" + scored.length + " (gold-carrying piece alone: " + bKeptPiece + "/" + scored.length + "). "
    + (consistent
      ? "No question lost under chunking a fact the whole-span arm kept, so the direction is consistent on this sample."
      : "At least one question lost under chunking a fact the whole-span arm kept, so the direction is NOT consistent on this sample.")
    + " Cost of arm B: " + b0.calls + " calls / " + (b0.elapsedMs / 1000).toFixed(0) + "s vs " + a0.calls + " calls / " + (a0.elapsedMs / 1000).toFixed(0) + "s for arm A."
    + " Restricting to the " + informativeRows.length + " question(s) whose gold text is distinctive in the haystack (rare enough that containment means something): whole-span kept gold on "
    + informativeA + "/" + informativeRows.length + ", chunked on " + informativeB + "/" + informativeRows.length
    + (informativeConsistent ? " (chunking never loses what the whole span keeps)." : " (chunking loses ground on at least one). ");

const planSections = [];
for (const r of rows) {
  planSections.push("### " + r.question_id + " (" + r.question_type + ")");
  planSections.push("");
  planSections.push("| piece | sessions | session span (1-based) | tokens | budget | out tok | attempts | finish | carries gold session | gold in piece |");
  planSections.push("|---|---|---|---|---|---|---|---|---|---|");
  const armB = r.arms["B-chunks"];
  for (const plan of r.chunkPlan) {
    const piece = armB === undefined ? null : armB.pieces[plan.index];
    const carries = plan.sessionIndex0.includes(r.preflight.goldSessionIndex0);
    const cells = [
      String(plan.index + 1),
      String(plan.sessions),
      String(plan.sessionSpan[0] + 1) + "-" + String(plan.sessionSpan[1] + 1),
      String(plan.tokens),
      String(plan.budget),
      piece === null ? "-" : String(piece.outputTokens),
      piece === null ? "-" : String(piece.attempts),
      piece === null ? "-" : num(piece.finishReason),
      carries ? "**yes**" : "no",
      piece === null ? "-" : (piece.goldInPiece ? "true" : "false")
    ];
    planSections.push("| " + cells.join(" | ") + " |");
  }
  planSections.push("");
}

const mdLines = [
  "# Leaf summary shape at one budget - whole span vs session-chunked",
  "",
  "Generated " + payload.generatedAt + " by " + c("bench/leaf-chunks.mjs") + ". Model: " + c(model) + ". Same compressor, same total ceiling in both arms; only the shape of the span differs.",
  "",
  "- Dataset: LongMemEval_S, revision " + c(DATASET_REVISION) + " (" + datasetBytes + " bytes, sha256 " + c(datasetSha256) + ")",
  "- **n = " + scored.length + "** scored" + (skipped.length > 0 ? ", " + skipped.length + " skipped by pre-flight" : "") + (sample > 0 ? ", even stride " + c("--sample " + sample) : limit > 0 ? ", head " + c("--limit " + limit) : ids !== null ? ", explicit ids " + c(ids.join(",")) : "") + ".",
  "- Instruction: " + c("buildInstruction(budget, tokensOfThatPiece, 0)") + " from " + c("src/summarize.js") + ", built at run time (no frozen prompt copy).",
  "- Arm A " + c("whole-span") + ": the entire haystack as one span, budget = " + c("defaultBudget(haystackTokens)") + ".",
  "- Arm B " + c("leaf-chunks") + ": haystack cut on session boundaries into pieces of at most " + chunkTokens + " tokens (a trailing piece below " + (minChunkRatio * 100).toFixed(0) + "% of the target is folded into its neighbour), per-piece budget = " + c("floor(total/pieces)") + " with the remainder to piece 1, summaries concatenated in order.",
  "- Scoring: case-insensitive literal containment of " + c("question.answer") + " in the summary text. Not a correctness judgement.",
  "- Retries: 1 initial call + " + (attempts - 1) + " retries, 2000ms * 2^(n-1) backoff (>= 15s per attempt when the credential pool is cooling down), on transport errors / 5xx / 429 / empty completion / finish_reason=error.",
  "",
  "## Verdict",
  "",
  verdict,
  "",
  "## Per question",
  "",
  "| question | type | gold session(s) | gold piece(s) | gold text is distinctive? | A calls | A out tok | A share | A gold | B calls | B out tok | B share | B gold | B gold (gold pieces only) | elapsed |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  perQuestionRows.length > 0 ? perQuestionRows : "| - | - | - | - | - | - | - | - | - | - | - | - | - | - |",
  "",
  "## Pre-flight arithmetic (the guard against measuring your own truncation)",
  "",
  "| question | gold | occurrences in haystack | distinctive (<=" + 20 + "x) | sessions | gold session(s) | sessions contain gold | gold piece(s) | piece tokens | piece budget | haystack tokens | total budget |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|",
  preflightRows,
  "",
  "## Aggregate",
  "",
  "| arm | n | calls | failed pieces | output tok (billed) | of which hidden reasoning | visible summary tok | budget total | mean share of budget | compression ratio | gold kept | gold kept in gold piece | elapsed |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  "| A-whole | " + a0.n + " | " + a0.calls + " | " + a0.failedPieces + " | " + a0.outputTokens + " | " + a0.reasoningTokens + " | " + a0.visibleTokens + " | " + a0.budgetTotal + " | " + pct(a0.budgetShare) + " | " + (a0.compressionRatio === null ? "-" : a0.compressionRatio.toFixed(1) + ":1") + " | " + a0.goldKept + "/" + a0.n + " | - | " + (a0.elapsedMs / 1000).toFixed(0) + "s |",
  "| B-chunks | " + b0.n + " | " + b0.calls + " | " + b0.failedPieces + " | " + b0.outputTokens + " | " + b0.reasoningTokens + " | " + b0.visibleTokens + " | " + b0.budgetTotal + " | " + pct(b0.budgetShare) + " | " + (b0.compressionRatio === null ? "-" : b0.compressionRatio.toFixed(1) + ":1") + " | " + b0.goldKept + "/" + b0.n + " | " + b0.goldKeptInGoldPiece + "/" + b0.n + " | " + (b0.elapsedMs / 1000).toFixed(0) + "s |",
  "",
  "## Prompt accounting (did the gateway actually send the whole span?)",
  "",
  "Median provider/estimate ratio this run: **" + (medianPromptRatio === null ? "unknown" : medianPromptRatio.toFixed(3)) + "** (an arm is flagged as input-truncated only below " + (TRUNCATION_RATIO * 100).toFixed(0) + "% of that median).",
  "",
  "| question | arm | calls | prompt tok (provider) | prompt tok (estimated here) | ratio | provider vs run median | cached prompt tok | out tok/s | resolved model(s) |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...scored.flatMap((r) => ARM_NAMES.map((name) => {
    const a = r.arms[name];
    const truncated = a.promptShortfall === true
      ? "**TRUNCATED**"
      : a.promptShortfall === null
        ? "unknown (no provider usage)"
        : "in line";
    return "| " + r.question_id + " | " + name + " | " + a.calls + " | " + num(a.promptTokens) + " | " + num(a.promptEstimate) + " | " + (a.promptRatio === null ? "-" : a.promptRatio.toFixed(3)) + " | " + truncated + " | " + num(a.cachedPromptTokens) + " | " + num(a.tokensPerSecond) + " | " + (a.resolvedModels.length === 0 ? "-" : a.resolvedModels.join(", ")) + " |";
  })),
  "",
  "## Chunk plans",
  "",
  ...planSections,
  ...(skipped.length > 0 ? ["## Skipped questions (pre-flight)", "", "| question | type | reason |", "|---|---|---|", skippedRows, ""] : []),
  "## Boundaries",
  "",
  ...payload.boundaries.map((line, i) => (i + 1) + ". " + line),
  ""
];
const md = mdLines.join("\n");


/* ---------------------------------------------------------------- output --- */

if (dryRun) {
  process.stdout.write(md);
  process.stdout.write("[dry-run] arithmetic and chunking only: no model call, no file written.\n");
  process.exit(0);
}

if (fs.existsSync(outBase + ".json") || fs.existsSync(outBase + ".md")) {
  if (!overwrite) {
    console.error("refusing to overwrite " + outBase + ".{json,md}; pass --overwrite (existing files are kept as .prev) or --out PATH");
    process.exit(2);
  }
  for (const ext of [".json", ".md"]) {
    if (fs.existsSync(outBase + ext)) fs.renameSync(outBase + ext, outBase + ext + ".prev");
  }
}

fs.mkdirSync(path.dirname(outBase), { recursive: true });
fs.writeFileSync(outBase + ".json", JSON.stringify(payload, null, 1) + "\n");
fs.writeFileSync(outBase + ".md", md);

const summary = {
  out: outBase,
  n: scored.length,
  skipped: skipped.length,
  model,
  elapsedMs,
  arms: Object.fromEntries(ARM_NAMES.map((name) => [name, {
    calls: aggregates[name].calls,
    outputTokens: aggregates[name].outputTokens,
    budgetShare: aggregates[name].budgetShare,
    compressionRatio: aggregates[name].compressionRatio,
    goldKept: aggregates[name].goldKept + "/" + aggregates[name].n,
    goldKeptInGoldPiece: aggregates[name].goldKeptInGoldPiece,
    failedPieces: aggregates[name].failedPieces,
    elapsedMs: aggregates[name].elapsedMs
  }])),
  perQuestion: scored.map((r) => ({
    question_id: r.question_id,
    type: r.question_type,
    gold: r.gold,
    goldSession: r.preflight.goldSessionIndex1 + "/" + r.preflight.sessions,
    goldPiece: r.preflight.goldChunkIndex1 + "/" + r.preflight.chunks,
    A: { calls: r.arms["A-whole"].calls, out: r.arms["A-whole"].outputTokens, share: r.arms["A-whole"].budgetShare, gold: r.arms["A-whole"].goldInSummary, elapsedMs: r.arms["A-whole"].elapsedMs },
    B: { calls: r.arms["B-chunks"].calls, out: r.arms["B-chunks"].outputTokens, share: r.arms["B-chunks"].budgetShare, gold: r.arms["B-chunks"].goldInSummary, goldPiece: r.arms["B-chunks"].goldInGoldPiece, elapsedMs: r.arms["B-chunks"].elapsedMs }
  })),
  verdict
};
if (printJson) console.log(JSON.stringify(summary, null, 1));
else {
  process.stdout.write(md);
  process.stdout.write("\nfiles: " + outBase + ".json , " + outBase + ".md\n");
}
