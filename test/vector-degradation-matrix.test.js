/**
 * Vector degradation matrix: failure is never fatal.
 *
 * The layer's contract is that an embedding backend can be down, refusing, out
 * of key, or speaking the wrong shape, and a search still answers out of the
 * lexical route with exactly one notice line. Each failure class is pinned here
 * against its own loopback stub, plus the two abort properties: a caller signal
 * is honoured, and an aborted request is not retried.
 *
 * Run with: node --test test/vector-degradation-matrix.test.js
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { searchSession, searchSessionHybrid } from "../src/search.js";
import { embedTexts } from "../src/vectors.js";

const DIM = 3;

/** Read one JSON request body. */
function readJson(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => resolve(JSON.parse(raw)));
  });
}

/** One loopback endpoint whose answer `respond` decides. */
async function stubServer(respond) {
  const state = { requests: 0, inputs: [], authorizations: [] };
  const server = createServer(async (request, response) => {
    state.requests += 1;
    state.authorizations.push(request.headers.authorization ?? null);
    const body = await readJson(request).catch(() => ({}));
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    state.inputs.push(...inputs);
    const out = respond({ inputs, requestIndex: state.requests, body });
    if (out.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, out.delayMs));
    if (response.destroyed) return;
    response.writeHead(out.status ?? 200, { "content-type": out.contentType ?? "application/json" });
    response.end(out.body ?? "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    state,
    baseUrl: "http://127.0.0.1:" + server.address().port + "/v1",
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** A URL nothing is listening on: bind, take the port, close. */
async function deadUrl() {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return "http://127.0.0.1:" + port + "/v1";
}

/** The session every case searches: one compacted hit, one compacted non-hit. */
function session() {
  const events = [
    { type: "session" },
    { seq: 0, type: "user/message", data: { content: [{ type: "text", text: "compacted deploy target token" }] } },
    { seq: 1, type: "user/message", data: { content: [{ type: "text", text: "compacted unrelated note" }] } }
  ];
  const bySeq = new Map(events.filter((event) => Number.isSafeInteger(event.seq)).map((event) => [event.seq, event]));
  return {
    id: "s",
    events,
    surface: { nodes: [] },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => (event.data?.content === undefined ? null : { role: "user", content: event.data.content })
  };
}

/** A valid embedding answer for any input. */
function goodBody(inputs) {
  return JSON.stringify({
    object: "list",
    data: inputs.map((text, index) => ({ object: "embedding", index, embedding: [1, (text.length % 5) + 1, 0.25] }))
  });
}

/** Vector settings for one base URL and cache root. */
function cfgOf(baseUrl, root) {
  return {
    maxSearchHits: 50,
    maxRecallTokens: 100000,
    vectorEnabled: true,
    vectorBaseUrl: baseUrl,
    vectorModel: "test-embedding",
    vectorDim: DIM,
    vectorCacheDir: root
  };
}

/** A fresh temp root. */
function scratch() {
  return mkdtemp(join(tmpdir(), "lcm-vec-degrade-"));
}

/** Poll until `predicate` holds, so no assertion depends on a sleeper race. */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

/** The failure classes, each with the notice fragment it must produce. */
const FAILURES = [
  {
    label: "HTTP 500",
    pattern: /HTTP 500/u,
    serve: () => stubServer(() => ({ status: 500, body: JSON.stringify({ error: { message: "upstream down" } }) }))
  },
  {
    label: "HTTP 401",
    pattern: /HTTP 401/u,
    serve: () => stubServer(() => ({ status: 401, body: JSON.stringify({ error: { message: "no key" } }) }))
  },
  {
    label: "a non-JSON body",
    pattern: /non-JSON body/u,
    serve: () => stubServer(() => ({ contentType: "text/html", body: "<html>gateway</html>" }))
  },
  {
    label: "a wrong-width vector",
    pattern: /4-dimensional/u,
    serve: () => stubServer(({ inputs }) => ({
      body: JSON.stringify({ object: "list", data: inputs.map((text, index) => ({ object: "embedding", index, embedding: [1, 2, 3, 4] })) })
    }))
  },
  {
    label: "a short data array",
    // The batch is the query plus the two candidate bodies, so a one-row answer
    // is short by two.
    pattern: /1 vector\(s\), expected 3/u,
    serve: () => stubServer(() => ({
      body: JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: [1, 0, 0] }] })
    }))
  },
  {
    label: "the question itself refused",
    pattern: /HTTP 400/u,
    // Refused in both forms, so the cleaned-variant retry cannot rescue it: the
    // question itself is poison, which is a dead route rather than a partial one.
    serve: () => stubServer(({ inputs }) => (inputs.some((text) => text.trim() === "target token")
      ? { status: 400, body: JSON.stringify({ error: { message: "invalid_type expected number received nan" } }) }
      : { body: goodBody(inputs) }))
  }
];

test("[degradation] every backend failure mode degrades to lexical plus one notice, never a throw", async () => {
  const lexical = searchSession(session(), "target token", cfgOf("http://unused", "/tmp"));
  for (const failure of FAILURES) {
    const server = await failure.serve();
    const root = await scratch();
    try {
      const cfg = cfgOf(server.baseUrl, root);
      let hybrid;
      await assert.doesNotReject(async () => { hybrid = await searchSessionHybrid(session(), "target token", { ...cfg, rank: "hybrid" }); }, failure.label + " must not throw");
      assert.deepEqual(hybrid.hits, lexical.hits, failure.label + ": the lexical hits survive unchanged");
      assert.equal(hybrid.rank, "density", failure.label + ": the result says which order it used");
      assert.equal(hybrid.mode, undefined, failure.label + ": no vector mode is claimed");
      assert.match(hybrid.notice, failure.pattern, failure.label + ": the notice names the cause: " + hybrid.notice);
      assert.match(hybrid.notice, /fell back to lexical/u, failure.label + ": and says what it did instead");
      assert.equal(hybrid.text, lexical.text + "\n\n[" + hybrid.notice + "]", failure.label + ": one notice line, appended, nothing else changed");
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("[degradation] an unreachable endpoint degrades with the transport reason", async () => {
  const root = await scratch();
  try {
    const lexical = searchSession(session(), "target token", cfgOf("http://unused", root));
    const hybrid = await searchSessionHybrid(session(), "target token", { ...cfgOf(await deadUrl(), root), rank: "vector" });
    assert.deepEqual(hybrid.hits, lexical.hits, "a dead port is still a search");
    assert.match(hybrid.notice, /unreachable/u, hybrid.notice);
    assert.match(hybrid.notice, /ECONNREFUSED|ECONNRESET/u, "the notice carries the socket reason, not a generic failure: " + hybrid.notice);
    assert.match(hybrid.notice, /fell back to lexical/u, hybrid.notice);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[degradation] a caller abort mid-request is honoured and not retried", async () => {
  const root = await scratch();
  const server = await stubServer(({ inputs }) => ({ body: goodBody(inputs), delayMs: 400 }));
  try {
    const controller = new AbortController();
    const pending = embedTexts(cfgOf(server.baseUrl, root), ["alpha"], controller.signal);
    pending.catch(() => {});
    assert.equal(await waitFor(() => server.state.requests === 1), true, "the request reached the endpoint before the abort");
    controller.abort(new Error("caller gave up"));
    await assert.rejects(
      pending,
      (error) => error.name === "VectorBackendError" && /aborted/u.test(error.message) && /caller gave up/u.test(error.message),
      "an aborted request surfaces as an abort, with the caller's reason"
    );
    assert.equal(server.state.requests, 1, "the abort happened inside the first attempt");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(server.state.requests, 1, "and no retry was sent after the abort");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[degradation] a pre-aborted signal sends nothing at all", async () => {
  const root = await scratch();
  const server = await stubServer(({ inputs }) => ({ body: goodBody(inputs) }));
  try {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await assert.rejects(embedTexts(cfgOf(server.baseUrl, root), ["alpha"], controller.signal), /aborted/u);
    assert.equal(server.state.requests, 0, "an already-aborted signal must not open a connection");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[degradation] an aborted search returns the lexical result with a notice instead of throwing", async () => {
  const root = await scratch();
  const server = await stubServer(({ inputs }) => ({ body: goodBody(inputs), delayMs: 400 }));
  try {
    const cfg = cfgOf(server.baseUrl, root);
    const lexical = searchSession(session(), "target token", cfg);
    const controller = new AbortController();
    const pending = searchSessionHybrid(session(), "target token", { ...cfg, rank: "hybrid" }, controller.signal);
    pending.catch(() => {});
    assert.equal(await waitFor(() => server.state.requests === 1), true, "the request reached the endpoint before the abort");
    controller.abort(new Error("turn cancelled"));
    const hybrid = await pending;
    assert.deepEqual(hybrid.hits, lexical.hits, "the caller still gets an answer");
    assert.equal(hybrid.rank, "density", hybrid.rank);
    assert.match(hybrid.notice, /aborted/u, hybrid.notice);
    assert.match(hybrid.notice, /fell back to lexical/u, hybrid.notice);
    assert.equal(server.state.requests, 1, "one attempt, abandoned; an aborted call is not retried");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

// ── a third-party plugin must not break the semantic route ───────────────────

test("[degradation] a surface the harness fold refuses does not throw the semantic route", async () => {
  // Measured on a real log: dsh-rewind wrote a replacement event with
  // sourceEventSeqs [[2684,2686],2690,2693] — nested, not dense integers — and
  // the harness fold throws on it. The lexical route never reads the surface, so
  // it answered while the semantic route threw: one plugin breaking a session it
  // never meant to touch. An unknown surface must widen the window (every event
  // counts as unread), never throw and never silently narrow it.
  const events = [
    { type: "session", id: "s" },
    { type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: "the target token lives here" }] } }
  ];
  const session = {
    id: "broken-surface",
    get events() { return events; },
    get surface() { throw new Error('session event "user/message" sourceEventSeqs must densely contain non-negative safe integers'); },
    eventAt: (seq) => events.find((event) => event.seq === seq),
    deriveEventMessage: (event) => event?.data?.content === undefined ? null : { role: "user", content: event.data.content }
  };
  const out = await searchSessionHybrid(session, "target token", { maxSearchHits: 10, maxRecallTokens: 5000, rank: "hybrid", vectorEnabled: false });
  assert.equal(out.hits.length > 0, true, "a broken surface must not cost the lexical answer");
  assert.equal(out.notice, undefined, "the layer is off, so there is nothing to degrade from");
});
