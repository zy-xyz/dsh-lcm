
/**
 * Compress a REAL session log through the real engine, at production size.
 *
 * Every other bench in this repo either sends the compression call itself or uses a
 * synthetic haystack. This one takes an actual \`~/.dsh/sessions\` log, folds it with
 * the harness's own surface, and drives \`LcmCompactionEngine.compile()\` leaf by leaf
 * until the history is covered - which is what production does, and the only way to
 * see the leaf unit's real cost and breadth.
 *
 * Usage: node bench/real-session.mjs <session-dir> [--leaves N] [--live]
 *   without --live it stubs the LLM (offline smoke); with --live it calls the gateway.
 */
import fs from "node:fs";
import zlib from "node:zlib";

import { foldSurface } from "@deepseek-ai/dsh-session/surface";
import { LcmCompactionEngine, resolveConfig } from "../src/index.js";
import { compactSurfaceRegion, selectCompactableRange } from "../src/region.js";
import { estimateEntryTokens } from "../src/compiler.js";
import { deriveDag } from "../src/summarize.js";
import { complete } from "./llm.mjs";

const SURFACE_TYPES = new Set(["system/message", "developer/message", "user/message", "assistant/message", "tool/result"]);

function withMarker(event) {
  const { surfaceOp, sourceEventSeqs, ...rest } = event;
  if (SURFACE_TYPES.has(event.type)) return surfaceOp === undefined ? { ...rest, surfaceOp: "append" } : event;
  return rest;
}

/** Load a persisted session and expose it with the harness's own surface fold. */
function loadSession(dir) {
  const raw = zlib
    .zstdDecompressSync(fs.readFileSync(dir + "/session.v4.jsonl.zstd"))
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const list = raw.filter((e) => Number.isSafeInteger(e.seq)).map(withMarker);
  let generation = 0;
  let signature = "";
  const session = {
    id: "real",
    get events() {
      return list;
    },
    get surface() {
      const folded = foldSurface(list);
      const next = folded.nodes.join(",");
      if (next !== signature) {
        signature = next;
        generation += 1;
      }
      return { nodes: folded.nodes, replaceGeneration: generation };
    },
    eventAt: (seq) => list.find((event) => event.seq === seq),
    deriveEventMessage: (event) => event.message ?? event.data?.message ?? null,
    requestHeader: () => ({ config: { provider: "omniroute", model: "balanced-lite" }, tools: [] }),
    append(type, data, metadata) {
      const event = withMarker({ type, seq: list.length, time: 1_790_000_000_000 + list.length, data, ...(metadata ?? {}) });
      foldSurface([...list, event]);
      list.push(event);
      return event;
    }
  };
  return session;
}

/** Heuristic prices, the same basis the engine's guard uses. */
function meterOver(session) {
  const nodes = session.surface.nodes.map((seq) => {
    const event = session.eventAt(seq);
    const message = event === undefined ? null : session.deriveEventMessage(event);
    const text = message === null ? "" : JSON.stringify(message);
    const tokens = Math.max(1, estimateEntryTokens(text));
    return { seq, tokens, heuristicTokens: tokens };
  });
  return { nodes, totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) };
}

/** An async iterable of harness block events for one completion. */
async function* streamOf(prompt, options) {
  if (options.offline) {
    const text = "## 逐字锚点\n- offline anchor\n## 用户事实\nuser.x = 1 | number\n## 目标与约束\n- offline\n## 已完成\n- offline\n## 未决问题\n- none\n## 下一步\n- offline";
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" }, replayState: undefined };
    return;
  }
  const out = await complete({ prompt, model: "balanced-lite", maxTokens: 32768, timeoutMs: 900000 });
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text: out.content };
  yield { type: "block-end", index: 0, block: { type: "text", text: out.content } };
  yield { type: "finish", reason: { kind: "stop" }, replayState: undefined };
}

const args = process.argv.slice(2);
const dirArg = args[0];
const live = args.includes("--live");
const maxLeaves = Number((args.find((a) => a.startsWith("--leaves=")) ?? "--leaves=40").split("=")[1]);

const session = loadSession(dirArg);
const config = resolveConfig({ summaryRatio: 0.12, summaryFloorTokens: 512, checkpointCap: 16384, leafSpanTokens: 24000, condensationFanin: 4 });
const engine = Object.create(LcmCompactionEngine.prototype);
engine.config = config;
engine.stallBySession = new Map();
engine.ctx = { llm: { stream: (options) => streamOf(options.messages.at(-1).content[0].text, { offline: !live }) } };

const initial = meterOver(session);
console.log(JSON.stringify({ phase: "loaded", events: session.events.length, surfaceNodes: session.surface.nodes.length, surfaceTokens: initial.totalTokens, leaves: 0 }));

let commits = 0;
const leaves = [];
for (let index = 0; index < maxLeaves; index += 1) {
  const measurement = meterOver(session);
  const range = selectCompactableRange(session, measurement, 16000, 512, config.leafSpanTokens, config.condensationFanin);
  if (range === null) break;
  const before = session.events.length;
  const deps = {
    meter: {
      measure: () => meterOver(session),
      estimateMessage: (message) => estimateEntryTokens(JSON.stringify(message))
    },
    compile: (prepared, agent) => engine.compile(prepared, agent, undefined)
  };
  let result;
  try {
    result = await compactSurfaceRegion(deps, session, range.start, range.end, { session }, { owner: null, stability: "selected-span" });
  } catch (error) {
    console.log(JSON.stringify({ phase: "stop", reason: String(error.message).slice(0, 200) }));
    break;
  }
  commits += 1;
  const summary = session.events.filter((e) => e.type === "compaction/summary").at(-1);
  leaves.push({
    span: summary?.data?.shadowedTokenCount ?? null,
    kept: summary?.data?.maxTokens ?? null,
    nodes: (summary?.data?.shadowedSeqs ?? []).length
  });
  console.log(JSON.stringify({ phase: "leaf", index: commits, events: before, span: leaves.at(-1).span, kept: leaves.at(-1).kept, nodes: leaves.at(-1).nodes }));
}

const dag = deriveDag(session);
const onSurface = session.surface.nodes.filter((seq) => dag.nodeBySeq.has(seq));
const depths = onSurface.map((seq) => dag.nodeBySeq.get(seq).depth);
const final = meterOver(session);
console.log(
  JSON.stringify({
    phase: "done",
    commits,
    leaves: leaves.length,
    spans: leaves.map((l) => l.span),
    kevt: leaves.map((l) => l.kept),
    checkpointsOnSurface: onSurface.length,
    positionalDepths: depths,
    maxDepth: dag.maxDepth,
    surfaceTokensAfter: final.totalTokens,
    tokensShadowed: leaves.reduce((sum, l) => sum + (l.span ?? 0), 0),
    tokensKept: leaves.reduce((sum, l) => sum + (l.kept ?? 0), 0)
  })
);
