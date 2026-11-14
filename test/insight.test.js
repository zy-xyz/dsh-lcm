// ── the insight surface: analyzers, routes, and the client half ────────────
// The panel lives inside dsh-lcm rather than a second bundle, so its read path is
// part of this package contract: the analyzers must fold a real log, the routes must
// refuse what they claim to refuse, and the client half must be reachable from the
// manifest the Web app reads.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { analyzeApplication, analyzeSession, checkpointDepths, checkpointTree, spanHistogram } from "../src/insight.js";
import { insightRoutes } from "../src/insight.js";
import { resolveConfig } from "../src/tool.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DAY = 86400000;
const T0 = Date.parse("2026-11-13T10:00:00Z");

function checkpoint(seq, time, span, text, extra = {}) {
  return { type: "compaction/summary", seq, time, data: { shadowedSeqs: [seq - 1], shadowedTokenCount: span, summary: [{ type: "text", text }], maxTokens: 4096, ...extra } };
}

test("a checkpoint body is priced and the span is taken from the record", () => {
  // The body is an ESTIMATE (chars / 3.9); the span is what the engine recorded.
  const report = analyzeSession([checkpoint(2, T0, 24000, "x".repeat(3900))]);
  assert.equal(report.totals.count, 1);
  assert.equal(report.totals.span, 24000, "the span is engine-recorded, not estimated");
  assert.equal(report.totals.kept, 1000, "3900 chars / 3.9");
  assert.equal(report.totals.ratio, 24, "24 000 / 1 000");
});

test("a deterministic body counts as degraded", () => {
  const report = analyzeSession([
    checkpoint(2, T0, 1000, "DETERMINISTIC fallback body"),
    checkpoint(3, T0 + 1000, 1000, "(seq 2) a real chronology")
  ]);
  assert.equal(report.totals.fallbacks, 1);
  assert.equal(report.totals.fallbackRate, 0.5);
});

test("depth is derived from what each checkpoint absorbed", () => {
  // A condensation cites an earlier checkpoint; a leaf cites raw messages.
  const events = [
    checkpoint(2, T0, 1000, "leaf one"),
    checkpoint(4, T0 + 1, 1000, "leaf two"),
    { type: "compaction/summary", seq: 6, time: T0 + 2, data: { shadowedSeqs: [2, 4], shadowedTokenCount: 2000, summary: [{ type: "text", text: "merged" }] } }
  ];
  const depths = checkpointDepths(events);
  assert.equal(depths.get(2), 1, "a leaf is depth 1");
  assert.equal(depths.get(6), 2, "a merge of two leaves is depth 2");
});

test("the tree links a condensation to the checkpoints it absorbed", () => {
  // The structure view needs parenthood, not just depth. A condensation absorbs
  // earlier CHECKPOINTS; a leaf absorbs raw messages and only their count survives,
  // because listing 24 000 messages would bury the structure it is meant to explain.
  const events = [
    { type: "user/message", seq: 1, time: T0 },
    checkpoint(2, T0, 1000, "leaf one"),
    { type: "user/message", seq: 3, time: T0 + 1 },
    checkpoint(4, T0 + 2, 1000, "leaf two"),
    { type: "compaction/summary", seq: 6, time: T0 + 3, data: { shadowedSeqs: [2, 4], shadowedTokenCount: 2000, summary: [{ type: "text", text: "merged" }] } }
  ];
  const tree = checkpointTree(events);
  assert.equal(tree.total, 3, "three checkpoints");
  assert.equal(tree.roots.length, 1, "the condensation is the only root; the leaves hang under it");
  assert.equal(tree.roots[0].seq, 6);
  assert.deepEqual(tree.roots[0].children.map((child) => child.seq), [2, 4], "oldest sibling first");
  assert.equal(tree.roots[0].rawMessages, 0, "it absorbed checkpoints, not messages");
});

test("a leaf counts its absorbed messages instead of listing them", () => {
  const events = [
    { type: "user/message", seq: 1, time: T0 },
    { type: "assistant/message", seq: 2, time: T0 + 1 },
    { type: "user/message", seq: 3, time: T0 + 2 },
    { type: "compaction/summary", seq: 5, time: T0 + 3, data: { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 900, summary: [{ type: "text", text: "(seq 1) done" }] } }
  ];
  const tree = checkpointTree(events);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].rawMessages, 3, "three messages summarised as a count");
  assert.deepEqual(tree.roots[0].children, [], "and no checkpoint children");
});

test("span buckets keep one oversized leaf from flattening the chart", () => {
  const rows = [
    { span: 5000 }, { span: 8000 }, { span: 20000 }, { span: 30000 }, { span: 200000 }
  ];
  const buckets = spanHistogram(rows);
  assert.deepEqual(buckets.map((b) => b.count), [1, 1, 1, 1, 0, 1]);
  assert.equal(buckets[buckets.length - 1].label, "96k+");
});

test("the profile report survives an unreadable session", () => {
  // One bad log must be a gap in the totals, not a failed panel.
  const app = analyzeApplication([
    { id: "a", report: analyzeSession([checkpoint(2, T0, 1000, "x".repeat(390))]), tokens: null, threshold: null },
    { id: "b", report: null, tokens: null, threshold: null }
  ]);
  assert.equal(app.sessions, 2);
  assert.equal(app.unreadable, 1, "the unreadable log is counted, not thrown");
  assert.equal(app.totals.count, 1, "and the readable one still contributes");
});

test("the routes are built from config and refuse a non-GET", async () => {
  const routes = insightRoutes({ get: () => undefined }, resolveConfig({}));
  assert.equal(routes.length, 2, "one route per view");
  const app = routes.find((route) => route.path === "/lcm-insight/app");
  assert.notEqual(app, undefined);

  let status = 0;
  let body = "";
  const res = {
    writeHead(code) { status = code; return this; },
    end(payload) { body = payload ?? ""; return this; }
  };
  await app.handler({ method: "POST", url: "/lcm-insight/app", socket: { remoteAddress: "127.0.0.1" } }, res);
  assert.equal(status, 405, "a write method is refused");
  assert.match(body, /GET only/u);
});

test("the session route rejects a malformed id before touching the disk", async () => {
  const routes = insightRoutes({ get: () => undefined }, resolveConfig({}));
  const session = routes.find((route) => route.path === "/lcm-insight/session");
  let status = 0;
  const res = { writeHead(code) { status = code; return this; }, end() { return this; } };
  await session.handler({ method: "GET", url: "/lcm-insight/session?id=../../etc/passwd", socket: { remoteAddress: "127.0.0.1" } }, res);
  assert.equal(status, 400, "a path-shaped id is a bad request, not a file read");
});

test("a non-loopback peer is refused unless the operator opted in", async () => {
  const off = insightRoutes({ get: () => undefined }, resolveConfig({}));
  let status = 0;
  const res = { writeHead(code) { status = code; return this; }, end() { return this; } };
  await off[0].handler({ method: "GET", url: "/lcm-insight/app", socket: { remoteAddress: "10.0.0.7" } }, res);
  assert.equal(status, 403, "the default is loopback-only");

  const on = insightRoutes({ get: () => undefined }, resolveConfig({ allowLanAccess: true }));
  assert.notEqual(on.length, 0, "and the opt-in is a config value, not a code change");
});

test("the manifest exposes the client half the Web app loads", () => {
  // A panel that renders nothing is indistinguishable from a broken one, and this
  // is the one wiring a unit test can check without a browser.
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(manifest.exports["./client"], "./client.js", "the client export must resolve");
  assert.equal(manifest.dsh?.client?.platform, "web");
  assert.ok(manifest.files.includes("client.js"), "and the file must be shipped");
  const source = fs.readFileSync(path.join(ROOT, "client.js"), "utf8");
  assert.match(source, /__ModuleLoader__\.load/u, "a client bundle registers through the module loader");
  // Placement is a design decision worth pinning: the window floats in the frame
  // overlay so it never competes with the host's own header rows for width.
  assert.match(source, /shell\.overlay/u, "the statistics window renders in the frame overlay");
  assert.doesNotMatch(source, /conversation\.session\.header\.utilities/u, "and NOT in the session header row, which belongs to navigation");
  assert.match(source, /sidebar\.panellist/u, "the sidebar entry stays");
});

test("the client bundle registers under the PACKAGE NAME, which is how the graph keys it", () => {
  // Measured failure: the id was "dsh-lcm/insight", the row reported
  //   web boot: 1 entry did not activate
  //   dsh-lcm: import failed
  // because client-modules builds its graph with `graphRow(packageName, ...)` and
  // resolves "<id>/client" onto that same row. A subpath is not a package name, so
  // the bundle never registered.
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const source = fs.readFileSync(path.join(ROOT, "client.js"), "utf8");
  const registration = {};
  globalThis.window = { __ModuleLoader__: { load(value) { Object.assign(registration, value); } } };
  try {
    // The bundle is a script, not a module: it registers by running.
    new Function(source)();
  } finally {
    delete globalThis.window;
  }
  assert.equal(registration.id, manifest.name, "the registration id must equal the package name");
  assert.equal(typeof registration.factory, "function", "and the loader calls this factory");

  // The factory's face is what the module system mounts; a missing `apply` is a row
  // that activates and does nothing.
  const stubReact = {
    createElement: () => ({}),
    useState: () => [null, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn()
  };
  const face = registration.factory((specifier) => {
    if (specifier === "react") return stubReact;
    throw new Error("unexpected external: " + specifier);
  });
  assert.equal(typeof face.apply, "function", "the face must expose apply");
  assert.ok(Array.isArray(face.inject), "and declare what it injects");
});
