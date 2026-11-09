/**
 * Vector search-route matrix: when the semantic route runs, what it reads, and
 * what the rendered header claims.
 *
 * Three properties matter and each is a named test here:
 *
 *   1. with the layer off, the hybrid entry point IS the lexical one — byte for
 *      byte, including on a rank that asked for vectors;
 *   2. the two vector ranks reorder the answer (that is the whole point of the
 *      layer), and they reorder it differently from each other;
 *   3. the candidate window holds only content the model cannot already read —
 *      compacted message events, never the visible tail and never log plumbing —
 *      and it is priced in tokens, with the header stating the window it used.
 *
 * Run with: node --test test/vector-search-matrix.test.js
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { estimateEntryTokens } from "../src/compiler.js";
import { collectVectorItems, searchSession, searchSessionHybrid } from "../src/search.js";

const DIM = 3;

/** Read one JSON request body. */
function readJson(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => resolve(JSON.parse(raw)));
  });
}

/** A loopback embeddings stub backed by an explicit text → vector table. */
async function tableServer(table) {
  const state = { requests: 0, inputs: [], batches: [] };
  const server = createServer(async (request, response) => {
    state.requests += 1;
    const body = await readJson(request);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    state.inputs.push(...inputs);
    state.batches.push(inputs.length);
    if (inputs.some((text) => table[text] === undefined)) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "unknown text " + JSON.stringify(inputs.find((text) => table[text] === undefined)) } }));
      return;
    }
    const data = inputs.map((text, index) => ({ object: "embedding", index, embedding: table[text] }));
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

/** One message event whose body is exactly `text`. */
function message(seq, text) {
  return { seq, type: "user/message", data: { content: [{ type: "text", text }] } };
}

/**
 * A session shaped the way `sessionEvents` / `renderEventBody` read it: a header
 * record without a seq, message events, and the surface nodes still visible.
 */
function shaped(events, nodes) {
  const bySeq = new Map(events.filter((event) => Number.isSafeInteger(event.seq)).map((event) => [event.seq, event]));
  return {
    id: "s",
    events,
    surface: { nodes, replaceGeneration: 1 },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => (event.data?.content === undefined ? null : { role: "user", content: event.data.content })
  };
}

/** Vector settings for one stub, cache root and rank. */
function cfgOf(server, root, overrides = {}) {
  return {
    maxSearchHits: 50,
    maxRecallTokens: 100000,
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
  return mkdtemp(join(tmpdir(), "lcm-vec-route-"));
}

/** The fixture the rank comparisons use: four equal-length bodies, one visible. */
function rankSession() {
  return shaped(
    [
      { type: "session" },
      message(0, "deploy alpha beta"),
      message(1, "deploy delta echo"),
      message(2, "rollout strategy plan"),
      message(3, "deploy gamma zeta")
    ],
    []
  );
}

/** The four bodies plus the query, as the endpoint must answer them. */
const RANK_TABLE = {
  deploy: [1, 0, 0],
  "deploy alpha beta": [1, 0, 0],
  "deploy delta echo": [0.6, 0.8, 0],
  "rollout strategy plan": [0.95, 0.05, 0],
  "deploy gamma zeta": [0, 1, 0]
};

test("[route] a disabled layer is byte-identical to the lexical result", async () => {
  const lexical = searchSession(rankSession(), "deploy", { maxSearchHits: 50, maxRecallTokens: 100000, rank: "density" });
  for (const rank of ["vector", "hybrid", "density"]) {
    const hybrid = await searchSessionHybrid(rankSession(), "deploy", { maxSearchHits: 50, maxRecallTokens: 100000, rank });
    assert.equal(Buffer.compare(Buffer.from(hybrid.text), Buffer.from(lexical.text)), 0, "rank " + rank + ": identical bytes");
    assert.deepEqual(hybrid, lexical, "rank " + rank + ": no added field, no reorder");
    assert.equal(hybrid.mode, undefined, "rank " + rank + ": no vector mode is claimed");
    assert.equal(hybrid.notice, undefined, "rank " + rank + ": no notice is invented");
  }
});

test("[route] vector, hybrid and lexical produce three different orders", async () => {
  const root = await scratch();
  const server = await tableServer(RANK_TABLE);
  try {
    const base = cfgOf(server, root, { vectorTopK: 2 });
    const lexical = searchSession(rankSession(), "deploy", base);
    assert.deepEqual(lexical.hits.map((hit) => hit.seq), [3, 1, 0], "the lexical route orders by density then recency");

    const vector = await searchSessionHybrid(rankSession(), "deploy", { ...base, rank: "vector" });
    assert.deepEqual(vector.hits.map((hit) => hit.seq), [0, 2], "the vector route orders by cosine, and seq 2 never matched the pattern");
    assert.equal(vector.mode, "vector");
    assert.equal(vector.totalMatches, vector.hits.length, "there is no matching population on this route, and the count says so");
    assert.match(vector.text.split("\n")[0], /by cosine similarity/u, "the header names the measure");
    assert.match(vector.text, /cosine 1\.000/u, "the hit header carries the cosine it used");
    assert.equal(vector.hits[1].seq, 2, "a vector-only hit is rendered from the event body");
    assert.match(vector.hits[1].text, /rollout strategy plan/u, "the vector-only hit shows the body head");

    const hybrid = await searchSessionHybrid(rankSession(), "deploy", { ...base, rank: "hybrid" });
    assert.deepEqual(hybrid.hits.map((hit) => hit.seq), [0, 3, 2, 1], "RRF fuses the two routes: seq 0 is in both, seq 3 and 2 follow on their own ranks");
    assert.equal(hybrid.mode, "hybrid");
    assert.equal(hybrid.totalMatches, 3, "hybrid keeps the lexical meaning of totalMatches");
    assert.notDeepEqual(hybrid.hits.map((hit) => hit.seq), lexical.hits.map((hit) => hit.seq), "hybrid is not a lexical no-op");
    assert.notDeepEqual(hybrid.hits.map((hit) => hit.seq), vector.hits.map((hit) => hit.seq), "hybrid is not a vector no-op");
    assert.ok(hybrid.hits.some((hit) => !lexical.hits.some((other) => other.seq === hit.seq)), "hybrid surfaces a vector-only hit the lexical route could not reach");
    assert.ok(hybrid.hits.some((hit) => !vector.hits.some((other) => other.seq === hit.seq)), "and keeps a lexical-only hit the vector top-K dropped");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[route] the candidate window holds compacted content only — no visible events, no plumbing", async () => {
  const root = await scratch();
  const server = await tableServer({
    compacted: [1, 0, 0],
    "compacted answer one": [1, 0, 0],
    "compacted answer two": [0, 1, 0]
  });
  try {
    const session = shaped(
      [
        { type: "session" },
        message(0, "compacted answer one"),
        message(1, "compacted answer two"),
        message(2, "visible tail the model already reads"),
        { seq: 3, type: "tool/call", data: { name: "search", arguments: "{\"q\":\"compacted\"}" } },
        { seq: 4, type: "step/start", data: { step: "plumbing record" } }
      ],
      [2]
    );
    const window = collectVectorItems(session, { events: 500, tokens: 100000 });
    assert.deepEqual(window.items.map((item) => item.seq), [0, 1], "only the two compacted message events are candidates");
    assert.equal(window.hidden, 2, "the hidden count counts message content, not plumbing");

    const hybrid = await searchSessionHybrid(session, "compacted", cfgOf(server, root, { rank: "hybrid" }));
    assert.deepEqual(
      server.state.inputs.slice().sort(),
      ["compacted", "compacted answer one", "compacted answer two"].sort(),
      "exactly the query plus the compacted bodies reached the endpoint: " + JSON.stringify(server.state.inputs)
    );
    assert.equal(server.state.inputs.some((text) => text.includes("visible tail")), false, "the visible tail is never embedded");
    assert.equal(server.state.inputs.some((text) => text.includes("tool/call")), false, "log plumbing is never embedded");
    assert.equal(server.state.inputs.some((text) => text.includes("step/start")), false, "step markers are never embedded");
    assert.match(hybrid.text.split("\n")[0], /2 newest compacted event\(s\) of 2/u, "the header states the window it used");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[route] the candidate budget is priced in tokens, and the header reports the price it paid", async () => {
  const root = await scratch();
  const BODY = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
  const table = { query: [1, 0, 0] };
  for (let index = 0; index < 5; index += 1) table[BODY] = [1, index + 1, 0];
  const server = await tableServer(table);
  try {
    const events = [{ type: "session" }];
    for (let index = 0; index < 5; index += 1) events.push(message(index, BODY));
    const session = shaped(events, []);

    const cost = estimateEntryTokens(BODY);
    const budget = 2 * cost + 1;
    const window = collectVectorItems(session, { events: 500, tokens: budget });
    assert.equal(window.items.length, 2, "exactly two bodies fit the budget of " + budget);
    assert.deepEqual(window.items.map((item) => item.seq), [3, 4], "and they are the newest two");
    assert.equal(window.tokens, 2 * cost);
    assert.ok(window.tokens <= budget, "the priced window never exceeds the budget");
    assert.ok(window.tokens + cost > budget, "a third event would exceed it, so the bound is what stopped the window");

    const hybrid = await searchSessionHybrid(session, "query", cfgOf(server, root, { vectorCandidateTokens: budget, rank: "hybrid" }));
    const header = hybrid.text.split("\n")[0];
    assert.match(header, new RegExp("\\(" + window.tokens + " tokens, seq >= 3\\)", "u"), "the header repeats the price that was actually spent: " + header);
    assert.match(header, /2 newest compacted event\(s\) of 5/u, header);
    // Both candidates carry the same bytes, and the request dedupes by text, so
    // the batch is the query plus that one body rather than query plus two.
    assert.equal(server.state.batches[0], 2, "the query plus one unique body, embedded once: " + JSON.stringify(server.state.batches));
    assert.equal(server.state.inputs.filter((text) => text === BODY).length, 1, "identical texts are embedded once, not once per event");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[route] the hybrid header reports the compacted count it measured, not the whole log", async () => {
  const root = await scratch();
  const table = { note: [1, 0, 0] };
  for (let index = 0; index < 4; index += 1) table["compacted note " + index] = [1, index + 1, 0];
  const server = await tableServer(table);
  try {
    const events = [
      { type: "session" },
      message(0, "compacted note 0"),
      message(1, "compacted note 1"),
      message(2, "compacted note 2"),
      message(3, "compacted note 3"),
      message(4, "visible tail"),
      { seq: 5, type: "tool/call", data: { name: "x", arguments: "{}" } }
    ];
    const session = shaped(events, [4]);
    const hybrid = await searchSessionHybrid(session, "note", cfgOf(server, root, { vectorCandidateLimit: 2, rank: "hybrid" }));
    const header = hybrid.text.split("\n")[0];
    assert.match(header, /2 newest compacted event\(s\) of 4/u, "the denominator is the measured compacted population: " + header);
    assert.doesNotMatch(header, /of 6/u, "the visible tail and the plumbing are not part of that population");
    assert.match(header, /RRF k=60/u, header);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
