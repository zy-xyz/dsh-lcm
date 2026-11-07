/**
 * The optional vector recall layer.
 *
 * Four properties decide whether this layer is safe to ship at all, and each
 * one is pinned here:
 *
 *   1. default off is *invisible* — searchSessionHybrid must return exactly what
 *      searchSession returns, so an unconfigured install cannot tell it exists;
 *   2. ranking is cosine, not dot product — the difference only shows up on
 *      unscaled vectors, which is exactly the case a shortcut would get wrong;
 *   3. the disk cache is a real short-circuit — a cache hit sends no request;
 *   4. a failing backend degrades a search, it does not fail one.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { searchSession, searchSessionHybrid } from "../src/search.js";
import { rankByVector } from "../src/vectors.js";

/** A session whose first event is a long dump and whose second is the answer. */
function fixture() {
  const dump = ["BEGIN", ...Array.from({ length: 40 }, () => "target token appears here"), "END"].join("\n");
  const events = [
    { type: "session", id: "s" },
    { type: "tool/result", seq: 0, time: 1, data: { message: { role: "tool", content: [{ type: "text", text: dump }] } } },
    { type: "user/message", seq: 1, time: 1, data: { content: [{ type: "text", text: "we chose integer[] for the target token column" }] } },
    { type: "assistant/message", seq: 2, time: 1, data: { message: { role: "assistant", content: [{ type: "text", text: "noted" }] } } }
  ];
  return {
    events,
    eventAt: (seq) => events.find((event) => event.seq === seq),
    deriveEventMessage: (event) => event.data?.message ?? (event.data?.content === undefined ? null : { role: "user", content: event.data.content })
  };
}

const CONFIG = { maxSearchHits: 50, maxRecallTokens: 100000, rank: "density" };

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
 * @param table - text to vector table.
 * @param status - HTTP status to answer with (non-200 exercises the fallback).
 * @returns the base URL, a request counter, and a closer.
 */
async function embeddingServer(table, status = 200) {
  const state = { requests: 0, batches: [] };
  const server = createServer(async (request, response) => {
    state.requests += 1;
    const body = await readJson(request);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    state.batches.push(inputs.length);
    if (status !== 200) {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "synthetic failure" } }));
      return;
    }
    const data = inputs.map((text, index) => ({ object: "embedding", index, embedding: table[text] }));
    // usage.prompt_tokens is 0 on the real endpoint too: it must never be read.
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

/** Vector settings pointing at one fake server. */
function vectorConfig(server, cacheDir, overrides = {}) {
  return {
    vectorEnabled: true,
    vectorBaseUrl: server.baseUrl,
    vectorModel: "test-embedding",
    vectorDim: 3,
    vectorCacheDir: cacheDir,
    ...overrides
  };
}

/** Fresh cache directory per test, removed when the test ends. */
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "lcm-vectors-"));
  return { dir, clean: () => rm(dir, { recursive: true, force: true }) };
}

test("the layer is off by default: hybrid output is byte-identical to lexical", async () => {
  const hybrid = await searchSessionHybrid(fixture(), "target token", CONFIG);
  const lexical = searchSession(fixture(), "target token", CONFIG);
  assert.deepEqual(hybrid, lexical, "the default path must add no field and no reordering");
  assert.equal(Buffer.compare(Buffer.from(hybrid.text), Buffer.from(lexical.text)), 0);
  assert.equal(hybrid.mode, undefined);
  assert.equal(hybrid.notice, undefined);

  // Asking for a vector rank while the layer is off stays lexical, in density
  // order — never the unsorted log order an unknown rank would produce.
  const off = await searchSessionHybrid(fixture(), "target token", { ...CONFIG, rank: "hybrid" });
  assert.deepEqual(off.hits.map((hit) => hit.seq), lexical.hits.map((hit) => hit.seq));
  assert.equal(off.notice, undefined);
});

test("rankByVector orders by cosine, not by dot product", async () => {
  const cache = await scratch();
  const query = "how do we store the target token column";
  // beta has the largest dot product with the query (5) but a smaller cosine
  // (0.707) than alpha (1.0): dot-product ranking would invert this order.
  const server = await embeddingServer({
    [query]: [1, 0, 0],
    alpha: [1, 0, 0],
    beta: [5, 5, 0],
    gamma: [0, 1, 0]
  });
  try {
    const ranked = await rankByVector(
      vectorConfig(server, cache.dir),
      [{ seq: 1, text: "alpha" }, { seq: 2, text: "beta" }, { seq: 3, text: "gamma" }],
      query
    );
    assert.deepEqual(ranked.map((entry) => entry.seq), [1, 2, 3]);
    assert.ok(Math.abs(ranked[0].score - 1) < 1e-6, "identical direction is cosine 1");
    assert.ok(Math.abs(ranked[1].score - Math.SQRT1_2) < 1e-6, "unscaled vector keeps its cosine");
    assert.ok(Math.abs(ranked[2].score) < 1e-6, "orthogonal vectors score 0");
    assert.deepEqual(server.state.batches, [4], "one batched request for query plus items");
  } finally {
    await server.close();
    await cache.clean();
  }
});

test("a cached vector is reused instead of re-embedded", async () => {
  const cache = await scratch();
  const query = "how do we store the target token column";
  const server = await embeddingServer({ [query]: [1, 0, 0], alpha: [1, 0, 0], beta: [0, 1, 0] });
  try {
    const items = [{ seq: 1, text: "alpha" }, { seq: 2, text: "beta" }];
    const cfg = vectorConfig(server, cache.dir);
    const first = await rankByVector(cfg, items, query);
    assert.equal(server.state.requests, 1);
    const second = await rankByVector(cfg, items, query);
    assert.equal(server.state.requests, 1, "a warm cache must not re-embed");
    assert.deepEqual(second, first, "the cached path reproduces the ranked result");
  } finally {
    await server.close();
    await cache.clean();
  }
});

test("a failing backend degrades to the lexical result with one notice", async () => {
  const cache = await scratch();
  const server = await embeddingServer({}, 500);
  try {
    const config = { ...CONFIG, rank: "hybrid", ...vectorConfig(server, cache.dir) };
    const result = await searchSessionHybrid(fixture(), "target token", config);
    assert.match(result.notice, /^vector backend unreachable: .*returned HTTP 500.*; fell back to lexical$/);
    assert.match(result.text, /fell back to lexical/);
    assert.equal(result.mode, undefined, "a degraded result is the lexical result");
    assert.deepEqual(
      result.hits.map((hit) => hit.seq),
      searchSession(fixture(), "target token", CONFIG).hits.map((hit) => hit.seq)
    );
    assert.equal(result.rank, "density", "the fallback keeps the lexical ranking");
  } finally {
    await server.close();
    await cache.clean();
  }
});
