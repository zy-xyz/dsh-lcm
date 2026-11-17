/**
 * Embedding maintenance: lcm-x's triggers and duty cycle, not an idle gate.
 *
 * Upstream runs a bounded pass on session BIND and after a LEAF IS PUBLISHED
 * (`engine.py:3149`, `engine.py:3165`), then re-arms at
 * `_LOCAL_IDLE_MULTIPLIER x` the wall clock the pass took
 * (`embedding_maintenance.py:230`). This port had only `agent/status === "idle"`,
 * so a session that never idled embedded nothing: measured 2026-11-17, eight
 * minutes with 2 400 texts pending and zero rows written while a conversation was
 * active.
 *
 * These tests pin the trigger and the chain, not the pacing constant: a pass is
 * observed through the stub endpoint's request count, which is the only externally
 * visible fact a background chain leaves behind.
 *
 * Run with: node --test test/embed-maintenance.test.js
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A private dsh home BEFORE the plugin is imported: the maintenance chain sweeps
// every session log under `DSH_HOME`, and pointing it at the real home made this
// file inflate 290 production logs (~15 s) and lean on state it does not own.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), "lcm-maint-home-"));

const { apply: applyTool } = await import("../src/tool.js");

const DIM = 3;

/** Read one JSON request body. */
function readJson(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => resolve(JSON.parse(raw)));
  });
}

/** A loopback embeddings stub that counts requests and batches. */
async function embeddingServer() {
  const state = { requests: 0, batches: [] };
  const server = createServer(async (request, response) => {
    state.requests += 1;
    const body = await readJson(request);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    state.batches.push(inputs.length);
    const data = inputs.map((text, index) => ({ object: "embedding", index, embedding: [1, 1, 1] }));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", model: body.model, data }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    state,
    baseUrl: "http://127.0.0.1:" + server.address().port + "/v1",
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** One compacted user message; `hidden` because it is not on the surface. */
function message(seq, text) {
  return { seq, type: "user/message", data: { content: [{ type: "text", text }] } };
}

/** A session whose whole corpus is compacted (no surface nodes). */
function sessionWith(id, hidden) {
  const events = [];
  for (let index = 0; index < hidden; index += 1) events.push(message(index, "compacted note " + index));
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  return {
    id,
    snapshotEvents: () => events,
    events,
    seq: events.length,
    surface: { nodes: [], replaceGeneration: 1 },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => (event.data?.content === undefined ? null : { role: "user", content: event.data.content })
  };
}

/**
 * A ctx just real enough for `apply()`: it records listeners so a test can fire the
 * host's own events, and every service the row reaches for is a stub.
 */
function harness(config) {
  const listeners = new Map();
  const registrations = [];
  const ctx = {
    on(event, handler) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(handler);
      listeners.set(event, bucket);
      return () => {
        const current = listeners.get(event) ?? [];
        listeners.set(event, current.filter((entry) => entry !== handler));
      };
    },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    },
    tools: { register: (definition) => { registrations.push(definition.name); return () => {}; } },
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} }
  };
  applyTool(ctx, config);
  return {
    registrations,
    /** Fire every listener for one event, the way the dispatcher does. */
    emit(event, ...args) { for (const handler of listeners.get(event) ?? []) handler(...args); },
    count(event) { return (listeners.get(event) ?? []).length; }
  };
}

/** Settings for one stub and one temp cache root. */
function toolConfig(server, root, overrides = {}) {
  return {
    vectorEnabled: true,
    vectorBaseUrl: server.baseUrl,
    vectorModel: "test-embedding",
    vectorDim: DIM,
    vectorCacheDir: root,
    embedMaintenanceLimit: 8,
    ...overrides
  };
}

/** A fresh temp cache root. */
function scratch() {
  return mkdtemp(join(tmpdir(), "lcm-embed-maint-"));
}

/** Wait until `done()` or the budget runs out. */
async function until(done, budgetMs = 4000) {
  const started = Date.now();
  while (!done() && Date.now() - started < budgetMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return done();
}

test("[maint] a published checkpoint starts a pass, without any idle event", async () => {
  const root = await scratch();
  const server = await embeddingServer();
  try {
    const h = harness(toolConfig(server, root));
    const session = sessionWith("bind-probe", 4);
    // The ONLY trigger fired is the publication. No `agent/status` at all, which is
    // the whole point: upstream does not need an idle agent and neither does this.
    h.emit("session/event", session, { type: "compaction/summary" });
    assert.equal(await until(() => server.state.requests > 0), true, "the pass reached the endpoint");
    assert.equal(await until(() => server.state.requests >= 1 && h.registrations.length > 0), true);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[maint] a session bind is a trigger too, and it does not need a status change", async () => {
  const root = await scratch();
  const server = await embeddingServer();
  try {
    const h = harness(toolConfig(server, root));
    const session = sessionWith("bind-only", 3);
    h.emit("agent/status", { agent: { session } });
    assert.equal(await until(() => server.state.requests > 0), true, "bind alone reached the endpoint");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[maint] an event that is not a checkpoint embeds nothing", async () => {
  const root = await scratch();
  const server = await embeddingServer();
  try {
    const h = harness(toolConfig(server, root));
    const session = sessionWith("no-checkpoint", 4);
    h.emit("session/event", session, { type: "assistant/message" });
    // Give a would-be chain the same budget a real pass gets, then assert silence.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(server.state.requests, 0, "no checkpoint, no pass");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[maint] one driver per session: three triggers do not stack three chains", async () => {
  const root = await scratch();
  const server = await embeddingServer();
  try {
    const h = harness(toolConfig(server, root, { embedMaintenanceLimit: 200 }));
    const session = sessionWith("dedupe", 4);
    h.emit("session/event", session, { type: "compaction/summary" });
    h.emit("session/event", session, { type: "compaction/summary" });
    h.emit("agent/status", { agent: { session } });
    // 4 texts at limit 200 is one batch. Stacked chains would send one batch each.
    assert.equal(await until(() => server.state.requests >= 1), true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(server.state.requests, 1, "one chain, one batch, not three");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[maint] the chain stops once the corpus is drained", async () => {
  const root = await scratch();
  const server = await embeddingServer();
  try {
    // limit 2 over 2 texts: the pass drains everything, so `remaining` is 0.
    const h = harness(toolConfig(server, root, { embedMaintenanceLimit: 2 }));
    const session = sessionWith("drained", 2);
    h.emit("session/event", session, { type: "compaction/summary" });
    assert.equal(await until(() => server.state.requests >= 1), true);
    const after = server.state.requests;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(server.state.requests, after, "a drained corpus is not re-requested");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[maint] a disabled layer never reaches the endpoint", async () => {
  const root = await scratch();
  const server = await embeddingServer();
  try {
    const h = harness(toolConfig(server, root, { vectorEnabled: false }));
    const session = sessionWith("disabled", 4);
    h.emit("session/event", session, { type: "compaction/summary" });
    h.emit("agent/status", { agent: { session } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(server.state.requests, 0, "vectorEnabled: false is inert");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[maint] a sweep reaches a session that will never emit again", async () => {
  // The backlog this exists for: finished sessions keep their compacted texts in the
  // cache-less state forever, because a dead session fires no `agent/status` and
  // publishes no checkpoint. Per-session draining cannot reach them by construction,
  // so the chain walks every log under DSH_HOME.
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { zstdCompressSync } = await import("node:zlib");
  const root = await scratch();
  const server = await embeddingServer();
  const home = process.env.DSH_HOME;
  const logDir = join(home, "sessions", "--ws--", "session-dead");
  try {
    await mkdir(logDir, { recursive: true });
    const records = [
      { type: "session", seq: 0 },
      { type: "user/message", seq: 1, data: { role: "user", id: "u1", content: [{ type: "text", text: "orphan one" }] } },
      { type: "user/message", seq: 2, data: { role: "user", id: "u2", content: [{ type: "text", text: "orphan two" }] } }
    ];
    await writeFile(join(logDir, "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(records.map((r) => JSON.stringify(r)).join("\n"))));

    // The trigger is a DIFFERENT, empty session, so anything the stub receives beyond
    // it came from the log sweep.
    const h = harness(toolConfig(server, root, { embedMaintenanceLimit: 50 }));
    h.emit("session/event", sessionWith("trigger", 0), { type: "compaction/summary" });

    assert.equal(
      await until(() => server.state.requests >= 1),
      true,
      "the sweep reached the dead session's log"
    );
    // Both orphan texts, one batch.
    assert.deepEqual(
      server.state.batches.reduce((total, size) => total + size, 0) >= 2,
      true,
      "and embedded the texts that log held"
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  }
});
