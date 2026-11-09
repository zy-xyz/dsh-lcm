/**
 * `/lcm-embed` matrix: the operator surface of the vector cache.
 *
 * The command is the only way to warm the cache deliberately, so its contract is
 * narrow and pinned here, one test per property: `status` reports rather than
 * guesses, a dry run spends nothing, `--apply` is idempotent through the cache,
 * `--limit` keeps the newest N of the window, a body with no text is never sent
 * (the endpoint answers 400 for ""), and the argument grammar refuses typos
 * instead of interpreting them.
 *
 * Run with: node --test test/vector-embed-command-matrix.test.js
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildEmbedStatus, defineEmbedCommand, embedBackfill, resolveConfig } from "../src/command.js";

const DIM = 3;

/** Read one JSON request body. */
function readJson(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => resolve(JSON.parse(raw)));
  });
}

/**
 * A loopback embeddings stub. It refuses an empty input with HTTP 400, which is
 * what the measured backend does and the reason no empty text may be sent.
 */
async function embeddingServer() {
  const state = { requests: 0, inputs: [], batches: [] };
  const server = createServer(async (request, response) => {
    state.requests += 1;
    const body = await readJson(request);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    state.inputs.push(...inputs);
    state.batches.push(inputs.length);
    if (inputs.some((text) => typeof text !== "string" || text.trim().length === 0)) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "input must not be empty" } }));
      return;
    }
    const data = inputs.map((text, index) => ({
      object: "embedding",
      index,
      embedding: [1, (text.length % 7) + 1, 0.5]
    }));
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

/** One message event whose body is `text`; `blocks` overrides the content list. */
function message(seq, text, blocks) {
  return {
    seq,
    type: "user/message",
    data: { content: blocks ?? (text === undefined ? [] : [{ type: "text", text }]) }
  };
}

/** A session shaped the way the command reads it. */
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

/** `hidden` compacted message events (newest last) plus a visible tail. */
function hiddenSession({ visible = 0, hidden = 5 } = {}) {
  const events = [{ type: "session" }];
  const nodes = [];
  let seq = 0;
  for (let index = 0; index < visible; index += 1) {
    events.push(message(seq, "visible tail " + index));
    nodes.push(seq);
    seq += 1;
  }
  for (let index = 0; index < hidden; index += 1) {
    events.push(message(seq, "compacted note " + index));
    seq += 1;
  }
  return shapedSession(events, nodes);
}

/** Command-row settings for one stub and one temp cache root. */
function commandConfig(server, root, overrides = {}) {
  return resolveConfig({
    vectorEnabled: true,
    vectorBaseUrl: server.baseUrl,
    vectorModel: "test-embedding",
    vectorDim: DIM,
    vectorCacheDir: root,
    ...overrides
  });
}

/** A fresh temp cache root. */
function scratch() {
  return mkdtemp(join(tmpdir(), "lcm-embed-matrix-"));
}

test("[embed] status on a disabled layer names the switch, the cache path and the auth source", async () => {
  const root = await scratch();
  try {
    const off = await buildEmbedStatus(resolveConfig({ vectorEnabled: false, vectorModel: "test-embedding", vectorDim: DIM, vectorCacheDir: root }));
    assert.match(off, /^lcm-embed status$/mu, off);
    assert.match(off, /model: test-embedding/u, off);
    assert.match(off, /dim: 3/u, off);
    assert.ok(off.includes(root), "the report names the shared cache root: " + off);
    assert.match(off, /files: 0/u, off);
    assert.match(off, /bytes: 0/u, off);
    assert.match(off, /layer: disabled — vectorEnabled is false/u, "a disabled layer is not an empty cache: " + off);
    assert.match(off, /auth: none \(no vectorApiKeyEnv; keyless backend\)/u, "the auth line states the reason, not just 'none': " + off);
    assert.match(off, /rank: n\/a/u, "filling a cache never ranks, and the line says so");

    const on = await buildEmbedStatus(resolveConfig({ vectorEnabled: true, vectorModel: "test-embedding", vectorDim: DIM, vectorCacheDir: root }));
    assert.match(on, /layer: enabled/u, on);
    assert.doesNotMatch(on, /disabled/u, on);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[embed] a dry run issues zero requests and states what it would embed", async () => {
  const server = await embeddingServer();
  const root = await scratch();
  try {
    const { report, text } = await embedBackfill(hiddenSession(), commandConfig(server, root), { apply: false });
    assert.equal(server.state.requests, 0, "a preview must not spend a provider call");
    assert.equal(server.state.inputs.length, 0);
    assert.equal(report.scanned, 5, text);
    assert.equal(report.alreadyCached, 0, text);
    assert.equal(report.embedded, 0, text);
    assert.equal(report.applied, false, text);
    assert.match(text, /backfill \(dry-run\)/u, text);
    assert.match(text, /would embed: 5/u, text);
    assert.match(text, /preview only; no provider call was made/u, text);
    assert.match(text, /applied: no/u, text);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[embed] --apply fills the cache, and a re-apply is a pure cache hit", async () => {
  const server = await embeddingServer();
  const root = await scratch();
  try {
    const cfg = commandConfig(server, root);
    const first = await embedBackfill(hiddenSession(), cfg, { apply: true });
    assert.equal(first.report.embedded, 5, first.text);
    assert.equal(first.report.failed, 0, first.text);
    assert.equal(server.state.inputs.length, 5, "one request per batch, five texts total");
    assert.equal(server.state.inputs.every((text) => text.trim().length > 0), true, "never an empty string");

    const requestsAfterFirst = server.state.requests;
    const second = await embedBackfill(hiddenSession(), cfg, { apply: true });
    assert.deepEqual(second.report, { scanned: 5, alreadyCached: 5, embedded: 0, failed: 0, limit: 200, applied: true }, second.text);
    assert.equal(server.state.requests, requestsAfterFirst, "a cached text is never sent again");
    assert.equal(server.state.inputs.length, 5, "and the input log did not grow");

    const status = await buildEmbedStatus(cfg);
    assert.match(status, /files: 5/u, status);
    assert.match(status, new RegExp("bytes: " + 5 * DIM * 4, "u"), "five vectors of three float32s: " + status);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[embed] --limit N keeps the newest N of the window and says so", async () => {
  const server = await embeddingServer();
  const root = await scratch();
  try {
    const cfg = commandConfig(server, root);
    const { report, text } = await embedBackfill(hiddenSession({ hidden: 8 }), cfg, { apply: true, limit: 3 });
    assert.equal(report.limit, 3, text);
    assert.equal(report.scanned, 3, "the pass is bounded by the flag, not by the window");
    assert.equal(report.embedded, 3, text);
    assert.deepEqual(
      server.state.inputs.slice().sort(),
      ["compacted note 5", "compacted note 6", "compacted note 7"],
      "the NEWEST three were embedded: " + JSON.stringify(server.state.inputs)
    );
    assert.match(text, /candidates: 8 hidden text\(s\)/u, "the report still states the whole window: " + text);
    assert.match(text, /limit: 3/u, text);

    const rest = await embedBackfill(hiddenSession({ hidden: 8 }), cfg, { apply: true, limit: 8 });
    assert.equal(rest.report.alreadyCached, 3, "a wider pass reuses the three already cached");
    assert.equal(rest.report.embedded, 5, "and embeds only the rest");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[embed] empty and whitespace-only bodies are never sent to the endpoint", async () => {
  const server = await embeddingServer();
  const root = await scratch();
  try {
    const cfg = commandConfig(server, root);
    const events = [
      { type: "session" },
      message(0, "compacted real text"),
      message(1, undefined, []),
      message(2, "   "),
      message(3, " \t "),
      message(4, undefined, [{ type: "text", text: "" }])
    ];
    const session = shapedSession(events, []);
    const dry = await embedBackfill(session, cfg, { apply: false });
    assert.equal(dry.report.scanned, 1, "only the one body with text is a candidate: " + dry.text);
    assert.match(dry.text, /candidates: 1 hidden text\(s\)/u, dry.text);

    const applied = await embedBackfill(session, cfg, { apply: true });
    assert.equal(applied.report.embedded, 1, applied.text);
    assert.deepEqual(server.state.inputs, ["compacted real text"], "nothing blank reached the wire: " + JSON.stringify(server.state.inputs));
    assert.equal(server.state.inputs.every((text) => text.trim().length > 0), true);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[embed] the argument grammar rejects garbage rather than interpreting it", async () => {
  const server = await embeddingServer();
  const root = await scratch();
  try {
    const cfg = resolveConfig({
      vectorEnabled: true,
      vectorBaseUrl: server.baseUrl,
      vectorModel: "test-embedding",
      vectorDim: DIM,
      vectorCacheDir: root
    });
    const handler = defineEmbedCommand(cfg).handler;
    const run = (rawInput) => handler({ rawInput, agent: { session: hiddenSession() } });

    for (const rawInput of [
      "explode",
      "backfill --limit",
      "backfill --limit abc",
      "backfill --limit 0",
      "backfill --limit -3",
      "backfill --limit 3.5",
      "backfill --nope",
      "backfill apply",
      "status now",
      "status --apply"
    ]) {
      const result = await run(rawInput);
      assert.equal(result.kind, "error", JSON.stringify(rawInput) + " must be refused: " + JSON.stringify(result));
      assert.match(result.text, /Usage: \/lcm-embed status|--limit/u, JSON.stringify(rawInput) + ": " + result.text);
    }

    const status = await run("status");
    assert.equal(status.kind, "success", status.text);
    assert.match(status.text, /lcm-embed status/u, status.text);

    const preview = await run("backfill");
    assert.equal(preview.kind, "success", preview.text);
    assert.match(preview.text, /dry-run/u, preview.text);

    const apply = await run("backfill --apply --limit 2");
    assert.equal(apply.kind, "success", apply.text);
    assert.match(apply.text, /limit: 2/u, apply.text);
    assert.equal(server.state.inputs.length, 2, "the accepted form really applied its limit");

    const disabled = defineEmbedCommand(
      resolveConfig({
        vectorEnabled: false,
        vectorBaseUrl: server.baseUrl,
        vectorModel: "test-embedding",
        vectorDim: DIM,
        vectorCacheDir: root
      })
    ).handler;
    const refused = await disabled({ rawInput: "backfill --apply", agent: { session: hiddenSession() } });
    assert.equal(refused.kind, "error", refused.text);
    assert.match(refused.text, /vectorEnabled: false/u, "refusing --apply names the switch: " + refused.text);
    assert.equal(server.state.inputs.length, 2, "a refused --apply sends nothing");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
