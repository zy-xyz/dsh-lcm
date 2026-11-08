/**
 * Drive the REAL engine to compress a haystack into one checkpoint.
 *
 * Every other benchmark in `bench/` compresses by prompting a model itself, so
 * the numbers they report validate the PROMPT and the RETRIEVAL — not the engine.
 * Nothing measured the structural machinery that actually decides what a live
 * session gets: the leaf chunking (`leafSpanTokens`), the escalation ladder in
 * `compile()`, the same-depth condensation (`condensationFanin`), or the shrink
 * guarantee in the region transaction.
 *
 * This module drives that machinery. It builds a real `Session` from a haystack,
 * a real `TokenMeter`, and a real `LcmCompactionEngine`, then repeats the exact
 * selection + transaction pair the automatic path performs
 * (`selectCompactableRange` → `engine.compactRegion`) until nothing is left to
 * select. That is how the engine reaches a 436k-token history through 19 leaves:
 * one bounded leaf at a time, then a condensation once four same-depth siblings
 * exist.
 *
 * Entry point choice: the real `LcmCompactionEngine` on a real Cordis `Context`,
 * not a direct `summarizeLeaf` call. `compile()` is where the escalation ladder
 * lives (empty response → deterministic body, oversize body → aggressive retry →
 * deterministic truncation) and `regionDependencies()` is the only place the
 * meter/compile/recover triple is assembled the way production assembles it.
 * Calling the summarizer directly would measure a different engine than the one
 * that ships. Only the LLM transport is bridged, to `bench/llm.mjs`'s `complete`.
 *
 * @module bench/engine-compress
 */
import fs from "node:fs";

import { Context } from "@deepseek-ai/cordis";
import { createAssistantMessage, createSystemMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { Session } from "@deepseek-ai/dsh-session";
import { TokenMeter } from "@deepseek-ai/dsh-token-meter";

import { LcmCompactionEngine } from "../src/index.js";
import { selectCompactableRange } from "../src/region.js";
import { deriveDag } from "../src/summarize.js";
import { projectMessageText } from "../src/compiler.js";
import { complete as defaultComplete } from "./llm.mjs";

/** Fixed clock so a seeded log is byte-stable across runs. */
const T0 = 1_790_000_000_000;

/** Route the seeded `request/header` records, so summarizer routing is real. */
const DEFAULT_PROVIDER = "bench-provider";
const DEFAULT_MODEL = "bench-model";

/** What the offline self-test "model" returns. Contains one anchor of the span. */
const SELFTEST_SUMMARY = [
  "## 逐字锚点",
  "- alpha-1",
  "- beta-2",
  "## 用户事实",
  "- user.needle = alpha-1 | fact",
  "## 目标与约束",
  "- compress the span",
  "## 已完成",
  "- seeded haystack",
  "## 未决问题",
  "- none",
  "## 下一步",
  "- continue"
].join("\n");

/** Normalize one haystack message body into LLM content blocks. */
function contentBlocks(content) {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/**
 * Turn a haystack into a contiguous, surface-valid session log.
 *
 * A haystack is a list of sessions, each a list of `{ role, content }`. The
 * mapping is the harness's own event vocabulary: `system` → `system/message`,
 * `assistant` → `assistant/message` (with the settlement fields a real session
 * requires), anything else → `user/message`. The whole haystack lands inside ONE
 * open turn, which is the shape automatic compaction runs in.
 * @param haystack - list of sessions, or of `{ messages }` records.
 * @param provider - provider recorded on the seeded request header and messages.
 * @param model - model recorded on the seeded request header and messages.
 * @returns borrowed seed events, seqs 0..n-1.
 */
export function seedFromHaystack(haystack, provider = DEFAULT_PROVIDER, model = DEFAULT_MODEL) {
  const seed = [];
  let seq = 0;
  const push = (event) => {
    seed.push({ ...event, seq, time: T0 + seq });
    seq += 1;
  };
  push({ type: "system/message", data: { message: createSystemMessage("bench haystack: compress this history") }, surfaceOp: "append" });
  // An empty tool list is rejected by the real validator; a tool-less header omits it.
  push({ type: "request/header", data: { header: { config: { provider, model } }, reason: "initial" } });
  // One open turn around the whole haystack: `compactRegion` (the automatic path)
  // requires an open turn, and this is the shape it sees in production.
  push({ type: "turn/start", data: { turn: 1 } });
  let turn = 1;
  for (const entry of haystack) {
    const messages = Array.isArray(entry) ? entry : entry.messages;
    let step = 0;
    for (const message of messages) {
      const content = contentBlocks(message.content);
      if (message.role === "system") {
        push({ type: "system/message", data: { message: createSystemMessage(content.map((block) => block.text ?? "").join("\n")) }, surfaceOp: "append" });
      } else if (message.role === "assistant") {
        // The token meter's measurement projection requires every assistant
        // message to sit inside a step whose turn/step match its own settlement
        // fields, so a step is opened for each one.
        step += 1;
        push({ type: "step/start", data: { turn, step } });
        push({
          type: "assistant/message",
          data: {
            message: createAssistantMessage({ content, source: { kind: "model", provider, model } }),
            turn,
            step,
            // The real settlement shape: a compacted stream record; empty is valid.
            stream: []
          },
          surfaceOp: "append"
        });
        push({ type: "step/end", data: { turn, step } });
      } else {
        push({ type: "user/message", data: createUserMessage({ content, source: { kind: "user" } }), surfaceOp: "append" });
      }
    }
    turn += 1;
  }
  return seed;
}

/** Render the request the engine built into the single prompt `complete` accepts. */
function renderPrompt(messages) {
  return messages.map((message) => "[" + message.role + "]\n" + projectMessageText(message)).join("\n\n");
}

/**
 * Bridge one `ctx.llm.stream` request to a `complete`-shaped function.
 *
 * The engine replays the shadowed span verbatim and appends the instruction, so
 * the prompt is exactly what the summarizer would have sent; only the transport
 * differs. Chunks are emitted in the harness protocol so the engine's own
 * `BlockAssembler` parses them, which is the same path a real provider takes.
 */
async function* bridgeStream(complete, request, options) {
  const result = await complete({
    prompt: renderPrompt(options.messages),
    maxTokens: options.maxTokens,
    ...request
  });
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text: result.content };
  yield { type: "block-end", index: 0, block: { type: "text", text: result.content } };
  yield { type: "finish", reason: { kind: "stop" }, replayState: undefined };
}

/**
 * Compress one haystack with the real engine.
 * @param haystack - list of sessions, each a list of `{ role, content }`.
 * @param options - `{ complete, request, config, retainTokens, maxCompactions,
 *   provider, model, signal }`.
 *   `complete` is a `bench/llm.mjs`-shaped function (prompt in, text out);
 *   `request` is forwarded to it (model, baseUrl, timeoutMs, temperature);
 *   `config` overrides the engine configuration (e.g. `leafSpanTokens`);
 *   `maxCompactions` bounds the loop (default: unbounded — the loop ends when no
 *   range is selectable).
 * @returns `{ checkpointText, calls, compactions, leaves }`:
 *   `checkpointText` is every checkpoint node on the final surface in surface
 *   order — that IS the assembled compressed history;
 *   `calls` is the number of summarizer requests actually issued;
 *   `compactions` is the number of committed transactions;
 *   `leaves` is how many of those produced a depth-1 leaf (absorbed no earlier
 *   checkpoint), so `compactions - leaves` is the condensation count.
 */
export async function compressHaystack(haystack, options = {}) {
  const {
    complete = defaultComplete,
    request = {},
    config = {},
    retainTokens = 0,
    maxCompactions = Number.POSITIVE_INFINITY,
    provider = DEFAULT_PROVIDER,
    model = DEFAULT_MODEL,
    signal
  } = options;

  const session = Session.create("bench-engine-compress", seedFromHaystack(haystack, provider, model));
  const ctx = new Context();
  let calls = 0;
  ctx.provide("llm");
  ctx.set("llm", {
    stream(options_) {
      calls += 1;
      return bridgeStream(complete, request, options_);
    },
    imageRequestPricing() {
      return undefined;
    }
  });
  const meter = new TokenMeter(ctx, {});
  const engine = new LcmCompactionEngine(ctx, { auto: false, summarizationProvider: provider, summarizationModel: model, ...config });
  const agent = { session, options: { provider, model } };

  let compactions = 0;
  let leaves = 0;
  while (compactions < maxCompactions) {
    // The automatic path's own selection: retain tail, span floor, leaf ceiling,
    // condensation fanin — all from the resolved engine configuration.
    const measurement = meter.measure(session);
    const range = selectCompactableRange(
      session,
      measurement,
      retainTokens,
      engine.config.summaryFloorTokens,
      engine.config.leafSpanTokens,
      engine.config.condensationFanin
    );
    if (range === null) break;
    const checkpointBefore = deriveDag(session).nodeBySeq;
    const result = await engine.compactRegion(range.start, range.end, agent, signal);
    compactions += 1;
    if (result.shadowedSeqs.every((seq) => !checkpointBefore.has(seq))) leaves += 1;
  }

  const dag = deriveDag(session);
  const checkpointText = session.surface.nodes
    .filter((seq) => dag.nodeBySeq.has(seq))
    .map((seq) => projectMessageText(session.deriveEventMessage(session.eventAt(seq))))
    .join("\n\n");
  return { checkpointText, calls, compactions, leaves };
}

/** A tiny synthetic haystack: enough tokens to pass the span floor, no network. */
function selftestHaystack() {
  const haystack = [];
  for (let session = 1; session <= 4; session += 1) {
    const messages = [];
    for (let turn = 1; turn <= 2; turn += 1) {
      messages.push({ role: "user", content: "session " + session + " turn " + turn + " alpha-" + turn + " " + "x".repeat(1200) });
      messages.push({ role: "assistant", content: "ack " + session + "." + turn + " beta-" + turn + " " + "y".repeat(1200) });
    }
    haystack.push(messages);
  }
  return haystack;
}

// CLI:
//   node bench/engine-compress.mjs --selftest        offline smoke check, no network
//   node bench/engine-compress.mjs haystack.json     real model; cost to stderr, checkpoint to stdout
if (process.argv[1]?.endsWith("engine-compress.mjs")) {
  const arg = process.argv[2];
  if (arg === "--selftest") {
    const out = await compressHaystack(selftestHaystack(), {
      complete: async () => ({ content: SELFTEST_SUMMARY }),
      maxCompactions: 1
    });
    console.error(JSON.stringify({ calls: out.calls, compactions: out.compactions, leaves: out.leaves }));
    console.log(out.checkpointText);
  } else if (arg === undefined) {
    console.error("usage: node bench/engine-compress.mjs --selftest | <haystack.json>");
    process.exitCode = 2;
  } else {
    const haystack = JSON.parse(fs.readFileSync(arg, "utf8"));
    const out = await compressHaystack(haystack, {
      request: { model: process.env.BENCH_MODEL, timeoutMs: 600_000 }
    });
    console.error(
      JSON.stringify({ calls: out.calls, compactions: out.compactions, leaves: out.leaves, checkpointChars: out.checkpointText.length })
    );
    console.log(out.checkpointText);
  }
}
