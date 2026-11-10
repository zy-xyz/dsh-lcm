/**
 * `/lcm-embed`: the vector-cache surface.
 *
 * The layer's value depends on four properties, and each is pinned here:
 *
 *   1. a disabled layer is reported as disabled, not as an empty cache;
 *   2. `backfill` without `--apply` is a real dry run — ZERO provider requests,
 *      the same guarantee lcm-x's `/lcm embed backfill` makes;
 *   3. `--apply` writes through the cache, so a second `--apply` embeds nothing;
 *   4. the pass is bounded — `--limit N` caps what one invocation sends.
 *
 * Run with: node --test test/embed-command.test.js
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { apply, buildEmbedStatus, defineEmbedCommand, embedBackfill, resolveConfig } from "../src/command.js";

/** Read one JSON request body. */
function readJson(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => resolve(JSON.parse(raw)));
  });
}

/**
 * A local stand-in for the OpenAI-compatible embeddings endpoint.
 * Vectors are derived from the text so the fixture needs no lookup table, and
 * an empty input is refused with HTTP 400 — the production backend's behaviour
 * and the reason backfill must never send "".
 */
async function embeddingServer() {
  const state = { requests: 0, inputs: [] };
  const server = createServer(async (request, response) => {
    state.requests += 1;
    const body = await readJson(request);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    state.inputs.push(...inputs);
    if (inputs.some((text) => typeof text !== "string" || text.length === 0)) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "input must not be empty" } }));
      return;
    }
    const data = inputs.map((text, index) => ({ object: "embedding", index, embedding: [1, (text.length % 7) + 1, 0.5] }));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", model: body.model, data, usage: { prompt_tokens: 0, total_tokens: 0 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    state,
    baseUrl: "http://127.0.0.1:" + address.port + "/v1",
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** One message event whose body is the text the model saw. */
function message(seq, text) {
  return { seq, type: "user/message", data: { content: [{ type: "text", text }] } };
}

/**
 * A session shaped the way `sessionEvents` / `renderEventBody` read it: a
 * header record without a seq, message events, and the surface nodes the model
 * can still read.
 */
function shapedSession(events, nodes) {
  const bySeq = new Map(events.filter((event) => Number.isSafeInteger(event.seq)).map((event) => [event.seq, event]));
  return {
    id: "s",
    events,
    surface: { nodes, replaceGeneration: 1 },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => (event.data?.content === undefined ? null : { role: "user", content: event.data.content })
  };
}

/**
 * Five compacted (off-surface) message events, the newest last, plus whatever
 * visible tail the caller asks for.
 */
function hiddenSession({ visible = 0, hidden = 5, empty = 0 } = {}) {
  const events = [{ type: "session", id: "s" }];
  let seq = 0;
  const nodes = [];
  for (let index = 0; index < visible; index += 1) {
    events.push(message(seq, "visible tail " + index));
    nodes.push(seq);
    seq += 1;
  }
  for (let index = 0; index < hidden; index += 1) {
    events.push(message(seq, "compacted note " + index));
    seq += 1;
  }
  for (let index = 0; index < empty; index += 1) {
    events.push({ seq, type: "user/message", data: { content: [] } });
    seq += 1;
  }
  return shapedSession(events, nodes);
}

/** Vector settings pointing at one fake server and one scratch cache root. */
function commandConfig(server, dir, overrides = {}) {
  return resolveConfig({
    vectorEnabled: true,
    vectorBaseUrl: server.baseUrl,
    vectorModel: "test-embedding",
    vectorDim: 3,
    vectorCacheDir: dir,
    ...overrides
  });
}

/** A scratch cache root, removed by the caller. */
function scratch() {
  return mkdtemp(join(tmpdir(), "lcm-embed-"));
}

test("status reports the cache summary, and says so when the layer is disabled", async () => {
  const dir = await scratch();
  try {
    const off = await buildEmbedStatus(resolveConfig({ vectorEnabled: false, vectorModel: "test-embedding", vectorDim: 3, vectorCacheDir: dir }));
    assert.match(off, /lcm-embed status/);
    assert.match(off, /model: test-embedding/, off);
    assert.match(off, /dim: 3/, off);
    assert.ok(off.includes(dir), "the directory is where a backfill would write\n" + off);
    assert.match(off, /files: 0/, "an absent cache is zeros, not an error\n" + off);
    assert.match(off, /bytes: 0/, off);
    assert.match(off, /layer: disabled/, off);
    assert.match(off, /vectorEnabled is false/, "the disabled line names the switch\n" + off);
    assert.doesNotMatch(off, /layer: enabled/);

    const on = await buildEmbedStatus(resolveConfig({ vectorEnabled: true, vectorModel: "test-embedding", vectorDim: 3, vectorCacheDir: dir }));
    assert.match(on, /layer: enabled/, on);
    assert.doesNotMatch(on, /disabled/);
    assert.match(on, /rank: n\/a/, "filling a cache does not rank, and the line says so\n" + on);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("backfill without --apply is a dry run: zero provider requests", async () => {
  const server = await embeddingServer();
  const dir = await scratch();
  try {
    const cfg = commandConfig(server, dir);
    const { report, text } = await embedBackfill(hiddenSession(), cfg, { apply: false });
    assert.equal(server.state.requests, 0, "a preview must not spend a provider call");
    assert.deepEqual(report, { scanned: 5, alreadyCached: 0, embedded: 0, failed: 0, limit: 200, applied: false, corpus: 5, remaining: 5, scope: "corpus" });
    assert.match(text, /backfill \(dry-run, scope: corpus\)/, text);
    assert.match(text, /would embed: 5/, text);
    assert.match(text, /applied: no/, text);
    assert.match(text, /preview only/, text);
    assert.match(text, /--apply/, "the dry run names the next step\n" + text);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("--apply embeds once, and a second --apply is a pure cache hit", async () => {
  const server = await embeddingServer();
  const dir = await scratch();
  try {
    const cfg = commandConfig(server, dir);
    const first = await embedBackfill(hiddenSession(), cfg, { apply: true });
    assert.equal(first.report.embedded, 5, first.text);
    assert.equal(first.report.failed, 0, first.text);
    assert.ok(server.state.requests >= 1, "the apply actually called the endpoint");
    assert.equal(server.state.inputs.length, 5);
    assert.ok(server.state.inputs.every((text) => text.length > 0), "never embed the empty string");
    assert.match(first.text, /embedded: 5/, first.text);
    assert.match(first.text, /applied: yes/, first.text);

    const callsAfterFirst = server.state.requests;
    const second = await embedBackfill(hiddenSession(), cfg, { apply: true });
    assert.deepEqual(second.report, { scanned: 5, alreadyCached: 5, embedded: 0, failed: 0, limit: 200, applied: true, corpus: 5, remaining: 0, scope: "corpus" });
    assert.equal(server.state.requests, callsAfterFirst, "a cached text is never sent again");
    assert.equal(server.state.inputs.length, 5);

    const status = await buildEmbedStatus(cfg);
    assert.match(status, /files: 5/, status);
    assert.match(status, /bytes: 60/, "5 vectors of 3 float32s\n" + status);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("--limit N caps what one pass embeds", async () => {
  const server = await embeddingServer();
  const dir = await scratch();
  try {
    const cfg = commandConfig(server, dir);
    const { report, text } = await embedBackfill(hiddenSession(), cfg, { apply: true, limit: 2 });
    assert.equal(report.limit, 2, text);
    assert.equal(report.scanned, 2, text);
    assert.equal(report.embedded, 2, text);
    assert.equal(report.failed, 0, text);
    assert.equal(server.state.inputs.length, 2, "only the capped texts were sent");
    assert.deepEqual(server.state.inputs.slice().sort(), ["compacted note 3", "compacted note 4"]);
    assert.equal(report.scanned, report.alreadyCached + report.embedded + report.failed);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the window is what the model cannot read, and empty text is dropped", async () => {
  const server = await embeddingServer();
  const dir = await scratch();
  try {
    const cfg = commandConfig(server, dir);
    const dry = await embedBackfill(hiddenSession({ visible: 2, hidden: 3, empty: 2 }), cfg, { apply: false });
    assert.equal(dry.report.scanned, 3, "two visible events and two empty bodies are not candidates\n" + dry.text);
    assert.match(dry.text, /corpus: 3 hidden text\(s\)/, dry.text);
    const applied = await embedBackfill(hiddenSession({ visible: 2, hidden: 3, empty: 2 }), cfg, { apply: true });
    assert.equal(applied.report.embedded, 3, applied.text);
    assert.ok(server.state.inputs.every((text) => text.trim().length > 0), JSON.stringify(server.state.inputs));
    assert.ok(server.state.inputs.every((text) => !text.startsWith("visible tail")), JSON.stringify(server.state.inputs));
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the module's two rows mount disjoint command sets", () => {
  const record = () => {
    const names = [];
    return {
      names,
      commands: { register: (definition) => { names.push(definition.name); return () => {}; } },
      effect: (callback) => callback()
    };
  };
  const search = record();
  apply(search, {});
  assert.deepEqual(search.names, ["lcm-search", "lcm-status", "recall"]);
  const embed = record();
  apply(embed, { commandSet: "embed", vectorEnabled: false });
  assert.deepEqual(embed.names, ["lcm-embed"], "a duplicate name would abort the second row");
  assert.equal(defineEmbedCommand(resolveConfig({})).name, "lcm-embed");
});

test("the command's argument grammar is enforced, not guessed", async () => {
  const dir = await scratch();
  try {
    const enabled = resolveConfig({ vectorEnabled: true, vectorModel: "test-embedding", vectorDim: 3, vectorCacheDir: dir });
    const handler = defineEmbedCommand(enabled).handler;
    const bad = await handler({ rawInput: "explode", agent: { session: hiddenSession() } });
    assert.equal(bad.kind, "error");
    assert.match(bad.text, /Usage: \/lcm-embed status/, bad.text);
    const zero = await handler({ rawInput: "backfill --limit 0", agent: { session: hiddenSession() } });
    assert.equal(zero.kind, "error");
    assert.match(zero.text, /--limit/, zero.text);
    const extra = await handler({ rawInput: "status now", agent: { session: hiddenSession() } });
    assert.equal(extra.kind, "error");

    const disabled = resolveConfig({ vectorEnabled: false, vectorModel: "test-embedding", vectorDim: 3, vectorCacheDir: dir });
    const refused = await defineEmbedCommand(disabled).handler({ rawInput: "backfill --apply", agent: { session: hiddenSession() } });
    assert.equal(refused.kind, "error");
    assert.match(refused.text, /disabled/, refused.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
