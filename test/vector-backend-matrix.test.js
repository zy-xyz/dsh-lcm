/**
 * Vector backend matrix: the HTTP contract and the authorization sources.
 *
 * The layer talks to one OpenAI-compatible `/embeddings` route and must treat
 * every distinct failure class differently: a 5xx is worth one retry, a 429 is
 * not, a payload verdict belongs to the bisection path, and a malformed body or
 * a wrong-width vector is a dead route that the caller degrades for. Each of
 * those is one named test here against a loopback stub.
 *
 * Authorization is the second half: the configuration carries the NAME of a
 * variable, never a key, and there are exactly two sources.
 *
 * Run with: node --test test/vector-backend-matrix.test.js
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { searchSession, searchSessionHybrid } from "../src/search.js";
import {
  embedTexts,
  embedTextsTolerant,
  rankByVector,
  resolveVectorAuth
} from "../src/vectors.js";

const DIM = 3;
const KEY_NAME = "LCM_MATRIX_EMBED_KEY";
const SECRET = "sk-test-value";

/** Read one JSON request body. */
function readJson(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => resolve(JSON.parse(raw)));
  });
}

/**
 * One loopback endpoint whose answer is decided by `respond`.
 * @param respond - `({ inputs, requestIndex }) => { status?, body?, contentType?, delayMs? }`
 */
async function stubServer(respond) {
  const state = { requests: 0, batches: [], inputs: [], authorizations: [] };
  const server = createServer(async (request, response) => {
    state.requests += 1;
    state.authorizations.push(request.headers.authorization ?? null);
    const body = await readJson(request).catch(() => ({}));
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    state.batches.push(inputs.length);
    state.inputs.push(...inputs);
    const out = respond({ inputs, requestIndex: state.requests, body, state });
    if (out.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, out.delayMs));
    if (!response.destroyed) {
      response.writeHead(out.status ?? 200, { "content-type": out.contentType ?? "application/json" });
      response.end(out.body ?? "");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    state,
    baseUrl: "http://127.0.0.1:" + server.address().port + "/v1",
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** A server that vectorises `table[text]` and refuses unknown texts with 400. */
function tableServer(table) {
  return stubServer(({ inputs }) => {
    if (inputs.some((text) => table[text] === undefined)) {
      return { status: 400, body: JSON.stringify({ error: { message: "invalid_type expected number received nan" } }) };
    }
    return {
      body: JSON.stringify({
        object: "list",
        data: inputs.map((text, index) => ({ object: "embedding", index, embedding: table[text] }))
      })
    };
  });
}

/** A server that fails its first `failures` requests with `status`. */
function flakyServer(table, failures, status = 500) {
  return stubServer(({ inputs, requestIndex }) => {
    if (requestIndex <= failures) {
      return { status, body: JSON.stringify({ error: { message: "upstream hiccup" } }) };
    }
    return {
      body: JSON.stringify({ object: "list", data: inputs.map((text, index) => ({ object: "embedding", index, embedding: table[text] })) })
    };
  });
}

/** Vector settings pointing at one stub and one temp cache root. */
function cfgOf(server, root, overrides = {}) {
  return {
    vectorEnabled: true,
    vectorBaseUrl: server.baseUrl,
    vectorModel: "test-embedding",
    vectorDim: DIM,
    vectorCacheDir: root,
    ...overrides
  };
}

/** A fresh temp root. */
function scratch() {
  return mkdtemp(join(tmpdir(), "lcm-vec-backend-"));
}

/** Run `fn` with a temporary process environment, restoring it afterwards. */
async function withEnv(vars, fn) {
  const saved = new Map();
  for (const [name, value] of Object.entries(vars)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("[backend] a 5xx on the first attempt is retried and then succeeds", async () => {
  const root = await scratch();
  const server = await flakyServer({ a: [1, 0, 0], b: [0, 1, 0] }, 1, 500);
  try {
    const vectors = await embedTexts(cfgOf(server, root), ["a", "b"]);
    assert.equal(vectors.length, 2, "the retry produced both vectors");
    assert.deepEqual([...vectors[1]], [0, 1, 0], "the retried payload is the same payload");
    assert.equal(server.state.requests, 2, "one failure plus one retry, which succeeded");
    assert.deepEqual(server.state.batches, [2, 2], "the retry resends the identical batch");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[backend] a persistently failing 5xx exhausts the retry budget and surfaces it", async () => {
  // The budget is an operator decision (three retries, so four attempts). What this
  // pins is that a persistent failure TERMINATES: a retry loop without an end would
  // turn a dead endpoint into a hang, and the caller's breaker would never see it.
  const root = await scratch();
  const server = await flakyServer({ a: [1, 0, 0] }, 99, 500);
  try {
    await assert.rejects(
      embedTexts(cfgOf(server, root), ["a"]),
      (error) => error.name === "VectorBackendError" && /HTTP 500/u.test(error.message) && error.status === 500,
      "a dead backend must surface as VectorBackendError carrying the status"
    );
    assert.equal(server.state.requests, 4, "one initial attempt plus three retries, then it stops");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[backend] HTTP 429 is a rate limit, not a hiccup: one attempt, no retry", async () => {
  const root = await scratch();
  const server = await flakyServer({ a: [1, 0, 0] }, 99, 429);
  try {
    await assert.rejects(
      embedTexts(cfgOf(server, root), ["a"]),
      (error) => error.name === "VectorBackendError" && /HTTP 429/u.test(error.message),
      "a 429 is reported with its status"
    );
    assert.equal(server.state.requests, 1, "a 4xx status is not retried; the caller degrades instead");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[backend] a non-JSON body fails with a named reason, never an empty vector", async () => {
  const root = await scratch();
  const server = await stubServer(() => ({ contentType: "text/html", body: "<html>gateway</html>" }));
  try {
    await assert.rejects(
      embedTexts(cfgOf(server, root), ["a"]),
      (error) => error.name === "VectorBackendError" && /non-JSON body/u.test(error.message),
      "the reason names the malformed body"
    );
    await assert.rejects(embedTextsTolerant(cfgOf(server, root), ["a"]), /non-JSON body/u, "the tolerant view treats it as a dead backend, not a poisoned text");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[backend] a vector of the wrong dimension fails instead of being truncated or padded", async () => {
  const root = await scratch();
  const server = await stubServer(({ inputs }) => ({
    body: JSON.stringify({
      object: "list",
      data: inputs.map((text, index) => ({ object: "embedding", index, embedding: [1, 2, 3, 4] }))
    })
  }));
  try {
    await assert.rejects(
      embedTexts(cfgOf(server, root), ["a"]),
      (error) => error.name === "VectorBackendError" &&
        /4-dimensional/u.test(error.message) &&
        new RegExp("vectorDim is " + DIM, "u").test(error.message),
      "the reason names both the returned width and the configured one"
    );
    await assert.rejects(rankByVector(cfgOf(server, root), [{ seq: 1, text: "a" }], "a"), /4-dimensional/u, "ranking cannot use a wrong-width vector either");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[backend] the wrong number of vectors fails instead of misaligning the inputs", async () => {
  const root = await scratch();
  const server = await stubServer(() => ({
    body: JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: [1, 0, 0] }] })
  }));
  try {
    await assert.rejects(
      embedTexts(cfgOf(server, root), ["a", "b"]),
      (error) => error.name === "VectorBackendError" && /1 vector\(s\), expected 2/u.test(error.message),
      "a short data array must not be zipped against the input list"
    );
    const tolerant = await embedTextsTolerant(cfgOf(server, root), ["a", "b"]).catch((error) => error);
    assert.equal(tolerant.name, "VectorBackendError", "a count mismatch is a backend failure, not a per-text skip");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[backend] an empty input list is a no-op: no request, empty result", async () => {
  const root = await scratch();
  const server = await tableServer({});
  try {
    const cfg = cfgOf(server, root);
    assert.deepEqual(await embedTexts(cfg, []), [], "no input, no vectors");
    assert.deepEqual(await embedTextsTolerant(cfg, []), { vectors: [], failures: [] }, "and no failures invented");
    const ranked = await rankByVector(cfg, [], "anything");
    assert.equal(ranked.length, 0, "no candidates, no ranking");
    assert.equal(ranked.skipped, 0);
    assert.deepEqual(ranked.failedSeqs, []);
    assert.equal(server.state.requests, 0, "an empty list must never reach the wire");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[backend] one refused text costs a logarithmic number of requests, not a linear scan", async () => {
  const root = await scratch();
  const table = {};
  for (let index = 0; index < 32; index += 1) {
    if (index !== 9) table["doc-" + index] = [index, 1, 0];
  }
  const server = await tableServer(table);
  const texts = Array.from({ length: 32 }, (_, index) => "doc-" + index);
  try {
    const result = await embedTextsTolerant(cfgOf(server, root), texts);
    assert.equal(result.vectors.filter((vector) => vector !== undefined).length, 31, "every other text still embedded");
    assert.equal(result.failures.length, 1, "the refused text is reported once");
    assert.equal(result.failures[0].index, 9, "the refusal is attributed to the exact slot");
    assert.equal(result.failures[0].text, "doc-9");
    assert.match(result.failures[0].reason, /HTTP 400/u, result.failures[0].reason);
    assert.ok(
      server.state.requests <= 16,
      "bisection must stay logarithmic: 32 texts cost " + server.state.requests + " requests, not 32"
    );
    assert.ok(server.state.requests >= 2, "the bisection really ran, so this is not vacuous: " + server.state.requests);
    assert.ok(server.state.batches.includes(32), "the first attempt is the whole batch");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[backend] a refused text is recovered by exactly one cleaned-variant retry", async () => {
  const root = await scratch();
  // "doc-1" itself is absent from the table, so the endpoint refuses those exact
  // bytes; the cleaned variant (one leading space) is the only accepted form.
  const table = { "doc-0": [0, 1, 0], " doc-1": [1, 2, 0] };
  const server = await tableServer(table);
  try {
    const result = await embedTextsTolerant(cfgOf(server, root), ["doc-0", "doc-1"]);
    assert.equal(result.failures.length, 0, "the cleaned variant cleared the refusal: " + JSON.stringify(result.failures));
    assert.equal(result.vectors.filter((vector) => vector !== undefined).length, 2, "both slots carry a vector");
    assert.deepEqual([...result.vectors[1]], [1, 2, 0], "the accepted variant's vector is the one stored");
    const variantSends = server.state.inputs.filter((text) => text === " doc-1").length;
    assert.equal(variantSends, 1, "exactly one cleaned-variant attempt, not a loop");
    assert.equal(
      server.state.inputs.filter((text) => text === "doc-1").length,
      2,
      "the original form was tried twice (once inside the batch, once isolated), and never again"
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[auth] no vectorApiKeyEnv means no Authorization header at all", async () => {
  const root = await scratch();
  const server = await tableServer({ a: [1, 0, 0] });
  try {
    const cfg = cfgOf(server, root);
    assert.deepEqual(await resolveVectorAuth(cfg), { header: {}, source: "none" }, "an unconfigured name resolves to no header");
    await embedTexts(cfg, ["a"]);
    assert.equal(server.state.authorizations.at(-1), null, "a keyless backend must receive no Authorization header");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[auth] the environment value wins over the credential store", async () => {
  const home = await scratch();
  const root = await scratch();
  const server = await tableServer({ a: [1, 0, 0] });
  try {
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, ".credentials.yaml"),
      ["refs:", "  " + KEY_NAME + ": sk-test-value-store", "records:", '  some/key: "a quoted blob"'].join("\n")
    );
    await withEnv({ DSH_HOME: home, HOME: home, [KEY_NAME]: SECRET }, async () => {
      const auth = await resolveVectorAuth(cfgOf(server, root, { vectorApiKeyEnv: KEY_NAME }));
      assert.equal(auth.source, "env", "the process environment is the first source");
      assert.equal(auth.header.authorization, "Bearer " + SECRET, "and the environment value is the one used");
      await embedTexts(cfgOf(server, root, { vectorApiKeyEnv: KEY_NAME }), ["a"]);
      assert.equal(server.state.authorizations.at(-1), "Bearer " + SECRET, "the winning value is what reaches the wire");
    });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("[auth] the credential store answers when the environment variable is unset", async () => {
  const home = await scratch();
  const root = await scratch();
  const server = await tableServer({ a: [1, 0, 0] });
  try {
    await writeFile(
      join(home, ".credentials.yaml"),
      ["records:", '  some/key: "a quoted blob"', "refs:", "  " + KEY_NAME + ": " + SECRET].join("\n")
    );
    await withEnv({ DSH_HOME: home, HOME: home, [KEY_NAME]: undefined }, async () => {
      const auth = await resolveVectorAuth(cfgOf(server, root, { vectorApiKeyEnv: KEY_NAME }));
      assert.equal(auth.source, "credential-store", "the store is the fallback source");
      assert.equal(auth.header.authorization, "Bearer " + SECRET, "the stored value is used verbatim, quotes stripped");
      await embedTexts(cfgOf(server, root, { vectorApiKeyEnv: KEY_NAME }), ["a"]);
      assert.equal(server.state.authorizations.at(-1), "Bearer " + SECRET, "the store value reaches the wire");
      assert.equal(JSON.stringify(auth).includes(SECRET), true, "the record names the source and carries the header");
    });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("[auth] a name with neither source sends no header, and the search still answers lexically with a notice", async () => {
  const home = await scratch();
  const root = await scratch();
  const server = await stubServer(() => ({ status: 401, body: JSON.stringify({ error: { message: "no key" } }) }));
  try {
    const events = [
      { type: "session" },
      { seq: 0, type: "user/message", data: { content: [{ type: "text", text: "compacted deploy target token" }] } },
      { seq: 1, type: "user/message", data: { content: [{ type: "text", text: "compacted unrelated note" }] } }
    ];
    const bySeq = new Map(events.filter((event) => Number.isSafeInteger(event.seq)).map((event) => [event.seq, event]));
    const session = {
      id: "s",
      events,
      surface: { nodes: [] },
      eventAt: (seq) => bySeq.get(seq),
      deriveEventMessage: (event) => (event.data?.content === undefined ? null : { role: "user", content: event.data.content })
    };
    const base = {
      maxSearchHits: 50,
      maxRecallTokens: 100000,
      vectorEnabled: true,
      vectorBaseUrl: server.baseUrl,
      vectorModel: "test-embedding",
      vectorDim: DIM,
      vectorCacheDir: root,
      vectorApiKeyEnv: KEY_NAME
    };
    await withEnv({ DSH_HOME: home, HOME: home, [KEY_NAME]: undefined }, async () => {
      const auth = await resolveVectorAuth(base);
      assert.deepEqual(auth, { header: {}, source: "none" }, "an unset variable plus an empty store is no key");
      const lexical = searchSession(session, "target token", base);
      const hybrid = await searchSessionHybrid(session, "target token", { ...base, rank: "hybrid" });
      assert.equal(server.state.authorizations.every((value) => value === null), true, "no header was sent, so this really is the 401 path");
      assert.deepEqual(hybrid.hits, lexical.hits, "the answer is the lexical one");
      assert.equal(hybrid.rank, "density", "and it says so");
      assert.match(hybrid.notice, /HTTP 401/u, hybrid.notice);
      assert.match(hybrid.notice, /fell back to lexical/u, hybrid.notice);
      assert.ok(hybrid.text.endsWith("[" + hybrid.notice + "]"), "the notice is appended to the rendered text");
    });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
