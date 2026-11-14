/**
 * Pure analysis over a session log. No I/O, no clock, no config.
 *
 * Everything here answers one question: what did the compaction engine actually
 * do to this session? The log is the only source — `compaction/summary` events
 * record the span each checkpoint replaced and the body it kept, so the whole
 * history is reconstructable without asking the engine anything.
 *
 * Two numbers are estimates and are labelled as such wherever they surface:
 * a checkpoint body's token count (chars / 3.9, the ratio measured against the
 * engine's own meter) and anything derived from it. The span is NOT an estimate:
 * `shadowedTokenCount` is what the engine recorded when it priced the range.
 *
 * @module dsh-lcm/insight
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

/** Chars per token, measured against `dsh-token-meter` on real checkpoint bodies. */
const CHARS_PER_TOKEN = 3.9;

/** A checkpoint body that came from the deterministic rung, not from a model. */
const FALLBACK_MARKER = "DETERMINISTIC";

/**
 * Estimated token count of a block list or string.
 * @param value - summary blocks or raw text.
 * @returns the estimate, never negative.
 */
export function estimateTokens(value) {
  const text = typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map((block) => block?.text ?? "").join("")
      : "";
  return Math.round(text.length / CHARS_PER_TOKEN);
}

/** @param event - a session event. @returns true when it is a stored checkpoint. */
export function isCheckpoint(event) {
  return event?.type === "compaction/summary";
}

/**
 * Rebuild each checkpoint's DAG depth from what it absorbed.
 *
 * A leaf absorbs raw messages and sits at depth 1. A condensation absorbs other
 * checkpoints and sits one below the deepest of them. That is the whole rule the
 * engine's own `deriveDag` encodes, computed here from the log alone so the
 * panel does not depend on importing the engine.
 * @param events - the session log in seq order.
 * @returns a map from checkpoint seq to depth.
 */
export function checkpointDepths(events) {
  const depths = new Map();
  const checkpointSeqs = new Set(events.filter(isCheckpoint).map((event) => event.seq));
  for (const event of events) {
    if (!isCheckpoint(event)) continue;
    const absorbed = (event.data?.shadowedSeqs ?? []).filter((seq) => checkpointSeqs.has(seq));
    if (absorbed.length === 0) {
      depths.set(event.seq, 1);
      continue;
    }
    let deepest = 0;
    for (const seq of absorbed) deepest = Math.max(deepest, depths.get(seq) ?? 1);
    depths.set(event.seq, deepest + 1);
  }
  return depths;
}

/**
 * One row per stored checkpoint, in log order.
 * @param events - the session log.
 * @returns `[{ seq, at, span, kept, nodes, cap, depth, fallback, model, anchors }]`.
 */
export function checkpointRows(events) {
  const depths = checkpointDepths(events);
  const rows = [];
  for (const event of events) {
    if (!isCheckpoint(event)) continue;
    const body = event.data?.summary ?? [];
    const text = body.map((block) => block?.text ?? "").join("");
    rows.push({
      seq: event.seq,
      at: typeof event.time === "number" ? event.time : null,
      span: event.data?.shadowedTokenCount ?? 0,
      kept: estimateTokens(text),
      nodes: (event.data?.shadowedSeqs ?? []).length,
      cap: event.data?.maxTokens ?? null,
      depth: depths.get(event.seq) ?? 1,
      fallback: text.includes(FALLBACK_MARKER),
      model: event.data?.model ?? null,
      anchors: (text.match(/\(seq \d+\)/gu) ?? []).length
    });
  }
  return rows;
}

/**
 * Totals and quality signals over one session's checkpoints.
 *
 * The ratio is the one the engine's own /lcm-status reports: shadowed tokens per
 * kept token, so a bigger number means more was removed. `fallbackRate` is the
 * share of checkpoints that came from the deterministic rung — a body no model
 * wrote — which is the one signal that says "compaction ran but degraded".
 * @param rows - from {@link checkpointRows}.
 * @returns the aggregate.
 */
export function summarizeCheckpoints(rows) {
  let span = 0;
  let kept = 0;
  let anchors = 0;
  let nodes = 0;
  let fallbacks = 0;
  for (const row of rows) {
    span += row.span;
    kept += row.kept;
    anchors += row.anchors;
    nodes += row.nodes;
    if (row.fallback) fallbacks += 1;
  }
  return {
    count: rows.length,
    span,
    kept,
    saved: Math.max(0, span - kept),
    ratio: kept === 0 ? null : span / kept,
    anchors,
    nodes,
    fallbacks,
    fallbackRate: rows.length === 0 ? null : fallbacks / rows.length,
    // Anchors per compacted node: the fidelity number. A shallow leaf keeps ~1.35
    // pointers per node; a wide one approaches 0 and lcm_expand becomes the only
    // way back into the log.
    anchorsPerNode: nodes === 0 ? null : anchors / nodes
  };
}

/**
 * How the checkpoints are distributed across DAG depths.
 * @param rows - from {@link checkpointRows}.
 * @returns `[{ depth, count, span, kept }]` ascending by depth.
 */
export function depthHistogram(rows) {
  const byDepth = new Map();
  for (const row of rows) {
    const bucket = byDepth.get(row.depth) ?? { depth: row.depth, count: 0, span: 0, kept: 0 };
    bucket.count += 1;
    bucket.span += row.span;
    bucket.kept += row.kept;
    byDepth.set(row.depth, bucket);
  }
  return [...byDepth.values()].sort((a, b) => a.depth - b.depth);
}

/**
 * Checkpoints grouped by UTC day, which is the axis a timeline reads on.
 * @param rows - from {@link checkpointRows}.
 * @returns `[{ day, count, span, kept }]` ascending by day.
 */
export function dailyHistogram(rows) {
  const byDay = new Map();
  for (const row of rows) {
    if (row.at === null) continue;
    const day = new Date(row.at).toISOString().slice(0, 10);
    const bucket = byDay.get(day) ?? { day, count: 0, span: 0, kept: 0, fallbacks: 0 };
    bucket.count += 1;
    bucket.span += row.span;
    bucket.kept += row.kept;
    if (row.fallback) bucket.fallbacks += 1;
    byDay.set(day, bucket);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

/**
 * Span buckets, so an outlier cannot flatten the chart.
 *
 * The engine's leaf ceiling is 24 000 and a single oversized tool result can push
 * one span past 100 000; plotting raw spans makes every ordinary leaf invisible.
 * @param rows - from {@link checkpointRows}.
 * @returns `[{ label, count, span }]` in ascending bucket order.
 */
export function spanHistogram(rows) {
  const edges = [0, 6000, 12000, 24000, 48000, 96000, Infinity];
  const labels = ["<6k", "6–12k", "12–24k", "24–48k", "48–96k", "96k+"];
  const buckets = labels.map((label) => ({ label, count: 0, span: 0 }));
  for (const row of rows) {
    let index = edges.findIndex((edge, i) => row.span >= edge && row.span < edges[i + 1]);
    if (index < 0) index = labels.length - 1;
    buckets[index].count += 1;
    buckets[index].span += row.span;
  }
  return buckets;
}

/**
 * Everything the session view needs from one log.
 * @param events - the session log in seq order.
 * @returns the session report.
 */
/**
 * The checkpoint DAG as a nested tree, for the structure view.
 *
 * A checkpoint absorbs a contiguous range of surface nodes, and `shadowedSeqs`
 * names them. When those seqs are themselves checkpoints the node is a
 * condensation and its absorbed checkpoints are its children; when they are raw
 * messages it is a leaf. That is the whole shape, and it is exactly what a tree
 * view needs: the nodes that are still on the surface are the roots, everything
 * they replaced hangs beneath them.
 *
 * Only checkpoints are materialised. A leaf's absorbed messages are summarised as a
 * COUNT, because listing 24 000 individual messages would make the payload larger
 * than the log it describes and the reader would scroll past the structure to find
 * it.
 * @param events - the session log in seq order.
 * @returns `[{ seq, depth, span, kept, nodes, rawMessages, fallback, at, children }]`,
 *   roots first, oldest sibling first.
 */
export function checkpointTree(events) {
  const depths = checkpointDepths(events);
  const bySeq = new Map();
  for (const event of events) {
    if (!isCheckpoint(event)) continue;
    const body = (event.data?.summary ?? []).map((block) => block?.text ?? "").join("");
    bySeq.set(event.seq, {
      seq: event.seq,
      at: typeof event.time === "number" ? event.time : null,
      span: event.data?.shadowedTokenCount ?? 0,
      kept: estimateTokens(body),
      nodes: (event.data?.shadowedSeqs ?? []).length,
      rawMessages: 0,
      fallback: body.includes(FALLBACK_MARKER),
      depth: depths.get(event.seq) ?? 1,
      children: []
    });
  }
  // Link each checkpoint to the checkpoints it absorbed; count the rest as raw.
  const absorbed = new Set();
  for (const [seq, node] of bySeq) {
    const source = events.find((event) => event.seq === seq);
    for (const childSeq of source?.data?.shadowedSeqs ?? []) {
      const child = bySeq.get(childSeq);
      if (child === undefined) {
        node.rawMessages += 1;
        continue;
      }
      node.children.push(child);
      absorbed.add(childSeq);
    }
  }
  for (const node of bySeq.values()) node.children.sort((a, b) => a.seq - b.seq);
  // A checkpoint nothing else absorbed is a root: it is still standing on the
  // surface. Everything else is reachable through a parent.
  const roots = [...bySeq.values()].filter((node) => !absorbed.has(node.seq)).sort((a, b) => a.seq - b.seq);
  return { roots, total: bySeq.size };
}

export function analyzeSession(events) {
  const rows = checkpointRows(events);
  const totals = summarizeCheckpoints(rows);
  const byType = new Map();
  for (const event of events) byType.set(event.type, (byType.get(event.type) ?? 0) + 1);
  const first = events.find((event) => typeof event.time === "number");
  const last = [...events].reverse().find((event) => typeof event.time === "number");
  return {
    events: events.length,
    firstAt: first?.time ?? null,
    lastAt: last?.time ?? null,
    totals,
    recent: rows.slice(-30),
    depths: depthHistogram(rows),
    days: dailyHistogram(rows),
    spans: spanHistogram(rows),
    tree: checkpointTree(events),
    kinds: [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([type, count]) => ({ type, count }))
  };
}

/**
 * Aggregate several session reports for the application view.
 *
 * Each session is folded independently first, so one unreadable log is a gap in
 * the totals rather than a failed panel; `unreadable` carries that count.
 * @param sessions - `[{ id, report, tokens, threshold, preset }]`, report may be null.
 * @returns the application report.
 */
export function analyzeApplication(sessions) {
  const rows = [];
  let events = 0;
  let unreadable = 0;
  for (const session of sessions) {
    if (session.report === null) {
      unreadable += 1;
      continue;
    }
    events += session.report.events;
    for (const row of session.report.recent) rows.push(row);
  }
  const totals = summarizeCheckpoints(rows);
  return {
    sessions: sessions.length,
    unreadable,
    events,
    // Totals cover the RECENT window of each session (last 30 checkpoints), which
    // is what `recent` carries; the per-session view holds the full history.
    totals,
    days: dailyHistogram(rows),
    spans: spanHistogram(rows),
    depths: depthHistogram(rows),
    pressure: sessions
      .filter((session) => session.tokens !== null && session.threshold !== null)
      .map((session) => ({
        id: session.id,
        preset: session.preset,
        tokens: session.tokens,
        threshold: session.threshold,
        share: session.threshold === 0 ? null : session.tokens / session.threshold
      }))
      .sort((a, b) => b.share - a.share),
    perSession: sessions.map((session) => ({
      id: session.id,
      preset: session.preset,
      tokens: session.tokens,
      threshold: session.threshold,
      checkpoints: session.report?.totals.count ?? null,
      ratio: session.report?.totals.ratio ?? null,
      fallbacks: session.report?.totals.fallbacks ?? null
    }))
  };
}
// ── the read-only HTTP surface ─────────────────────────────────────────────
//
// Everything below answers one question for the browser half: what did the engine
// do, for this session and for the profile? None of it is computable in the page —
// the logs, the sidecars and the vector cache are files on the host.
//
// The routes are BUILT, not registered: `insightRoutes` returns descriptors and
// `apply` in ./tool.js registers them as effects, so unloading the row removes them
// and nothing here reaches for a context.

/** Route for the profile report. */
const ROUTE_APP = "/lcm-insight/app";
/** Route for one session's report. */
const ROUTE_SESSION = "/lcm-insight/session";

/** Skip a log bigger than this; inflating a huge log would block the event loop. */
const MAX_LOG_BYTES = 96 * 1024 * 1024;

/** A session counts as recent for the profile sweep when touched within this window. */
const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** dsh home, where sessions and the default sidecar roots live. */
function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
}

/**
 * First existing directory among the candidates.
 *
 * The engine resolves `.lcm-rollups` and `.lcm-vectors` RELATIVE to the process
 * cwd, which is not the dsh home; probing both is what makes the panel work
 * wherever the process was started.
 * @param candidates - absolute paths, most specific first.
 * @returns the first that exists, or the first candidate when none does.
 */
function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Not a directory: try the next candidate.
    }
  }
  return candidates[0];
}

/**
 * Decompress and parse one v4 session log.
 * @param file - absolute path to `session.v4.jsonl.zstd`.
 * @returns the parsed records, or null when the file cannot be read.
 */
function readLog(file) {
  let raw;
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) return null;
    raw = zlib.zstdDecompressSync(fs.readFileSync(file)).toString("utf8");
  } catch {
    return null;
  }
  const records = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A truncated tail after a crash is not a reason to drop the whole log.
    }
  }
  return records;
}

/**
 * Every session log under the dsh home, newest first.
 * @returns `[{ id, file, mtimeMs }]`.
 */
function sessionFiles() {
  const root = path.join(dshHome(), "sessions");
  let workspaces;
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = path.join(root, workspace.name);
    let sessions;
    try {
      sessions = fs.readdirSync(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const file = path.join(workspaceDir, session.name, "session.v4.jsonl.zstd");
      try {
        found.push({ id: session.name, file, mtimeMs: fs.statSync(file).mtimeMs });
      } catch {
        // No log for this session directory yet.
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Reports keyed by file plus mtime, so a repaint does not re-inflate every log. */
const reportCache = new Map();

/**
 * One session's report, reusing the cached fold while its log is unchanged.
 * @param file - absolute path.
 * @param mtimeMs - the stat that decides freshness.
 * @returns the report, or null when the log is unreadable.
 */
function cachedReport(file, mtimeMs) {
  const hit = reportCache.get(file);
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.report;
  const records = readLog(file);
  const report = records === null ? null : analyzeSession(records.filter((record) => Number.isSafeInteger(record.seq)));
  reportCache.set(file, { mtimeMs, report });
  return report;
}

/**
 * Row count per session file in a JSONL sidecar directory.
 * @param dir - `.lcm-rollups` or `.lcm-assertions`.
 * @returns `Map<sessionId, rowCount>`.
 */
function sidecarCounts(dir) {
  const counts = new Map();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return counts;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const rows = fs.readFileSync(path.join(dir, name), "utf8").split("\n").filter((line) => line.length > 0);
      counts.set(name.replace(/\.jsonl$/u, ""), rows.length);
    } catch {
      // An unreadable sidecar is simply absent from the map.
    }
  }
  return counts;
}

/**
 * Vector cache size per model-and-width directory.
 *
 * Each entry is one `.f32` file named by the hash of its text, so the file count IS
 * the number of cached embeddings and the dimensions are in the directory name.
 * @param dir - `.lcm-vectors`.
 * @returns `[{ family, entries, bytes }]`.
 */
function vectorStats(dir) {
  let families;
  try {
    families = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const family of families) {
    if (!family.isDirectory()) continue;
    let entries = 0;
    let bytes = 0;
    try {
      for (const entry of fs.readdirSync(path.join(dir, family.name))) {
        if (!entry.endsWith(".f32")) continue;
        entries += 1;
        try {
          bytes += fs.statSync(path.join(dir, family.name, entry)).size;
        } catch {
          // Raced with a write; the count still stands.
        }
      }
    } catch {
      continue;
    }
    out.push({ family: family.name, entries, bytes });
  }
  return out.sort((a, b) => b.entries - a.entries);
}

/**
 * The compaction threshold the engine would apply to one routed request.
 *
 * Mirrors `resolveCompactSpec` instead of importing it: this module reports ON the
 * engine, and importing the engine into the read path would let swapping the engine
 * take the report down with it. The constants are the shipped defaults, so the
 * panel labels the result a share of the DEFAULT threshold rather than claiming to
 * know a tuned one.
 * @param contextWindow - the model's window.
 * @param reserved - the routed request's output budget.
 * @returns the threshold in tokens.
 */
function thresholdFor(contextWindow, reserved) {
  const messageBudget = contextWindow - (reserved ?? 0);
  return Math.floor(Math.min(contextWindow * 0.75, messageBudget - 65536));
}

/**
 * Live token pressure for a session the Host still holds.
 *
 * The meter needs a Session object, so an unloaded session reports null and the
 * panel labels pressure unavailable rather than guessing.
 * @param ctx - the plugin context.
 * @param sessionId - the session to measure.
 * @returns `{ tokens, threshold } | null`, as a promise.
 */
export async function livePressure(ctx, sessionId) {
  const meter = ctx.get("tokenMeter");
  const sessions = ctx.get("sessions");
  const llm = ctx.get("llm");
  if (meter === undefined || sessions === undefined) return null;
  const session = sessions.get(sessionId);
  if (session === undefined) return null;
  let header;
  let measured;
  try {
    header = session.requestHeader();
    measured = meter.measure(session, header);
  } catch {
    return null;
  }

  // ── the composition tree ────────────────────────────────────────────────
  // The meter prices EVERY node on the surface, so the breakdown costs nothing
  // extra: classify each priced seq by the event it points at. That is what makes
  // an honest "context is made of this" view possible — it reports the same numbers
  // the engine itself compares against the threshold, rather than re-deriving them
  // from the log and disagreeing by a few percent.
  const composition = { system: 0, checkpoints: 0, raw: 0, nodes: { system: 0, checkpoints: 0, raw: 0 } };
  const bySeq = new Map(session.snapshotEvents?.().map((event) => [event.seq, event]) ?? []);
  for (const node of measured.nodes ?? []) {
    const event = bySeq.get(node.seq);
    const kind = event?.type === "compaction/summary"
      ? "checkpoints"
      : event?.type === "system/message" || event?.type === "developer/message"
        ? "system"
        : "raw";
    composition[kind] += node.tokens ?? 0;
    composition.nodes[kind] += 1;
  }

  const target = header?.config;
  const base = { tokens: measured.totalTokens, threshold: null, composition };
  if (target === undefined || llm === undefined) return base;
  try {
    const info = await llm.resolveModelInfo(target.provider, target.model);
    const window = info?.context?.contextWindow;
    if (window === undefined) return base;
    return { tokens: measured.totalTokens, threshold: thresholdFor(window, info.defaultMaxTokens), composition };
  } catch {
    return base;
  }
}

/**
 * Write one JSON body.
 * @param res - the response.
 * @param status - HTTP status.
 * @param body - serializable value.
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

/**
 * Refuse anything that is not loopback unless the operator opted in.
 *
 * These endpoints expose session history and file paths, so the default matches the
 * meme gallery's: the panel serves the machine it runs on.
 * @param req - the request.
 * @param res - the response.
 * @param allowLan - the operator's opt-in.
 * @returns true when the request was refused.
 */
function refused(req, res, allowLan) {
  if (allowLan) return false;
  const address = req.socket?.remoteAddress ?? "";
  const loopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  if (loopback) return false;
  sendJson(res, 403, { error: "lcm insight is loopback-only; set allowLanAccess to serve it" });
  return true;
}

/**
 * Build the two read-only route descriptors.
 *
 * Pressure is probed only for sessions the Host still holds: each probe is a
 * model-info round trip, and doing that for every log on disk would turn a repaint
 * into hundreds of calls. Every other session still contributes its checkpoint
 * history, just without a pressure bar.
 * @param ctx - the plugin context, used for the live meter.
 * @param resolved - the tool row's resolved config, which carries `rollupDir`.
 * @returns the route descriptors, ready for `ctx.webServer.register`.
 */
export function insightRoutes(ctx, resolved) {
  const cwd = process.cwd();
  const home = dshHome();
  const rollupDir = firstExisting([resolved.rollupDir, path.join(cwd, ".lcm-rollups"), path.join(home, ".lcm-rollups")]);
  const assertionDir = firstExisting([path.join(cwd, ".lcm-assertions"), path.join(home, ".lcm-assertions")]);
  const vectorDir = firstExisting([path.join(cwd, ".lcm-vectors"), path.join(home, ".lcm-vectors")]);
  const allowLan = resolved.allowLanAccess === true;

  return [
    {
      kind: "exact",
      path: ROUTE_APP,
      async handler(req, res) {
        if (refused(req, res, allowLan)) return;
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "GET only" });
          return;
        }
        try {
          const rollups = sidecarCounts(rollupDir);
          const assertions = sidecarCounts(assertionDir);
          const since = Date.now() - RECENT_WINDOW_MS;
          const held = new Set((ctx.get("sessions")?.list() ?? []).map((session) => session.id));
          const sessions = [];
          for (const entry of sessionFiles()) {
            if (entry.mtimeMs < since) continue;
            const pressure = held.has(entry.id) ? await livePressure(ctx, entry.id) : null;
            sessions.push({
              id: entry.id,
              report: cachedReport(entry.file, entry.mtimeMs),
              tokens: pressure?.tokens ?? null,
              threshold: pressure?.threshold ?? null
            });
          }
          const body = analyzeApplication(sessions);
          body.vectors = vectorStats(vectorDir);
          body.sidecars = {
            rollupDir,
            assertionDir,
            rollupFiles: rollups.size,
            rollupRows: [...rollups.values()].reduce((total, n) => total + n, 0),
            assertionFiles: assertions.size,
            assertionRows: [...assertions.values()].reduce((total, n) => total + n, 0)
          };
          body.perSession = body.perSession.map((row) => ({
            ...row,
            rollups: rollups.get(row.id) ?? 0,
            assertions: assertions.get(row.id) ?? 0
          }));
          body.held = held.size;
          sendJson(res, 200, body);
        } catch (error) {
          sendJson(res, 500, { error: String(error instanceof Error ? error.message : error) });
        }
      }
    },
    {
      kind: "exact",
      path: ROUTE_SESSION,
      async handler(req, res) {
        if (refused(req, res, allowLan)) return;
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "GET only" });
          return;
        }
        let id;
        try {
          id = new URL(req.url ?? "/", "http://localhost").searchParams.get("id") ?? "";
        } catch {
          sendJson(res, 400, { error: "unreadable query" });
          return;
        }
        if (!/^session-[\w-]+$/u.test(id)) {
          sendJson(res, 400, { error: "id must be a session id" });
          return;
        }
        const entry = sessionFiles().find((candidate) => candidate.id === id);
        if (entry === undefined) {
          sendJson(res, 404, { error: "no log for " + id });
          return;
        }
        const report = cachedReport(entry.file, entry.mtimeMs);
        if (report === null) {
          sendJson(res, 500, { error: "the log for " + id + " could not be read" });
          return;
        }
        const pressure = await livePressure(ctx, id);
        const rollups = sidecarCounts(rollupDir);
        const assertions = sidecarCounts(assertionDir);
        sendJson(res, 200, {
          id,
          updatedAt: entry.mtimeMs,
          report,
          tokens: pressure?.tokens ?? null,
          threshold: pressure?.threshold ?? null,
          composition: pressure?.composition ?? null,
          rollups: rollups.get(id) ?? 0,
          assertions: assertions.get(id) ?? 0
        });
      }
    }
  ];
}
