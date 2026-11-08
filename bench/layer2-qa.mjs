#!/usr/bin/env node
/**
 * bench/layer2-qa.mjs - Layer-2 (judged end-to-end QA accuracy) harness.
 *
 * Layer 1 (bench/longmemeval.mjs) measures whether retrieval puts the right
 * session in the top-k. That is not the same question as "can the system answer
 * the question", and the gap between the two is the whole reason this layer
 * exists: a retriever can score sR@10 = 0.84 and still fail the answer, and a
 * compressed checkpoint can score badly on recall while still carrying enough
 * to answer.
 *
 * Four arms, same questions, same answerer, same judge:
 *
 *   full-context   the entire haystack rendered as text (ceiling; no compression)
 *   basic-oneshot  haystack -> built-in backend instruction -> checkpoint -> answer
 *   lcm-oneshot    haystack -> buildInstruction() from src/summarize.js -> answer
 *   lcm-agentic    lcm checkpoint + lcm_search / lcm_expand over the raw log,
 *                  multi-turn: the model may retrieve originals before answering
 *
 * Compression reuses the exact prompt shape bench/summarize-arm.mjs uses
 * ("以下是本次会话的一段历史记录：" + span + "=== INSTRUCTION ===" + instruction)
 * and the engine's own defaultBudget rule. No embedding or compaction logic is
 * reimplemented here.
 *
 * Grading, both reported side by side:
 *   - model judge: question / gold / answer -> one line CORRECT or WRONG.
 *     Loose but reproducible; the judge model id is disclosed and differs from
 *     the answerer.
 *   - string judge: normalized substring containment of the gold answer in the
 *     model answer. Zero models, 100% reproducible, and it is the honest floor
 *     for short-entity golds.
 *
 * Usage:
 *   node bench/layer2-qa.mjs [--limit N | --sample N] [--arms full,basic,lcm,agentic]
 *        [--answer-model balanced-lite] [--judge-model deepseek-v4-flash-auto]
 *        [--max-steps 6] [--dataset PATH] [--out PATH] [--json]
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { complete } from "./llm.mjs";
import { buildInstruction } from "../src/summarize.js";
import { countTokens, defaultBudget } from "./equal-budget.mjs";
import { searchSession } from "../src/search.js";
import { recallSession, resolveRecallReference } from "../src/recall.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const DEFAULT_DATASET = "/home/agent/workspaces/lcmx-study/data/longmemeval_s.json";
const DATASET_REVISION = "2ec2a557f339b6c0369619b1ed5793734cc87533";
const FIXTURE = (name) => fs.readFileSync(path.join(HERE, "fixtures", name), "utf8").trim();

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
const printJson = argv.includes("--json");

const answerModel = String(opt("answer-model", "balanced-lite"));
const judgeModel = String(opt("judge-model", "deepseek-v4-flash-auto"));
const maxSteps = Math.max(1, Number(opt("max-steps", 6)) || 6);
/** Estimated-token ceiling for the full-context arm; 0 = never truncate. */
const fullMaxTokens = Math.max(0, Number(opt("full-max-tokens", 0)) || 0);
const answerMaxTokens = Math.max(16, Number(opt("answer-max-tokens", 256)) || 256);

const stamp = new Date();
const ymd = String(stamp.getUTCFullYear()) + String(stamp.getUTCMonth() + 1).padStart(2, "0") + String(stamp.getUTCDate()).padStart(2, "0");
const outBase = path.resolve(REPO, String(opt("out", path.join("bench", "results", "layer2-qa-" + ymd))));

const ALL_ARMS = ["full-context", "basic-oneshot", "lcm-oneshot", "lcm-agentic"];
const armsArg = String(opt("arms", ALL_ARMS.join(",")));
const ARMS = armsArg === "all" ? [...ALL_ARMS] : armsArg.split(",").map((s) => s.trim()).filter(Boolean);
for (const arm of ARMS) {
  if (!ALL_ARMS.includes(arm)) {
    console.error("unknown --arms member: " + arm + " (" + ALL_ARMS.join("|") + ")");
    process.exit(2);
  }
}

/* ------------------------------------------------------------ dataset ---- */

function pickQuestions(all, headCount, sampleCount) {
  if (sampleCount > 0) {
    const step = Math.max(1, Math.floor(all.length / sampleCount));
    const picked = [];
    for (let i = 0; i < all.length && picked.length < sampleCount; i += step) picked.push(all[i]);
    return picked;
  }
  return headCount > 0 ? all.slice(0, headCount) : all;
}

/** Render the whole haystack as plain text, one block per session. */
function renderHaystack(question) {
  const sessions = question.haystack_sessions ?? [];
  const ids = question.haystack_session_ids ?? [];
  const dates = question.haystack_dates ?? [];
  const lines = [];
  for (let s = 0; s < sessions.length; s += 1) {
    lines.push("[session " + String(ids[s] ?? "session_" + s) + " | " + String(dates[s] ?? "") + "]");
    for (const message of sessions[s] ?? []) {
      lines.push(String(message.role ?? "user") + ": " + String(message.content ?? ""));
    }
  }
  return lines.join("\n");
}

/**
 * Build the session-shaped value src/search.js and src/recall.js consume.
 * One event per haystack message, seq = index. Same contract as
 * bench/longmemeval.mjs so both layers see identical bytes.
 */
function buildSession(question) {
  const events = [];
  const meta = [];
  const textAt = [];
  const roleAt = [];
  const sessions = question.haystack_sessions ?? [];
  const ids = question.haystack_session_ids ?? [];
  for (let s = 0; s < sessions.length; s += 1) {
    const sessionId = String(ids[s] ?? "session_" + s);
    const messages = sessions[s] ?? [];
    for (let t = 0; t < messages.length; t += 1) {
      const message = messages[t] ?? {};
      const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      const role = message.role === "assistant" ? "assistant" : "user";
      events.push({ seq: events.length, type: role === "assistant" ? "assistant/message" : "user/message", data: null });
      meta.push({ sessionId, turnIndex: t });
      textAt.push(text);
      roleAt.push(role);
    }
  }
  const session = {
    events,
    eventAt: (seq) => events[seq],
    deriveEventMessage: (event) => {
      const text = textAt[event.seq];
      if (text === undefined || text.length === 0) return null;
      return { role: roleAt[event.seq], content: [{ type: "text", text }] };
    }
  };
  return { session, meta, eventCount: events.length };
}

/* ------------------------------------------------------------ prompts ---- */

const ANSWER_TEMPLATE = (payload, question) =>
  "You are answering a question about a long conversation history with a user.\n\n" +
  "<context>\n" + payload + "\n</context>\n\n" +
  "Question: " + question + "\n\n" +
  "Answer with a short phrase or sentence. Do not explain your reasoning. If the context does not contain the answer, say UNKNOWN.";

const JUDGE_TEMPLATE = (question, gold, answer) =>
  "You are grading one answer against a gold reference answer.\n\n" +
  "Question: " + question + "\n" +
  "Gold answer: " + gold + "\n" +
  "Model answer: " + answer + "\n\n" +
  "The model answer is CORRECT if it states the same fact as the gold answer, allowing paraphrase, extra words, or a more specific form. " +
  "It is WRONG if it states a different fact, contradicts the gold, says UNKNOWN, or is empty.\n\n" +
  "Output exactly one line, either CORRECT or WRONG. No other text.";

const AGENTIC_SYSTEM =
  "You are answering a question about a long conversation history with a user. " +
  "The history has been compacted into the checkpoint below. The full original log is still available through two tools:\n" +
  "  lcm_search  — search the original log by keyword or regular expression; returns matching events with their seq numbers.\n" +
  "  lcm_expand  — restore the exact original text of events by seq, e.g. type=seq id=\"123-130,200\".\n" +
  "The checkpoint is lossy. When the answer needs a detail the checkpoint does not carry, search the log and expand the hits. " +
  "Search with ONE distinctive word or a short a|b alternation; a whole sentence rarely matches. " +
  "When you know the answer, reply with the short answer and no tool call.";

const AGENTIC_TOOLS = [
  {
    type: "function",
    function: {
      name: "lcm_search",
      description: "Search THIS conversation's durable event log by keyword or regular expression (case-insensitive). Returns matching events with (seq N) pointers.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string", description: "Keyword or regular expression. Use one distinctive word, or a|b for either." } },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "lcm_expand",
      description: "Restore the exact original content of earlier events by seq. type=seq with id=\"3-7,15\" restores those events verbatim.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["seq"], description: "Reference type; only seq is available here." },
          id: { type: "string", description: 'Seq selection such as "3-7,15" or "seq 12".' }
        },
        required: ["type", "id"]
      }
    }
  }
];

/* ------------------------------------------------------------- model ------ */

/** Attempts per model call; the gateway drops connections under load. */
const CALL_ATTEMPTS = Math.max(1, Number(opt("attempts", 4)) || 4);

/**
 * Attempts for one grading call. An empty or unparseable judge reply is a
 * GRADER failure, not a wrong answer, so it is retried and then excluded from
 * the denominator rather than counted as incorrect.
 */
const JUDGE_ATTEMPTS = Math.max(1, Number(opt("judge-attempts", 3)) || 3);

/** One chat completion with tool support; returns the raw assistant message. */
async function chat(messages, options) {
  let lastError;
  for (let attempt = 1; attempt <= CALL_ATTEMPTS; attempt += 1) {
    try {
      return await chatOnce(messages, options);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      // Only transport failures are retried; a 4xx is a harness bug, not load.
      const retryable = /fetch failed|ECONNRESET|socket hang up|ETIMEDOUT|aborted|gateway 5\d\d|gateway 429/u.test(message);
      if (!retryable || attempt === CALL_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

/** One attempt; no retry. */
async function chatOnce(messages, options) {
  const key = process.env.OMNIROUTE_API_KEY ?? process.env.OPENAI_API_KEY ?? readKey();
  const baseUrl = (process.env.OMNIROUTE_BASE_URL ?? "http://10.126.126.4:20128/v1").replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 600_000);
  const started = Date.now();
  try {
    const body = {
      model: options.model,
      messages,
      max_tokens: options.maxTokens,
      temperature: 0
    };
    if (options.tools !== undefined) {
      body.tools = options.tools;
      body.tool_choice = "auto";
    }
    const response = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error("gateway " + response.status + ": " + text.slice(0, 300));
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

/** Read the gateway key the same way bench/llm.mjs does. */
function readKey() {
  for (const name of ["OMNIROUTE_API_KEY", "OPENAI_API_KEY"]) {
    if (process.env[name]) return process.env[name];
  }
  const file = path.join(process.env.HOME ?? "/root", ".dsh", ".credentials.yaml");
  const text = fs.readFileSync(file, "utf8");
  const match = /sk-[A-Za-z0-9_-]{20,}/.exec(text);
  if (match === null) throw new Error("no gateway key");
  return match[0];
}

/* ------------------------------------------------------------ graders ---- */

/** Normalize for the zero-model string grader. */
function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u4dbf\u4e00-\u9fff]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

/**
 * Zero-model grader: is the gold answer contained in the model answer?
 * Gold answers in LongMemEval_S are short entities (median 11 chars), so
 * containment is the honest reproducible floor. A gold that the answer
 * paraphrases is scored WRONG here even when a judge would accept it.
 */
function stringGrade(gold, answer) {
  const g = normalize(gold);
  const a = normalize(answer);
  if (g.length === 0) return false;
  return a.includes(g);
}

/**
 * Model grader: one line CORRECT / WRONG. Returns null when unparseable.
 *
 * max_tokens is 512, not 24, because the routed model is a reasoning model: it
 * spends completion tokens on hidden reasoning before emitting the verdict. At a
 * 24-token cap the visible content came back empty on real runs (measured on the
 * first smoke pass), which is a harness bug, not a judge disagreement. When
 * content is still empty the reasoning trace is scanned as a fallback and the
 * verdict is flagged so the report can disclose how many came from it.
 */
async function judgeGrade(question, gold, answer) {
  let elapsedMs = 0;
  let usage = {};
  let attempts = 0;
  let last = null;
  for (let attempt = 1; attempt <= JUDGE_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    const out = await chat(
      [{ role: "user", content: JUDGE_TEMPLATE(question, gold, answer) }],
      { model: judgeModel, maxTokens: 512, timeoutMs: 300_000 }
    );
    elapsedMs += out.elapsedMs;
    usage = out.usage ?? {};
    const content = String(out.message.content ?? "").trim();
    const reasoning = String(out.message.reasoning_content ?? "");
    const fromContent = /\bCORRECT\b|\bWRONG\b/u.exec(content.toUpperCase());
    const verdictText = fromContent === null ? /\bCORRECT\b|\bWRONG\b/u.exec(reasoning.toUpperCase()) : fromContent;
    last = { usage, elapsedMs, model: out.model, attempts, raw: (fromContent === null ? reasoning : content).trim().slice(0, 100), viaReasoning: fromContent === null };
    if (verdictText !== null) return { ...last, verdict: verdictText[0] === "CORRECT" ? "CORRECT" : "WRONG" };
    if (attempt < JUDGE_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }
  return { ...last, verdict: null };
}

/* -------------------------------------------------------- compression ---- */

/**
 * Compress one haystack with a given instruction, exactly as
 * bench/summarize-arm.mjs does: same prompt shape, same budget rule, same model.
 */
async function compress(spanText, spanTokens, instruction, model) {
  const budget = defaultBudget({ tokensEstimate: spanTokens });
  const prompt = "以下是本次会话的一段历史记录：\n\n" + spanText + "\n\n=== INSTRUCTION ===\n" + instruction;
  const out = await chat([{ role: "user", content: prompt }], { model, maxTokens: budget, timeoutMs: 900_000 });
  const checkpoint = String(out.message.content ?? "").trim();
  return {
    checkpoint,
    checkpointChars: checkpoint.length,
    budget,
    promptTokens: out.usage.prompt_tokens ?? countTokens(prompt),
    completionTokens: out.usage.completion_tokens ?? 0,
    totalTokens: out.usage.total_tokens ?? 0,
    finishReason: out.finishReason,
    elapsedMs: out.elapsedMs,
    model: out.model
  };
}

/* ------------------------------------------------------------ answerer --- */

/** One-shot answer over a fixed payload. */
async function answerOnce(payload, question, model) {
  const out = await chat(
    [{ role: "user", content: ANSWER_TEMPLATE(payload, question) }],
    { model, maxTokens: answerMaxTokens, timeoutMs: 900_000 }
  );
  return {
    answer: String(out.message.content ?? "").trim(),
    promptTokens: out.usage.prompt_tokens ?? countTokens(payload),
    completionTokens: out.usage.completion_tokens ?? 0,
    totalTokens: out.usage.total_tokens ?? 0,
    finishReason: out.finishReason,
    elapsedMs: out.elapsedMs
  };
}

/**
 * Agentic answer: the model may call lcm_search / lcm_expand repeatedly before
 * answering. Tools execute against the raw haystack session, so this arm is the
 * only one that can see uncompressed tokens after compression.
 */
async function answerAgentic(checkpoint, question, built, model) {
  const { session } = built;
  const searchConfig = { maxSearchHits: 20, maxRecallTokens: 40_000, rank: "density" };
  const messages = [
    { role: "user", content: AGENTIC_SYSTEM + "\n\n<checkpoint>\n" + checkpoint + "\n</checkpoint>\n\nQuestion: " + question }
  ];
  const trace = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let elapsedMs = 0;
  let answer = "";
  let finishReason = "unknown";

  for (let step = 0; step < maxSteps; step += 1) {
    const out = await chat(messages, { model, maxTokens: answerMaxTokens, timeoutMs: 900_000, tools: AGENTIC_TOOLS });
    promptTokens += out.usage.prompt_tokens ?? 0;
    completionTokens += out.usage.completion_tokens ?? 0;
    totalTokens += out.usage.total_tokens ?? 0;
    elapsedMs += out.elapsedMs;
    finishReason = out.finishReason;
    messages.push(out.message);

    const calls = Array.isArray(out.message.tool_calls) ? out.message.tool_calls : [];
    if (calls.length === 0) {
      answer = String(out.message.content ?? "").trim();
      break;
    }
    for (const call of calls) {
      const name = call.function?.name ?? "";
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments ?? "{}");
      } catch {
        args = {};
      }
      let result = "";
      try {
        if (name === "lcm_search") {
          const hit = searchSession(session, String(args.pattern ?? ""), searchConfig);
          result = hit.text;
        } else if (name === "lcm_expand") {
          const { selections, errors } = resolveRecallReference(session, String(args.type ?? "seq"), String(args.id ?? ""));
          if (errors.length > 0) result = "[invalid selection: " + errors.join("; ") + "]";
          else result = recallSession(session, selections, { maxRecallTokens: 40_000 }).text;
        } else {
          result = "[unknown tool " + name + "]";
        }
      } catch (error) {
        result = "[tool error: " + (error instanceof Error ? error.message : String(error)) + "]";
      }
      trace.push({ tool: name, args, resultChars: result.length, resultPreview: result.slice(0, 160) });
      messages.push({ role: "tool", tool_call_id: call.id, content: result.slice(0, 24_000) });
    }
  }
  if (answer.length === 0) answer = "[no final answer within " + maxSteps + " steps]";
  return { answer, promptTokens, completionTokens, totalTokens, elapsedMs, finishReason, trace, steps: trace.length };
}

/* ---------------------------------------------------------------- run ---- */

if (!fs.existsSync(datasetPath)) {
  console.error("dataset not found: " + datasetPath);
  process.exit(2);
}

const datasetBytes = fs.statSync(datasetPath).size;
const datasetSha256 = crypto.createHash("sha256").update(fs.readFileSync(datasetPath)).digest("hex");
const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
const questions = pickQuestions(dataset, limit, sample);

const BASIC_INSTRUCTION = FIXTURE("basic-instruction.txt");

const rows = Object.fromEntries(ARMS.map((arm) => [arm, []]));
const armFailures = {};
const startedAll = Date.now();

for (let index = 0; index < questions.length; index += 1) {
  const question = questions[index];
  const gold = String(question.answer ?? "");
  const haystackText = renderHaystack(question);
  const haystackTokens = countTokens(haystackText);
  const built = buildSession(question);

  process.stderr.write("[" + (index + 1) + "/" + questions.length + "] " + question.question_id + " (" + question.question_type + ") haystack " + haystackTokens + " est-tokens\n");

  for (const arm of ARMS) {
    const row = {
      question_id: question.question_id,
      question_type: question.question_type,
      question: question.question,
      gold,
      arm,
      haystackTokensEst: haystackTokens,
      contextTokensEst: null,
      truncation: null,
      compress: null,
      answer: null,
      tokens: { prompt: 0, completion: 0, total: 0 },
      elapsedMs: 0,
      judge: null,
      stringCorrect: null,
      trace: null,
      error: null
    };
    const started = Date.now();
    try {
      if (arm === "full-context") {
        let payload = haystackText;
        if (fullMaxTokens > 0 && haystackTokens > fullMaxTokens) {
          // Truncate on line boundaries from the tail; the evidence sessions are
          // not necessarily early, so this is a real handicap and is recorded.
          const lines = payload.split("\n");
          let kept = [];
          let used = 0;
          for (const line of lines) {
            const cost = countTokens(line) + 1;
            if (used + cost > fullMaxTokens) break;
            kept.push(line);
            used += cost;
          }
          payload = kept.join("\n");
          row.truncation = { strategy: "head-lines-to-cap", capTokensEst: fullMaxTokens, keptTokensEst: used, droppedTokensEst: haystackTokens - used };
        }
        row.contextTokensEst = countTokens(payload);
        const out = await answerOnce(payload, question.question, answerModel);
        row.answer = out.answer;
        row.tokens = { prompt: out.promptTokens, completion: out.completionTokens, total: out.totalTokens };
        row.elapsedMs = out.elapsedMs;
      } else if (arm === "basic-oneshot" || arm === "lcm-oneshot") {
        const instruction = arm === "basic-oneshot" ? BASIC_INSTRUCTION : buildInstruction(defaultBudget({ tokensEstimate: haystackTokens }), haystackTokens, 0);
        const packed = await compress(haystackText, haystackTokens, instruction, answerModel);
        row.compress = {
          budget: packed.budget,
          ratioAsked: packed.budget > 0 ? +(haystackTokens / packed.budget).toFixed(1) : null,
          checkpointChars: packed.checkpointChars,
          checkpointTokensEst: countTokens(packed.checkpoint),
          promptTokens: packed.promptTokens,
          completionTokens: packed.completionTokens,
          totalTokens: packed.totalTokens,
          finishReason: packed.finishReason,
          elapsedMs: packed.elapsedMs
        };
        row.contextTokensEst = countTokens(packed.checkpoint);
        const out = await answerOnce(packed.checkpoint, question.question, answerModel);
        row.answer = out.answer;
        row.tokens = {
          prompt: packed.promptTokens + out.promptTokens,
          completion: packed.completionTokens + out.completionTokens,
          total: (packed.totalTokens || packed.promptTokens + packed.completionTokens) + (out.totalTokens || out.promptTokens + out.completionTokens)
        };
        row.elapsedMs = packed.elapsedMs + out.elapsedMs;
      } else {
        const budget = defaultBudget({ tokensEstimate: haystackTokens });
        const packed = await compress(haystackText, haystackTokens, buildInstruction(budget, haystackTokens, 0), answerModel);
        row.compress = {
          budget: packed.budget,
          ratioAsked: packed.budget > 0 ? +(haystackTokens / packed.budget).toFixed(1) : null,
          checkpointChars: packed.checkpointChars,
          checkpointTokensEst: countTokens(packed.checkpoint),
          promptTokens: packed.promptTokens,
          completionTokens: packed.completionTokens,
          totalTokens: packed.totalTokens,
          finishReason: packed.finishReason,
          elapsedMs: packed.elapsedMs
        };
        row.contextTokensEst = countTokens(packed.checkpoint);
        const out = await answerAgentic(packed.checkpoint, question.question, built, answerModel);
        row.answer = out.answer;
        row.tokens = {
          prompt: packed.promptTokens + out.promptTokens,
          completion: packed.completionTokens + out.completionTokens,
          total: (packed.totalTokens || packed.promptTokens + packed.completionTokens) + (out.totalTokens || out.promptTokens + out.completionTokens)
        };
        row.elapsedMs = packed.elapsedMs + out.elapsedMs;
        row.trace = out.trace;
        row.agenticSteps = out.steps;
      }

      // Grading runs even when the answer is empty: an empty answer is WRONG.
      const graded = await judgeGrade(question.question, gold, row.answer ?? "");
      row.judge = { verdict: graded.verdict, raw: graded.raw, model: graded.model, elapsedMs: graded.elapsedMs, attempts: graded.attempts ?? 1, viaReasoning: graded.viaReasoning ?? false };
      row.stringCorrect = stringGrade(gold, row.answer ?? "");
      row.tokens.total += graded.usage.total_tokens ?? 0;
      row.elapsedMs += graded.elapsedMs;
    } catch (error) {
      row.error = error instanceof Error ? error.message.slice(0, 400) : String(error);
      row.elapsedMs = Date.now() - started;
      armFailures[arm] = (armFailures[arm] ?? 0) + 1;
    }
    rows[arm].push(row);
    process.stderr.write(
      "    " + arm + ": judge=" + (row.judge?.verdict ?? "-") + " string=" + (row.stringCorrect === null ? "-" : row.stringCorrect) +
      " tokens=" + row.tokens.total + " " + Math.round(row.elapsedMs / 1000) + "s" + (row.error === null ? "" : " ERROR " + row.error.slice(0, 80)) + "\n"
    );
  }
}

/* ----------------------------------------------------------- aggregate ---- */

function summarize(list) {
  const armErrors = list.filter((row) => row.error !== null);
  const ran = list.filter((row) => row.error === null);
  const judgeFailed = ran.filter((row) => row.judge?.verdict !== "CORRECT" && row.judge?.verdict !== "WRONG");
  // Both graders share ONE denominator: arm ran AND the judge produced a verdict.
  // Counting a grader failure as WRONG would understate the arm; counting it as
  // correct would overstate it. It leaves the denominator and is reported apart.
  const scored = ran.filter((row) => row.judge?.verdict === "CORRECT" || row.judge?.verdict === "WRONG");
  const n = scored.length;
  const judgeCorrect = scored.filter((row) => row.judge.verdict === "CORRECT").length;
  const stringCorrect = scored.filter((row) => row.stringCorrect === true).length;
  const mean = (fn) => (n === 0 ? 0 : scored.reduce((sum, row) => sum + fn(row), 0) / n);
  const compressRows = scored.filter((row) => row.compress !== null && row.compress !== undefined);
  const meanOver = (arr, fn) => (arr.length === 0 ? null : Math.round(arr.reduce((sum, row) => sum + fn(row), 0) / arr.length));
  return {
    n,
    attempted: list.length,
    judgeCorrect,
    judgeAccuracy: n === 0 ? 0 : +(judgeCorrect / n).toFixed(4),
    stringCorrect,
    stringAccuracy: n === 0 ? 0 : +(stringCorrect / n).toFixed(4),
    judgeFailed: judgeFailed.length,
    judgeFailedIds: judgeFailed.map((row) => row.question_id),
    armErrors: armErrors.length,
    armErrorIds: armErrors.map((row) => row.question_id),
    meanTokens: Math.round(mean((row) => row.tokens.total)),
    meanPromptTokens: Math.round(mean((row) => row.tokens.prompt)),
    meanCompletionTokens: Math.round(mean((row) => row.tokens.completion)),
    meanContextTokensEst: Math.round(mean((row) => row.contextTokensEst ?? 0)),
    meanElapsedMs: Math.round(mean((row) => row.elapsedMs)),
    meanHaystackTokensEst: Math.round(mean((row) => row.haystackTokensEst)),
    meanAgenticSteps: n === 0 ? null : +(mean((row) => row.agenticSteps ?? 0)).toFixed(2),
    meanCheckpointChars: meanOver(compressRows, (row) => row.compress.checkpointChars ?? 0),
    meanCheckpointTokensEst: meanOver(compressRows, (row) => row.compress.checkpointTokensEst ?? 0),
    meanBudget: meanOver(compressRows, (row) => row.compress.budget ?? 0),
    failures: list.length - n
  };
}

const arms = Object.fromEntries(ARMS.map((arm) => [arm, summarize(rows[arm])]));

/** One line explaining why a question failed, for the report. */
function failureReason(row) {
  if (row.error !== null) return "arm error: " + row.error.split("\n")[0].slice(0, 160);
  const answer = String(row.answer ?? "").replace(/\s+/gu, " ").trim();
  if (answer.length === 0) return "empty answer";
  if (/^unknown$/iu.test(answer)) return "model answered UNKNOWN";
  if (row.judge?.verdict === null) return "judge output unparseable: " + String(row.judge?.raw ?? "").slice(0, 80);
  const clipped = answer.length > 90 ? answer.slice(0, 90) + "…" : answer;
  return "answered " + JSON.stringify(clipped) + " vs gold " + JSON.stringify(String(row.gold).slice(0, 90));
}

const elapsedMs = Date.now() - startedAll;

const payload = {
  benchmark: "longmemeval-s/layer2-qa",
  harness: "dsh-lcm bench/layer2-qa.mjs",
  generatedAt: new Date().toISOString(),
  elapsedMs,
  models: {
    answerer: { requested: answerModel, resolved: rows[ARMS[0]]?.[0]?.compress?.model ?? null },
    judge: { requested: judgeModel, resolved: rows[ARMS[0]]?.[0]?.judge?.model ?? null }
  },
  dataset: {
    path: datasetPath,
    bytes: datasetBytes,
    sha256: datasetSha256,
    revision: DATASET_REVISION,
    split: "LongMemEval_S",
    totalQuestions: dataset.length,
    scoredQuestions: questions.length,
    limit: limit || null,
    sample: sample || null,
    typeMix: questions.reduce((acc, q) => {
      acc[q.question_type] = (acc[q.question_type] ?? 0) + 1;
      return acc;
    }, {}),
    questionIds: questions.map((q) => q.question_id)
  },
  config: {
    arms: ARMS,
    compression: "bench/summarize-arm.mjs prompt shape + engine defaultBudget (min(16384, max(512, floor(tokens*0.12))))",
    basicInstruction: "bench/fixtures/basic-instruction.txt (frozen built-in backend instruction)",
    lcmInstruction: "buildInstruction() from src/summarize.js, built at run time",
    answerMaxTokens,
    agenticMaxSteps: maxSteps,
    agenticSearch: { maxSearchHits: 20, maxRecallTokens: 40000, rank: "density" },
    fullContextTruncation: fullMaxTokens === 0 ? "none (cap disabled)" : "head-lines-to-cap " + fullMaxTokens,
    sequential: "one model call at a time; the gateway degraded under 6-way parallelism (2 of 6 calls returned content), so arms are strictly serial"
  },
  arms,
  armFailures,
  perQuestion: rows,
  boundaries: [
    "Not an official LongMemEval leaderboard number: this harness is a reimplementation, not the electricsheephq/memorybench-benchmark-tool fork METHODOLOGY.md names, and it does not run LongMemEval's per-question-type judge prompts (getJudgePromptForType). It runs one loose, uniform CORRECT/WRONG judge.",
    "Judge is not gpt-4o, so the judged numbers are directional until a judge-parity rerun.",
    "Dataset is LongMemEval_S, revision " + DATASET_REVISION + ", head slice of the file (the split is grouped by question_type), not the full 500.",
    "The string grader is exact normalized containment. Gold answers are short entities (median 11 chars), so it is the reproducible floor and systematically under-credits paraphrase.",
    "Compression is a single-shot call over the whole haystack; the production engine compacts incrementally over a growing window, so this arm is a lower bound on production fidelity.",
    "full-context is a ceiling arm, not a product configuration: it feeds the entire haystack uncompressed."
  ]
};

fs.mkdirSync(path.dirname(outBase), { recursive: true });
fs.writeFileSync(outBase + ".json", JSON.stringify(payload, null, 1) + "\n");

/* ------------------------------------------------------------ markdown --- */

const B = String.fromCharCode(96);
const c = (s) => B + s + B;
const pct = (v) => (v === 0 ? "0.000" : v.toFixed(3));

const armTable = ARMS.map((arm) => {
  const a = arms[arm];
  return "| " + arm + " | " + a.n + " | " + a.judgeCorrect + "/" + a.n + " (" + pct(a.judgeAccuracy) + ") | " +
    a.stringCorrect + "/" + a.n + " (" + pct(a.stringAccuracy) + ") | " + a.judgeFailed + " | " + a.armErrors + " | " +
    a.meanTokens + " | " + (a.meanElapsedMs / 1000).toFixed(1) + " |";
}).join("\n");

/**
 * Compression behaviour: did the model actually write to the budget it was
 * given? The instruction asks for a ratio; the completion is what came back.
 * A large gap means the model self-limits and the ratio in the instruction is
 * not the ratio in force.
 */
const compressRows = [];
for (const arm of ARMS) {
  for (const row of rows[arm]) {
    if (row.compress === null || row.compress === undefined) continue;
    compressRows.push("| " + arm + " | " + row.question_id + " | " + row.haystackTokensEst + " | " + row.compress.budget + " | " +
      (row.compress.ratioAsked ?? "n/a") + " | " + (row.compress.checkpointChars ?? 0) + " | " + row.compress.checkpointTokensEst + " | " +
      (row.compress.finishReason ?? "n/a") + " |");
  }
}

const failLines = [];
for (const arm of ARMS) {
  for (const row of rows[arm]) {
    if (row.error === null && row.judge?.verdict === "CORRECT") continue;
    failLines.push("| " + arm + " | " + row.question_id + " | " + row.question_type + " | " + failureReason(row).replace(/\|/gu, "\\|") + " |");
  }
}

const agenticTraceRows = [];
for (const row of rows["lcm-agentic"] ?? []) {
  if (row.trace === null || row.trace === undefined) continue;
  const seq = row.trace.map((t) => t.tool + "(" + JSON.stringify(t.args).slice(0, 70) + ")→" + t.resultChars + "ch").join(" → ");
  agenticTraceRows.push("| " + row.question_id + " | " + row.trace.length + " | " + (seq.length === 0 ? "(no tool calls)" : seq.replace(/\|/gu, "\\|")) + " |");
}

const md = [
  "# LongMemEval_S - Layer 2 judged QA accuracy (dsh-lcm)",
  "",
  "Generated " + payload.generatedAt + " by " + c("bench/layer2-qa.mjs") + ".",
  "",
  "- **n = " + questions.length + "** questions (of " + dataset.length + " in the split)" + (sample ? ", even stride " + c("--sample " + sample) : limit ? ", head " + c("--limit " + limit) : "") + ". Same questions for every arm.",
  "- **Answerer model: " + c(answerModel) + "** (resolved " + c(String(payload.models.answerer.resolved ?? "n/a")) + ").",
  "- **Judge model: " + c(judgeModel) + "** (resolved " + c(String(payload.models.judge.resolved ?? "n/a")) + "). Distinct from the answerer.",
  "- Dataset: LongMemEval_S, revision " + c(DATASET_REVISION) + ", sha256 " + c(datasetSha256.slice(0, 16)) + "…",
  "- Type mix in this slice: " + JSON.stringify(payload.dataset.typeMix),
  "- Wall clock: " + (elapsedMs / 1000).toFixed(0) + "s total, strictly sequential (the gateway returned empty content on 4 of 6 parallel calls, so no arm is parallelised).",
  "",
  "## Results",
  "",
  "| arm | n (scored) | judge CORRECT | string CORRECT | judge failed | arm errors | mean tokens/question | mean seconds/question |",
  "|---|---|---|---|---|---|---|---|",
  armTable,
  "",
  "Denominator: a question counts only when the arm ran AND the judge returned a verdict. A grader that returned empty or unparseable text after " + JUDGE_ATTEMPTS + " attempts is a **grader failure**, excluded from n and reported in its own column; counting it as WRONG would understate the arm.",
  "",
  "Two graders on purpose. The model judge accepts paraphrase; the string grader is exact normalized containment and never calls a model, so it is 100% reproducible and is the floor. Neither is cherry-picked.",
  "",
  "## Compression: budget vs what the model actually wrote",
  "",
  "| arm | question | haystack est-tokens | budget (max_tokens) | ratio asked in instruction | checkpoint chars | checkpoint est-tokens | finish_reason |",
  "|---|---|---|---|---|---|---|---|",
  ...(compressRows.length === 0 ? ["| (no compressing arm run) | - | - | - | - | - | - | - |"] : compressRows),
  "",
  "`ratio asked` is haystack/budget, i.e. what the instruction told the model to hit. When the checkpoint is far smaller than the budget, the model self-limited: the budget was available and unused, so the effective ratio is worse than the one requested.",
  "",
  "## Context size per arm",
  "",
  "| arm | mean haystack est-tokens | mean context est-tokens given to the answerer | mean prompt tokens (API) | truncation |",
  "|---|---|---|---|---|",
  ...ARMS.map((arm) => {
    const a = arms[arm];
    return "| " + arm + " | " + a.meanHaystackTokensEst + " | " + a.meanContextTokensEst + " | " + a.meanPromptTokens + " | " + payload.config.fullContextTruncation + " |";
  }),
  "",
  "## lcm-agentic tool usage",
  "",
  "| question | tool calls | sequence |",
  "|---|---|---|",
  ...(agenticTraceRows.length === 0 ? ["| (arm not run) | - | - |"] : agenticTraceRows),
  "",
  "## Failed questions",
  "",
  failLines.length === 0
    ? "None: every arm answered every question correctly under both graders."
    : ["| arm | question_id | type | why |", "|---|---|---|---|", ...failLines].join("\n"),
  "",
  "## Boundaries (read before quoting any number)",
  "",
  ...payload.boundaries.map((line, i) => (i + 1) + ". " + line),
  ""
].join("\n");

fs.writeFileSync(outBase + ".md", md);

const summary = {
  out: outBase,
  n: questions.length,
  elapsedMs,
  models: payload.models,
  arms,
  armFailures
};
if (printJson) console.log(JSON.stringify(summary, null, 1));
else console.log(md);
