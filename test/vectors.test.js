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
 *   4. a failing backend degrades a search, it does not fail one;
 *   5. one refused *string* costs that string, not the whole question — the
 *      backend defect measured in production, isolated by bisection.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { searchSession, searchSessionHybrid } from "../src/search.js";
import { resolveConfig as resolveToolConfig } from "../src/tool.js";
import {
  DEFAULT_VECTOR_CANDIDATE_LIMIT,
  pruneForeignVectorCaches,
  rankByVector,
  resolveVectorAuth,
  resolveVectorConfig,
  vectorCache,
  vectorCacheStats
} from "../src/vectors.js";

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
  const state = { requests: 0, batches: [], inputs: [], authorizations: [] };
  const server = createServer(async (request, response) => {
    state.requests += 1;
    // Recorded so the auth test can assert on the wire, not on our own intent.
    state.authorizations.push(request.headers.authorization ?? null);
    const body = await readJson(request);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    state.batches.push(inputs.length);
    state.inputs.push(...inputs);
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

/**
 * A stand-in endpoint with one input-sensitive defect.
 *
 * The real backend (measured) rejects specific strings with a stable HTTP 400
 * whose body is `invalid_type expected number received nan`, while every other
 * string in the same batch is fine. This reproduces exactly that: a batch
 * containing a refused string fails as a whole, which is what forces the client
 * to bisect.
 *
 * @param table - text to vector table.
 * @param isPoison - predicate deciding which input strings are refused.
 * @returns the base URL, a request counter, and a closer.
 */
async function inputSensitiveServer(table, isPoison) {
  const state = { requests: 0, batches: [], refused: 0 };
  const server = createServer(async (request, response) => {
    state.requests += 1;
    const body = await readJson(request);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    state.batches.push(inputs.length);
    if (inputs.some((text) => isPoison(text) || table[text] === undefined)) {
      state.refused += 1;
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid_type expected number received nan" } }));
      return;
    }
    const data = inputs.map((text, index) => ({ object: "embedding", index, embedding: table[text] }));
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

/** The exact string the production backend refuses. */
const POISON = "import x from 'rn-maps';";

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

test("a gateway key comes from the environment, and a keyless backend gets no header", async () => {
  // The only measured backend until now was a local LM Studio, which needs no
  // auth, so this layer sent no Authorization header at all. A hosted gateway
  // answers 401 without one. The key is addressed by environment-variable NAME
  // and never written in the composition, because this configuration ships in
  // the repository.
  const cache = await scratch();
  const query = "how do we store the target token column";
  const server = await embeddingServer({ [query]: [1, 0, 0], alpha: [1, 0, 0] });
  const NAME = "LCM_TEST_EMBED_KEY";
  try {
    const items = [{ seq: 1, text: "alpha" }];

    // Named but unset: no header. A backend that needs one answers 401, and that
    // surfaces in the degradation notice rather than being swallowed here.
    delete process.env[NAME];
    await rankByVector(vectorConfig(server, cache.dir, { vectorApiKeyEnv: NAME }), items, query);
    assert.equal(server.state.authorizations.at(-1), null, "an unset variable must send no header");

    // Named and set: a bearer token on the wire.
    process.env[NAME] = "sk-test-value";
    const cache2 = await scratch();
    try {
      await rankByVector(vectorConfig(server, cache2.dir, { vectorApiKeyEnv: NAME }), items, query);
      assert.equal(server.state.authorizations.at(-1), "Bearer sk-test-value", "the environment value must reach the wire as a bearer token");
    } finally {
      await cache2.clean();
    }

    // Not configured at all: no header, unchanged from the keyless behaviour.
    const cache3 = await scratch();
    try {
      await rankByVector(vectorConfig(server, cache3.dir), items, query);
      assert.equal(server.state.authorizations.at(-1), null, "the default sends no header");
    } finally {
      await cache3.clean();
    }
  } finally {
    delete process.env[NAME];
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


test("one poisoned text is skipped, not fatal: the rest still ranks", async () => {
  const cache = await scratch();
  const query = "how do we store the target token column";
  // Distinct cosines against the query, so the surviving order is not a tie.
  const table = { [query]: [1, 0, 0], alpha: [1, 0, 0], beta: [1, 1, 0], gamma: [0, 0, 1] };
  const server = await inputSensitiveServer(table, (text) => text === POISON);
  try {
    const items = [
      { seq: 1, text: "alpha" },
      { seq: 2, text: POISON },
      { seq: 3, text: "beta" },
      { seq: 4, text: "gamma" }
    ];
    const ranked = await rankByVector(vectorConfig(server, cache.dir), items, query);
    assert.deepEqual(ranked.map((entry) => entry.seq), [1, 3, 4], "the poisoned event is simply absent");
    assert.equal(ranked.skipped, 1, "exactly one candidate was skipped");
    assert.deepEqual(ranked.failedSeqs, [2], "the skipped seq is reported");
    assert.ok(Math.abs(ranked[0].score - 1) < 1e-6, "the surviving ranking is still cosine");
  } finally {
    await server.close();
    await cache.clean();
  }
});

test("a poisoned text is recovered by one cleaned variant, so nothing is skipped", async () => {
  const cache = await scratch();
  const query = "how do we store the target token column";
  // Only the space-prefixed form is accepted: the measured workaround.
  const table = { [query]: [1, 0, 0], alpha: [1, 0, 0], [" " + POISON]: [0, 1, 0] };
  const server = await inputSensitiveServer(table, (text) => text === POISON);
  try {
    const items = [{ seq: 1, text: "alpha" }, { seq: 2, text: POISON }];
    const ranked = await rankByVector(vectorConfig(server, cache.dir), items, query);
    assert.deepEqual(ranked.map((entry) => entry.seq), [1, 2], "the cleaned variant is ranked in place");
    assert.equal(ranked.skipped, 0, "the retry means nothing is skipped");
    assert.deepEqual(ranked.failedSeqs, []);
  } finally {
    await server.close();
    await cache.clean();
  }
});

test("a backend that refuses everything still fails the call", async () => {
  const cache = await scratch();
  const items = Array.from({ length: 31 }, (_, index) => ({ seq: index + 1, text: "text " + index }));
  const server = await inputSensitiveServer({}, () => true);
  try {
    await assert.rejects(
      () => rankByVector(vectorConfig(server, cache.dir), items, "the query"),
      (error) => error.name === "VectorBackendError" && /HTTP 400/.test(error.message),
      "an unusable backend is still an error, not a silent empty ranking"
    );
    // Both halves refused at the top level: the payload, not one string, so the
    // descent stops instead of walking every text.
    assert.ok(
      server.state.requests <= 24,
      "a total refusal must not be bisected per text, saw " + server.state.requests
    );
  } finally {
    await server.close();
    await cache.clean();
  }
});

/**
 * A session of `count` one-line events. Events before `similarFrom` are the
 * semantic answer (vector [1,0,0] against the query below), everything after it
 * is noise ([0,1,0]). Neither group contains the query word literally, so the
 * lexical route cannot rescue an event the semantic window excludes.
 * @param count - event count.
 * @param similarFrom - first seq that carries the answer direction.
 * @param query - query text mapped to [1,0,0] too.
 * @returns session-shaped value plus the fake server's text table.
 */
function longSession(count, similarFrom, query) {
  const events = [{ type: "session", id: "s" }];
  const table = { [query]: [1, 0, 0] };
  for (let seq = 0; seq < count; seq += 1) {
    const text = seq >= similarFrom ? "unrelated line " + seq : "the animal fact " + seq;
    table[text] = seq >= similarFrom ? [0, 1, 0] : [1, 0, 0];
    events.push({ type: "user/message", seq, time: 1, data: { content: [{ type: "text", text }] } });
  }
  return {
    events,
    table,
    eventAt: (seq) => events.find((event) => event.seq === seq),
    deriveEventMessage: (event) => event.data?.message ?? (event.data?.content === undefined ? null : { role: "user", content: event.data.content })
  };
}

/**
 * A session where the newest `surfaceFrom`..end events are still ON the surface
 * (the model reads them verbatim) and the rest is compacted. Only the compacted
 * region can be the semantic route's job.
 */
function sessionWithSurface(count, surfaceFrom, similarSeqs, query) {
  const events = [{ type: "session", id: "s" }];
  const table = { [query]: [1, 0, 0] };
  for (let seq = 0; seq < count; seq += 1) {
    const similar = similarSeqs.includes(seq);
    const text = (similar ? "the animal fact " : "unrelated line ") + seq;
    table[text] = similar ? [1, 0, 0] : [0, 1, 0];
    events.push({ type: "user/message", seq, time: 1, data: { content: [{ type: "text", text }] } });
  }
  return {
    events,
    table,
    surface: { nodes: Array.from({ length: count - surfaceFrom }, (_, index) => surfaceFrom + index) },
    eventAt: (seq) => events.find((event) => event.seq === seq),
    deriveEventMessage: (event) => event.data?.message ?? (event.data?.content === undefined ? null : { role: "user", content: event.data.content })
  };
}

test("the window covers the compacted region, not the tail the model already reads", async () => {
  const cache = await scratch();
  // 80 events: 0..39 compacted, 40..79 still on the surface. The only semantic
  // answer is seq 35, i.e. inside the compacted region's newest 10 - while a
  // newest-first window over the WHOLE log would take 79..70 and miss it.
  const session = sessionWithSurface(80, 40, [35], "zebra");
  const server = await embeddingServer(session.table);
  try {
    const config = { ...CONFIG, rank: "vector", ...vectorConfig(server, cache.dir) };
    const result = await searchSessionHybrid(session, "zebra", { ...config, vectorCandidateLimit: 10 });
    assert.equal(result.hits[0]?.seq, 35, "the compacted answer must be the first hit");
    assert.deepEqual(result.hits.map((hit) => hit.seq).slice(0, 3), [35, 39, 38]);
    assert.ok(
      result.hits.every((hit) => hit.seq < 40),
      "no visible-surface event may be embedded or returned, saw " + result.hits.map((hit) => hit.seq).join(",")
    );
    const visibleSent = server.state.inputs.filter((text) => /unrelated line (4|5|6|7)\d/.test(text));
    assert.deepEqual(visibleSent, [], "events the surface already shows must not be sent to the embedder");
    assert.match(result.text, /10 newest compacted event\(s\) of 40/, "the header states which region the window covered");
  } finally {
    await server.close();
    await cache.clean();
  }
});

test("the candidate budget is tokens, so a few huge events cannot buy a long first search", async () => {
  const cache = await scratch();
  // 40 compacted events of ~1000 chars each: a count cap would embed all of
  // them, a token budget must stop early. Cost on the real endpoint is per
  // character (measured: 27 ms at 40 chars, 230 ms at 4000), not per event.
  const events = [{ type: "session", id: "s" }];
  const table = { zebra: [1, 0, 0] };
  for (let seq = 0; seq < 40; seq += 1) {
    const text = ("the animal fact " + seq + " ").padEnd(1000, "x");
    table[text] = [1, 0, 0];
    events.push({ type: "user/message", seq, time: 1, data: { content: [{ type: "text", text }] } });
  }
  const session = {
    events,
    table,
    surface: { nodes: [] },
    eventAt: (seq) => events.find((event) => event.seq === seq),
    deriveEventMessage: (event) => event.data?.message ?? (event.data?.content === undefined ? null : { role: "user", content: event.data.content })
  };
  const server = await embeddingServer(session.table);
  try {
    const config = { ...CONFIG, rank: "vector", ...vectorConfig(server, cache.dir) };
    // ~450 tokens each at this size, so a 2000-token budget admits a handful.
    const result = await searchSessionHybrid(session, "zebra", { ...config, vectorCandidateTokens: 2000, vectorCandidateLimit: 40 });
    const candidates = server.state.inputs.length - 1;
    assert.ok(candidates > 0 && candidates < 10, "the token budget must bind before the count cap, saw " + candidates);
    assert.ok(result.hits.length > 0, "and the search still answers");
  } finally {
    await server.close();
    await cache.clean();
  }
});

test("the candidate bound is a documented default and survives a resolved round trip", () => {
  // The number that makes one first search affordable on the measured endpoint
  // (~90 ms per text): 500 candidates, ~48 s cold, then cached per text.
  assert.equal(DEFAULT_VECTOR_CANDIDATE_LIMIT, 500, "the default is the measured cost, not a guess");
  assert.equal(resolveVectorConfig({}).candidateLimit, DEFAULT_VECTOR_CANDIDATE_LIMIT);
  assert.equal(resolveVectorConfig({ vectorCandidateLimit: 40 }).candidateLimit, 40);
  assert.equal(
    resolveVectorConfig(resolveVectorConfig({ vectorCandidateLimit: 40 })).candidateLimit,
    40,
    "a resolved record must not be re-derived with defaults"
  );
  assert.throws(() => resolveVectorConfig({ vectorCandidateLimit: 0 }), /vectorCandidateLimit/);
});

test("the tool row's config is what turns the layer on, and it selects a vector rank", () => {
  // The wiring defect this pins: the keys used to sit on the COMPACTION row,
  // which never reads them, so this resolve returned enabled: false while
  // --dump-config looked configured.
  const off = resolveToolConfig({});
  assert.equal(off.enabled, false, "an unconfigured tool row is inert");
  assert.equal(off.rank, "density", "and lexical, so no request and no reordering");
  const on = resolveToolConfig({
    rank: "hybrid",
    vectorEnabled: true,
    vectorBaseUrl: "http://127.0.0.1:1/v1",
    vectorModel: "m",
    vectorDim: 3
  });
  assert.equal(on.enabled, true, "the tool row's keys reach the search handler");
  assert.equal(on.rank, "hybrid");
  assert.equal(on.candidateLimit, DEFAULT_VECTOR_CANDIDATE_LIMIT, "the bound rides along resolved");
});

test("the bound is respected: one search embeds the query plus at most N events", async () => {
  const cache = await scratch();
  // The answer direction sits on seqs 50..54, inside a 10-event window (50..59).
  const session = longSession(60, 55, "zebra");
  const server = await embeddingServer(session.table);
  try {
    const config = { ...CONFIG, rank: "vector", ...vectorConfig(server, cache.dir, { vectorTopK: 8 }) };
    const result = await searchSessionHybrid(session, "zebra", { ...config, vectorCandidateLimit: 10 });
    const sent = server.state.batches.reduce((total, size) => total + size, 0);
    assert.ok(sent <= 11, "query + the 10 newest events, saw " + sent + " texts");
    assert.deepEqual(result.hits.map((hit) => hit.seq).slice(0, 5), [54, 53, 52, 51, 50], "the answer is inside the window");
    assert.equal(result.mode, "vector");
    assert.match(result.text, /top 8 of 10 candidate event\(s\), \d+ tokens, seq >= 50/, "the result says what it covered");
  } finally {
    await server.close();
    await cache.clean();
  }
});

test("a session larger than the bound still returns hits, and what the bound gives up is not hidden", async () => {
  const cache = await scratch();
  // The answer is the OLDEST 50 events here. A 10-event window cannot see them,
  // and the query word appears in no event, so no route can: this is exactly the
  // recall the bound costs, pinned so nobody can claim the window is free.
  const session = longSession(60, 50, "zebra");
  const server = await embeddingServer(session.table);
  try {
    const config = { ...CONFIG, rank: "hybrid", ...vectorConfig(server, cache.dir, { vectorCandidateLimit: 10 }) };
    const result = await searchSessionHybrid(session, "zebra", config);
    assert.ok(result.hits.length > 0, "a 60-event session still returns hits under a 10-event window");
    assert.equal(result.totalMatches, 0, "the lexical route matches nothing, so only the window could have found it");
    assert.ok(
      result.hits.every((hit) => hit.seq >= 50),
      "and no hit comes from outside the window: the old answer is unreachable by meaning, saw " + result.hits.map((hit) => hit.seq).join(",")
    );
    const sent = server.state.batches.reduce((total, size) => total + size, 0);
    assert.ok(sent <= 11, "the oversized session must not widen the request, saw " + sent + " texts");
  } finally {
    await server.close();
    await cache.clean();
  }
});

test("bisection bounds the requests: one poisoned text is not a linear scan", async () => {
  const cache = await scratch();
  const query = "q";
  const items = Array.from({ length: 31 }, (_, index) => ({ seq: index + 1, text: "text " + index }));
  const table = { [query]: [1, 0, 0] };
  for (const item of items) table[item.text] = [0, 1, 0];
  const server = await inputSensitiveServer(table, (text) => text === "text 17");
  try {
    const ranked = await rankByVector(vectorConfig(server, cache.dir), items, query, undefined, 0);
    assert.equal(ranked.skipped, 1);
    // One request for the healthy batch, then a descent: log2(32) = 5 splits at
    // two requests each, plus the refused text and its cleaned variant. A
    // per-text retry would be 32 requests, so the ceiling is 2*log2(n) + 6 and
    // the sublinearity check is half the log size.
    assert.ok(
      server.state.requests <= 2 * Math.log2(32) + 6,
      "expected <= 16 requests, saw " + server.state.requests
    );
    assert.ok(
      server.state.requests < items.length / 2,
      "bisection must be well below one request per text, saw " + server.state.requests
    );
  } finally {
    await server.close();
    await cache.clean();
  }
});

/**
 * A session whose newest non-visible events are all log plumbing.
 *
 * Plumbing (step/start, tool/ptc-dispatch, plugin:translator/request) never
 * joins the surface, so "not visible" is the wrong test for "compacted content":
 * a newest-first window over that set spends the whole embedding budget on
 * records the model never read. The only compacted *content* event here is the
 * tool/result at seq 0, and it carries the semantic answer.
 * @param plumbingCount - how many newer plumbing records to stack on top.
 * @returns session-shaped value plus the fake server's text table.
 */
function plumbingOverCompactedResult(plumbingCount) {
  const answer = "the animal fact lives in the compacted tool result";
  const events = [{ type: "session", id: "s" }];
  const table = { zebra: [1, 0, 0], [answer]: [1, 0, 0] };
  events.push({ type: "tool/result", seq: 0, time: 1, data: { message: { role: "tool", content: [{ type: "text", text: answer }] } } });
  const plumbing = ["step/start", "tool/ptc-dispatch", "plugin:translator/request"];
  for (let index = 0; index < plumbingCount; index += 1) {
    const type = plumbing[index % plumbing.length];
    const data = { note: "dispatch noise " + index };
    // Keyed by the body the reader actually renders: a plumbing event derives no
    // message, so it falls back to the labelled JSON dump.
    table["[" + type + "]\n" + JSON.stringify(data)] = [0, 1, 0];
    events.push({ type, seq: index + 1, time: 1, data });
  }
  return {
    events,
    table,
    answer,
    surface: { nodes: [] },
    eventAt: (seq) => events.find((event) => event.seq === seq),
    deriveEventMessage: (event) => event.data?.message ?? (event.data?.content === undefined ? null : { role: "user", content: event.data.content })
  };
}

test("the semantic route embeds compacted content, never log plumbing", async () => {
  const cache = await scratch();
  const session = plumbingOverCompactedResult(30);
  const server = await embeddingServer(session.table);
  try {
    const config = { ...CONFIG, rank: "vector", ...vectorConfig(server, cache.dir, { vectorCandidateLimit: 10 }) };
    const result = await searchSessionHybrid(session, "zebra", config);
    assert.equal(result.hits[0]?.seq, 0, "the compacted tool/result is the answer, saw " + result.hits.map((hit) => hit.seq).join(","));
    const embedded = server.state.inputs.filter((text) => text !== "zebra");
    assert.deepEqual(embedded, [session.answer], "only surface-eligible content is embedded, saw " + JSON.stringify(embedded));
  } finally {
    await server.close();
    await cache.clean();
  }
});

/**
 * A session where plumbing outnumbers compacted content, so the two possible
 * readings of "of N compacted event(s)" differ by an order of magnitude.
 * @returns session-shaped value plus the fake server's text table.
 */
function plumbingDominatedSession() {
  const events = [{ type: "session", id: "s" }];
  const table = { zebra: [1, 0, 0] };
  // seq 0: the only compacted CONTENT event.
  const compacted = "the animal fact zero";
  table[compacted] = [1, 0, 0];
  events.push({ type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: compacted }] } });
  // seq 1..20: plumbing, never on the surface.
  for (let index = 0; index < 20; index += 1) {
    const data = { note: "step noise " + index };
    table["[step/start]\n" + JSON.stringify(data)] = [0, 1, 0];
    events.push({ type: "step/start", seq: index + 1, time: 1, data });
  }
  // seq 21..23: content the surface still shows.
  for (let seq = 21; seq <= 23; seq += 1) {
    const text = "visible content " + seq;
    table[text] = [0, 1, 0];
    events.push({ type: "user/message", seq, time: 1, data: { content: [{ type: "text", text }] } });
  }
  return {
    events,
    table,
    surface: { nodes: [21, 22, 23] },
    eventAt: (seq) => events.find((event) => event.seq === seq),
    deriveEventMessage: (event) => event.data?.message ?? (event.data?.content === undefined ? null : { role: "user", content: event.data.content })
  };
}

test("the header's compacted count counts content, not log plumbing", async () => {
  const cache = await scratch();
  const session = plumbingDominatedSession();
  const server = await embeddingServer(session.table);
  try {
    const config = { ...CONFIG, rank: "vector", ...vectorConfig(server, cache.dir) };
    const result = await searchSessionHybrid(session, "zebra", config);
    assert.match(
      result.text,
      /newest compacted event\(s\) of 1,/,
      "one compacted content event, not 21 hidden log records, saw: " + result.text.split("\n")[0]
    );
    assert.equal(result.hits[0]?.seq, 0);
  } finally {
    await server.close();
    await cache.clean();
  }
});


/**
 * A temp DSH_HOME holding one credential store, shaped like the real one:
 * a nested `records:` block first, then the flat `refs:` block this layer
 * reads.
 * @param refs - reference name to value.
 * @returns the directory and a closer.
 */
async function scratchCredentialHome(refs) {
  const dir = await mkdtemp(join(tmpdir(), "lcm-dsh-home-"));
  const lines = ["version: 1", "records:", "  client-connection/browser-session:", "    kind: default", "refs:"];
  for (const [name, value] of Object.entries(refs)) lines.push("  " + name + ": " + value);
  await writeFile(join(dir, ".credentials.yaml"), lines.join("\n") + "\n", "utf8");
  return { dir, clean: () => rm(dir, { recursive: true, force: true }) };
}

test("the credential store answers when the variable is missing, and the environment outranks it", async () => {
  // A hosted gateway needs a token, but exporting a variable into every process
  // is not operable: dsh already keeps credentials in $DSH_HOME/.credentials.yaml.
  // The store is the fallback, never the override — a rotated environment value
  // must win without touching the file.
  const cache = await scratch();
  const home = await scratchCredentialHome({ LCM_TEST_STORE_KEY: "sk-test-value" });
  const query = "how do we store the target token column";
  const server = await embeddingServer({ [query]: [1, 0, 0], alpha: [1, 0, 0] });
  const NAME = "LCM_TEST_STORE_KEY";
  const savedDshHome = process.env.DSH_HOME;
  const savedName = process.env[NAME];
  const items = [{ seq: 1, text: "alpha" }];

  try {
    process.env.DSH_HOME = home.dir;
    delete process.env[NAME];

    // Unset variable, value in the store: the store answers.
    const stored = await resolveVectorAuth({ vectorApiKeyEnv: NAME });
    assert.equal(stored.source, "credential-store", "an unset variable must fall back to the store");
    assert.deepEqual(stored.header, { authorization: "Bearer sk-test-value" });

    const cacheStore = await scratch();
    try {
      await rankByVector(vectorConfig(server, cacheStore.dir, { vectorApiKeyEnv: NAME }), items, query);
      assert.equal(server.state.authorizations.at(-1), "Bearer sk-test-value", "the stored value must reach the wire");
    } finally {
      await cacheStore.clean();
    }

    // Set variable: the environment wins over the same name in the store.
    process.env[NAME] = "sk-env-value";
    const fromEnv = await resolveVectorAuth({ vectorApiKeyEnv: NAME });
    assert.equal(fromEnv.source, "env", "a set variable must be reported as the env source");
    assert.deepEqual(fromEnv.header, { authorization: "Bearer sk-env-value" });

    const cacheEnv = await scratch();
    try {
      await rankByVector(vectorConfig(server, cacheEnv.dir, { vectorApiKeyEnv: NAME }), items, query);
      assert.equal(server.state.authorizations.at(-1), "Bearer sk-env-value", "the environment must outrank the store");
    } finally {
      await cacheEnv.clean();
    }

    // Named but empty: not a key, so the store answers again.
    process.env[NAME] = "";
    const emptyValue = await resolveVectorAuth({ vectorApiKeyEnv: NAME });
    assert.equal(emptyValue.source, "credential-store", "an empty variable must not shadow the store");

    // Neither source: no header, and a keyless backend stays keyless.
    const emptyHome = await mkdtemp(join(tmpdir(), "lcm-dsh-home-empty-"));
    try {
      process.env.DSH_HOME = emptyHome;
      delete process.env[NAME];
      assert.deepEqual(await resolveVectorAuth({ vectorApiKeyEnv: NAME }), { header: {}, source: "none" });

      const cacheNone = await scratch();
      try {
        await rankByVector(vectorConfig(server, cacheNone.dir, { vectorApiKeyEnv: NAME }), items, query);
        assert.equal(server.state.authorizations.at(-1), null, "no source must mean no header");
      } finally {
        await cacheNone.clean();
      }
    } finally {
      await rm(emptyHome, { recursive: true, force: true });
    }

    // No configured name at all: "none" without reading any store, unchanged
    // from the keyless behaviour this layer shipped with.
    assert.deepEqual(await resolveVectorAuth({}), { header: {}, source: "none" });
    assert.deepEqual(await resolveVectorAuth({ vectorApiKeyEnv: "" }), { header: {}, source: "none" });
  } finally {
    if (savedDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedDshHome;
    if (savedName === undefined) delete process.env[NAME];
    else process.env[NAME] = savedName;
    await server.close();
    await cache.clean();
    await home.clean();
  }
});

test("two models own different cache directories and never read each other's vectors", async () => {
  // Flat, both models wrote into one directory and an old model's files were
  // indistinguishable from live ones. The directory now names the owner.
  const cache = await scratch();
  const query = "how do we store the target token column";
  const server = await embeddingServer({ [query]: [1, 0, 0], alpha: [1, 0, 0] });
  const items = [{ seq: 1, text: "alpha" }];
  try {
    const modelA = vectorConfig(server, cache.dir, { vectorModel: "model-a" });
    const modelB = vectorConfig(server, cache.dir, { vectorModel: "model-b" });
    const cacheA = vectorCache(modelA);
    const cacheB = vectorCache(modelB);

    assert.notEqual(cacheA.dir, cacheB.dir, "each model must own its own directory");
    assert.equal(dirname(cacheA.dir), cache.dir, "both directories sit under the configured root");
    assert.match(cacheA.dir, /[0-9a-f]{12}-3$/, "the directory names the model digest and the vector width");

    await rankByVector(modelA, items, query);
    assert.equal(server.state.requests, 1);
    const statsA = await vectorCacheStats(modelA);
    assert.deepEqual(
      { dir: statsA.dir, model: statsA.model, dim: statsA.dim, files: statsA.files },
      { dir: cacheA.dir, model: "model-a", dim: 3, files: 2 },
      "the query and the candidate are both on disk"
    );
    assert.equal(statsA.bytes, 2 * 3 * 4, "one headerless Float32 triple per file");

    // The same text under a second model is a miss, so the backend is asked
    // again instead of serving the first model's geometry.
    await rankByVector(modelB, items, query);
    assert.equal(server.state.requests, 2, "the second model must not reuse the first model's vectors");
    const statsB = await vectorCacheStats(modelB);
    assert.equal(statsB.files, 2);
    assert.notEqual(statsB.dir, statsA.dir);
    assert.notEqual(cacheA.path("alpha"), cacheB.path("alpha"), "the same text resolves to two files");

    // A text only model A embedded is absent for model B.
    await cacheA.set("gamma", Float32Array.from([0, 1, 0]));
    assert.equal(await cacheB.get("gamma"), null, "model B must not read model A's vector");
    assert.deepEqual(Array.from(await cacheA.get("gamma")), [0, 1, 0], "model A still reads its own");
  } finally {
    await server.close();
    await cache.clean();
  }
});

test("vectorCacheStats reports what is on disk, and pruneForeignVectorCaches drops a stale model", async () => {
  // No request is made here: these are the cache-management surfaces, and the
  // root is the layer's own directory.
  const cache = await scratch();
  const currentConfig = {
    vectorEnabled: true,
    vectorBaseUrl: "http://127.0.0.1:1/v1",
    vectorModel: "model-a",
    vectorDim: 3,
    vectorCacheDir: cache.dir
  };
  const staleConfig = { ...currentConfig, vectorModel: "model-b" };
  try {
    const currentCache = vectorCache(currentConfig);
    const staleCache = vectorCache(staleConfig);

    // Nothing cached yet: zeros, not an error, and the directory is still named.
    const empty = await vectorCacheStats(currentConfig);
    assert.deepEqual(empty, { dir: currentCache.dir, model: "model-a", dim: 3, files: 0, bytes: 0 });

    await currentCache.set("alpha", Float32Array.from([1, 0, 0]));
    await staleCache.set("alpha", Float32Array.from([0, 1, 0]));
    await staleCache.set("beta", Float32Array.from([0, 0, 1]));

    const currentStats = await vectorCacheStats(currentConfig);
    assert.equal(currentStats.files, 1, "exactly the current model's file is counted");
    assert.equal(currentStats.bytes, 3 * 4);
    assert.deepEqual((await vectorCacheStats(staleConfig)).files, 2);

    const pruned = await pruneForeignVectorCaches(currentConfig);
    assert.deepEqual(pruned, { removed: 1, bytes: 2 * 3 * 4 }, "the stale model is reported byte for byte");
    await assert.rejects(() => readdir(staleCache.dir), { code: "ENOENT" }, "the foreign directory must be gone");

    const kept = await vectorCacheStats(currentConfig);
    assert.deepEqual(kept, currentStats, "the current model's directory is untouched");
    assert.deepEqual(Array.from(await currentCache.get("alpha")), [1, 0, 0], "and still readable");

    assert.deepEqual(await pruneForeignVectorCaches(currentConfig), { removed: 0, bytes: 0 }, "a second prune is a no-op");

    const absent = { ...currentConfig, vectorCacheDir: join(cache.dir, "absent") };
    assert.deepEqual(await pruneForeignVectorCaches(absent), { removed: 0, bytes: 0 }, "a missing root prunes nothing");
    const absentStats = await vectorCacheStats(absent);
    assert.equal(absentStats.files, 0);
    assert.equal(absentStats.bytes, 0);
    assert.equal(absentStats.dir.startsWith(join(cache.dir, "absent")), true, "the missing path is still reported");
  } finally {
    await cache.clean();
  }
});

