#!/usr/bin/env node
// bench/qa-eval.mjs — 压缩后模型还能不能答对（端到端判分）
//
// 现有 bench 只能回答“摘要带了多少锚点”（保留率/召回率），回答不了真问题：
// 拿摘要去问模型，它还能不能把那些逐字事实答对。本脚本补上这一层。
//
// 设计要点：
//   1. 出题只用锚点本身 + 模板，不调模型；问题文本里不得出现答案（硬校验）。
//   2. 答题阶段只给 <summary> + 问题，**不给** span.text —— 那才是“压缩后”。
//   3. 判分是纯字符串包含，大小写敏感、零模糊匹配，可复现。
//   4. 脚本内部不调模型（普通 node 进程没有 MCP 工具）：构造 prompt 与判分
//      都导出为纯函数，CLI 只负责读文件/写文件。
//
// CLI：
//   node bench/qa-eval.mjs <span.json> <summary.txt> [--n 8]
//       → 出题并渲染 prompt，prompt 落 /tmp/qa-prompt.txt，stdout 打题目 JSON
//   node bench/qa-eval.mjs --grade <span.json> <answerfile> [--n 8]
//       → 只判分：原始回答落 /tmp/qa-raw.txt，stdout 打判分 JSON
//
// 导出：
//   buildPrompts(span, n = 8, summary = "") -> { questions, prompt }
//   grade(span, questions, answerText)      -> { span, n, answered, correct, rate, perQuestion }
//   selectAnchors(span, n) / classifyAnchor(value) / safeHint(text, anchor)
//   parseAnswers(text) / renderPrompt(summary, questions) / spanLabel(span)
//
// @module bench/qa-eval

import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// 锚点类型识别
//
// span.json 的 canaries 是纯字符串（bench/span.mjs 里 .map(a => a.value)），
// 类型信息被丢掉了，所以这里按 bench/anchors.mjs 的同一套 pattern 反推。
// 顺序即优先级：path → uuid → hex → env → error → number → command。
// ---------------------------------------------------------------------------
const TYPE_PATTERNS = [
  ["path", [
    /^\/vol\d+\/[\w.\/-]+$/,
    /^\/[\w.-]+\/[\w.-]+\/[\w.\/-]+\.(?:img|sh|py|md|json|yaml|yml|txt|log|db|patch|diff)$/
  ]],
  ["uuid", [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/]],
  ["hex", [/^0x[0-9a-fA-F]{8,}$/]],
  ["env", [/^[A-Z][A-Z0-9_]{3,}_[A-Z0-9_]{2,}$/]],
  ["error", [/^(?:Error|ERROR|error|failed|FAILED|cannot|refusing)[^\n]{10,70}$/]],
  ["number", [/^\d{2,}(?:\.\d+)?(?:ms|s|KB|MB|GB|B|bytes|tok|tokens)$/]],
  ["command", [/^(?:adb|git|pnpm|npm|node|python3|curl|ffmpeg|ditto|hdiutil|qemu-system-[a-z0-9]+)\s+[^\n]{4,60}$/]]
];

/**
 * 判断一个锚点字符串属于哪一类。
 * @param {string} value 锚点原文
 * @returns {string} 类型名，未知归 "other"
 */
export function classifyAnchor(value) {
  const text = String(value ?? "").trim();
  for (const [type, patterns] of TYPE_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(text))) return type;
  }
  return "other";
}

// ---------------------------------------------------------------------------
// 题目模板（按类型）
//
// 模板只有静态描述 + 一个经过防泄题过滤的上下文提示词（safeHint）。
// 模板本身绝不引用锚点。
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "was", "were", "has",
  "have", "into", "then", "than", "but", "not", "you", "all", "any", "its",
  "our", "are", "will", "would", "should", "could", "there", "here", "when"
]);

/** 把提示词拼成括号片段；空提示词返回空串，问题仍然自洽。 */
function hintSuffix(hint) {
  return hint ? ' near "' + hint + '"' : "";
}

const TEMPLATES = {
  path: (hint) =>
    "What exact absolute file path appeared in the log" + hintSuffix(hint) +
    "? Quote it verbatim, character for character.",
  uuid: (hint) =>
    "What exact UUID (8-4-4-4-12 hex grouping) appeared in the log" + hintSuffix(hint) +
    "? Quote it verbatim, including every hyphen.",
  hex: (hint) =>
    "What exact hexadecimal value (0x... form) appeared in the log" + hintSuffix(hint) +
    "? Quote it verbatim, keeping the digits exactly as written.",
  env: (hint) =>
    "What exact environment-variable name appeared in the log" + hintSuffix(hint) +
    "? Quote it verbatim, in uppercase as written.",
  error: (hint) =>
    "What was the exact error or failure text" + hintSuffix(hint) +
    "? Quote the whole message verbatim.",
  number: (hint) =>
    "What exact number with its unit appeared in the log" + hintSuffix(hint) +
    "? Quote it verbatim, digits and unit together.",
  command: (hint) =>
    "What exact command line was run" + hintSuffix(hint) +
    "? Quote it verbatim, including all flags.",
  other: (hint) =>
    "Which exact literal string appeared in the log" + hintSuffix(hint) +
    "? Quote it verbatim."
};

/**
 * 取锚点所在行、锚点**左侧**的词做位置提示。
 *
 * 只往左取：右侧常常是答案的延续（"boot 0x0000ffaa1b2c3d4e loaded" 里右侧就是
 * 别的锚点），跨行取更会把邻居锚点的片段当成提示，既误导又疑似泄题。
 *
 * 过滤：停用词 / 含两位以上数字（数字碎片会泄 number、hex、路径题）/ 被任何
 * canary 包含（泄别的题）/ 与锚点互为子串（泄本题）。全被滤掉就返回空串，
 * 宁可问题更泛也不许抄答案。
 *
 * @param {string} spanText 原始跨度文本
 * @param {string} anchor 锚点原文
 * @param {string[]} forbidden 全部 canary（作为禁用词表）
 * @returns {string} 安全提示词，取不到时为空串
 */
export function safeHint(spanText, anchor, forbidden = []) {
  if (typeof spanText !== "string" || spanText.length === 0) return "";
  const at = spanText.indexOf(anchor);
  if (at < 0) return "";
  const lineStart = spanText.lastIndexOf("\n", at) + 1;
  const before = spanText.slice(lineStart, at);
  const tokens = before.match(/[A-Za-z][A-Za-z0-9_.-]{2,24}/g) ?? [];
  const lowerAnchor = anchor.toLowerCase();
  const blocked = (Array.isArray(forbidden) ? forbidden : [])
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length >= 4);
  const kept = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (STOPWORDS.has(lower)) continue;                 // 停用词没有区分度
    if (/\d{2,}/.test(token)) continue;                 // 数字碎片会泄数字/路径题
    if (lowerAnchor.includes(lower)) continue;          // 词是答案的一部分 → 泄题
    if (anchor.includes(token)) continue;               // 字面包含 → 泄题
    if (blocked.some((value) => value.includes(token))) continue; // 是别的答案的片段
    kept.push(token);
  }
  const hint = kept.slice(-3).join(" ");
  return hint.length > 48 ? hint.slice(0, 48) : hint;
}

// ---------------------------------------------------------------------------
// 选题：确定性、按类型轮转（同 bench/anchors.mjs 的平衡逻辑，不随机）
// ---------------------------------------------------------------------------

/**
 * 按类型轮转挑选 n 条锚点。同一份 span 多次运行结果完全一致。
 * @param {object} span bench/span.mjs 的产出
 * @param {number} n 想出的题数
 * @returns {{value: string, type: string}[]}
 */
export function selectAnchors(span, n = 8) {
  const raw = Array.isArray(span?.canaries) ? span.canaries : [];
  const seen = new Set();
  const entries = [];
  for (const item of raw) {
    // 兼容两种形状：纯字符串（当前 span.mjs）与 {value,type}（未来扩展）
    const value = typeof item === "string" ? item : String(item?.value ?? "");
    const trimmed = value.trim();
    if (trimmed.length < 4) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    const type = typeof item === "object" && item?.type
      ? String(item.type)
      : classifyAnchor(trimmed);
    entries.push({ value: trimmed, type });
  }
  const buckets = new Map();
  for (const entry of entries) {
    if (!buckets.has(entry.type)) buckets.set(entry.type, []);
    buckets.get(entry.type).push(entry);
  }
  const order = [...buckets.keys()].sort();
  const picked = [];
  for (let round = 0; picked.length < n; round += 1) {
    let added = false;
    for (const type of order) {
      if (picked.length >= n) break;
      const bucket = buckets.get(type);
      if (bucket.length === 0) continue;
      picked.push(bucket.shift());
      added = true;
    }
    if (!added) break;
  }
  return picked;
}

// ---------------------------------------------------------------------------
// 出题
// ---------------------------------------------------------------------------

/**
 * 构造题目与答题 prompt。
 *
 * @param {object} span bench/span.mjs 的产出（canaries / text / tokensEstimate）
 * @param {number} n 题数
 * @param {string} summary 摘要文本；为空则只出题、prompt 为空串
 * @returns {{questions: {type: string, anchor: string, question: string}[], prompt: string}}
 */
export function buildPrompts(span, n = 8, summary = "") {
  const selected = selectAnchors(span, Math.max(1, Number(n) || 1));
  const forbidden = Array.isArray(span?.canaries)
    ? span.canaries.map((item) => (typeof item === "string" ? item : String(item?.value ?? "")))
    : [];
  const questions = [];
  for (const entry of selected) {
    const hint = safeHint(span?.text, entry.value, forbidden);
    let question = TEMPLATES[entry.type](hint);
    // 硬校验：问题里不得出现答案本身；带提示会泄题就退回无提示版本
    if (question.includes(entry.value)) question = TEMPLATES[entry.type]("");
    if (question.includes(entry.value)) continue; // 仍泄题则丢弃该题
    questions.push({ type: entry.type, anchor: entry.value, question });
  }
  return { questions, prompt: renderPrompt(summary, questions) };
}

/**
 * 渲染“摘要 + 问题”的答题 prompt。只给摘要，不给 span.text。
 * @param {string} summary 摘要文本
 * @param {{question: string}[]} questions 题目
 * @returns {string}
 */
export function renderPrompt(summary, questions) {
  if (!Array.isArray(questions) || questions.length === 0) return "";
  const lines = [];
  lines.push("You are given a compaction summary of an earlier conversation. The original conversation is NOT available.");
  lines.push("Answer each question using ONLY the summary below.");
  lines.push("If the summary does not contain the requested value, answer UNKNOWN for that question.");
  lines.push("Reply with exactly one line per question and nothing else, in this format:");
  lines.push("Q<i>: <answer>");
  lines.push("");
  lines.push("<summary>");
  lines.push(String(summary ?? "").trim());
  lines.push("</summary>");
  lines.push("");
  lines.push("Questions:");
  questions.forEach((question, index) => {
    lines.push("Q" + (index + 1) + ": " + question.question);
  });
  lines.push("");
  lines.push("Answers:");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 判分
// ---------------------------------------------------------------------------

/**
 * 解析 Q<i>: <answer> 形式的多行回答；续行并入上一条答案。
 * @param {string} text 模型原始回答
 * @returns {Map<number, string>} 题号（1 起）→ 答案
 */
export function parseAnswers(text) {
  const answers = new Map();
  let current = 0;
  for (const line of String(text ?? "").split("\n")) {
    const match = /^\s*Q\s*(\d+)\s*[:：]\s*(.*)$/i.exec(line);
    if (match) {
      current = Number(match[1]);
      answers.set(current, match[2].trim());
      continue;
    }
    if (current > 0 && line.trim().length > 0) {
      answers.set(current, (answers.get(current) ?? "") + " " + line.trim());
    }
  }
  for (const [key, value] of answers) answers.set(key, value.trim());
  return answers;
}

/** span 的可读标识：优先 spanSource（如 "compaction c0024"），其次源文件。 */
export function spanLabel(span, fallback = null) {
  if (!span || typeof span !== "object") return fallback;
  const source = span.spanSource ? String(span.spanSource) : "";
  const file = span.source ? String(span.source) : "";
  if (source && file) return source + " | " + file;
  return source || file || fallback;
}

/**
 * 判分。纯字符串包含：答案里出现该锚点即算对，大小写敏感，不做模糊匹配。
 *
 * rate = correct / n（未作答按错计，端到端口径；作答覆盖率单独看 answered）。
 *
 * @param {object} span bench/span.mjs 的产出（只用来输出标识）
 * @param {{type: string, anchor: string, question: string}[]} questions 题目
 * @param {string} answerText 模型原始回答
 * @returns {{span: string|null, n: number, answered: number, correct: number, rate: number, perQuestion: object[]}}
 */
export function grade(span, questions, answerText) {
  const list = Array.isArray(questions) ? questions : (questions?.questions ?? []);
  const answers = parseAnswers(answerText);
  const perQuestion = [];
  let correct = 0;
  let answered = 0;
  list.forEach((item, index) => {
    const answer = answers.get(index + 1) ?? "";
    const hasAnswer = answer.length > 0;
    if (hasAnswer) answered += 1;
    const pass = hasAnswer && answer.includes(item.anchor);
    if (pass) correct += 1;
    perQuestion.push({
      type: item.type,
      anchor: item.anchor,
      question: item.question,
      answer,
      pass
    });
  });
  const n = list.length;
  return {
    span: spanLabel(span),
    n,
    answered,
    correct,
    rate: n === 0 ? 0 : Number((correct / n).toFixed(4)),
    perQuestion
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

/** 出题阶段落盘的题目缓存；判分阶段复用它，避免两次 --n 不一致造成题号错位。 */
const QUESTIONS_FILE = "/tmp/qa-questions.json";

/**
 * 判分用哪份题目：优先缓存（同一份 span），否则按 span + n 确定性重算。
 * @param {object} span span.json
 * @param {number} n 题数
 * @param {string} spanFile span.json 路径（仅用于日志）
 * @returns {object[]}
 */
function resolveQuestions(span, n, spanFile) {
  try {
    const cached = JSON.parse(fs.readFileSync(QUESTIONS_FILE, "utf8"));
    if (Array.isArray(cached?.questions) && cached.questions.length > 0) {
      const label = spanLabel(span, spanFile);
      if (!cached.span || !label || cached.span === label) {
        console.error("[qa-eval] 题目来源：" + QUESTIONS_FILE + "（" + cached.questions.length + " 题）");
        return cached.questions;
      }
      console.error("[qa-eval] " + QUESTIONS_FILE + " 属于另一份 span，忽略");
    }
  } catch {
    // 没有缓存就按确定性规则重算
  }
  const { questions } = buildPrompts(span, n);
  console.error("[qa-eval] 题目来源：按 span + --n=" + n + " 重算（" + questions.length + " 题）");
  return questions;
}

function main(argv) {
  const args = argv.slice(2);
  const option = (key, fallback) => {
    const index = args.indexOf("--" + key);
    return index >= 0 ? (args[index + 1] ?? true) : fallback;
  };
  const n = Number(option("n", 8)) || 8;
  const gradeMode = args.includes("--grade");
  // 位置参数：跳过 --flag 与 --n 的值
  const positional = args.filter((arg, index) => {
    if (arg.startsWith("--")) return false;
    return args[index - 1] !== "--n";
  });

  if (gradeMode) {
    const [spanFile, answerFile] = positional;
    if (!spanFile || !answerFile) {
      console.error("usage: node bench/qa-eval.mjs --grade <span.json> <answerfile> [--n 8]");
      process.exit(2);
    }
    const span = readJson(spanFile);
    const answerText = readText(answerFile);
    fs.writeFileSync("/tmp/qa-raw.txt", answerText);
    const questions = resolveQuestions(span, n, spanFile);
    console.log(JSON.stringify(grade(span, questions, answerText), null, 1));
    return;
  }

  const [spanFile, summaryFile] = positional;
  if (!spanFile || !summaryFile) {
    console.error("usage: node bench/qa-eval.mjs <span.json> <summary.txt> [--n 8]");
    console.error("       node bench/qa-eval.mjs --grade <span.json> <answerfile> [--n 8]");
    process.exit(2);
  }
  const span = readJson(spanFile);
  const summary = readText(summaryFile);
  const { questions, prompt } = buildPrompts(span, n, summary);
  const label = spanLabel(span, spanFile);
  fs.writeFileSync("/tmp/qa-prompt.txt", prompt);
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify({ span: label, n: questions.length, questions }, null, 1));
  console.log(JSON.stringify({
    span: label,
    n: questions.length,
    tokensEstimate: span?.tokensEstimate ?? null,
    promptFile: "/tmp/qa-prompt.txt",
    questionsFile: QUESTIONS_FILE,
    answerHint: "answer one line per question: Q<i>: <answer>, then run --grade",
    questions
  }, null, 1));
}

// 只在被直接执行时跑 CLI，被 import（单测）时不跑。
const invokedDirectly = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main(process.argv);
