/**
 * Vector cache matrix: the on-disk side index.
 *
 * The cache is an optimisation, never a source of truth, so every test here
 * pins one of two properties: a warm entry is served byte for byte, and every
 * failure shape (short file, unusable directory, a missing root, a foreign
 * model) is a MISS that costs a re-embed and never a failed search.
 *
 * Each case gets its own temp root and removes it in `finally`; nothing here
 * touches the repository's own .lcm-vectors directory or the network beyond a
 * loopback stub.
 *
 * Run with: node --test test/vector-cache-matrix.test.js
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  pruneForeignVectorCaches,
  rankByVector,
  resolveVectorConfig,
  vectorCache,
  vectorCacheStats
} from "../src/vectors.js";

const DIM = 4;

/** Read one JSON request body. */
function readJson(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => resolve(JSON.parse(raw)));
  });
}

/** A loopback embeddings stub whose vectors are the text's character codes. */
async function tableServer(table) {
  const state = { requests: 0, inputs: [] };
  const server = createServer(async (request, response) => {
    state.requests += 1;
    const body = await readJson(request);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    state.inputs.push(...inputs);
    const data = inputs.map((text, index) => ({
      object: "embedding",
      index,
      embedding: table[text] ?? Array.from({ length: DIM }, (_, slot) => (text.charCodeAt(slot % text.length) % 13) + 1)
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

/** Vector settings for one temp root and model. */
function cfgOf(root, overrides = {}) {
  return {
    vectorEnabled: true,
    vectorModel: "test-embedding",
    vectorDim: DIM,
    vectorCacheDir: root,
    ...overrides
  };
}

/** A fresh temp root, removed by the caller. */
function scratch() {
  return mkdtemp(join(tmpdir(), "lcm-vec-cache-"));
}

/** A Float32Array literal. */
function f32(values) {
  return Float32Array.from(values);
}

test("[cache] a miss is null and a hit returns the same Float32s the writer stored", async () => {
  const root = await scratch();
  try {
    const cache = vectorCache(cfgOf(root));
    assert.equal(await cache.get("never written"), null, "an absent file is a miss, not an empty vector");
    const vector = f32([0.5, -1.25, 3, 0]);
    await cache.set("alpha", vector);
    const hit = await cache.get("alpha");
    assert.ok(hit instanceof Float32Array, "a hit is a Float32Array");
    assert.deepEqual([...hit], [...vector], "the stored floats survive the round trip exactly");
    assert.equal(basename(cache.path("alpha")).length, 64 + ".f32".length, "the key is the sha256 digest plus the suffix");
    assert.equal((await stat(cache.path("alpha"))).size, DIM * 4, "the payload is dim float32s with no header");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[cache] a file of the wrong byte length is a miss, not a truncated vector", async () => {
  const root = await scratch();
  const server = await tableServer({});
  try {
    const cfg = cfgOf(root, { vectorBaseUrl: server.baseUrl });
    const cache = vectorCache(cfg);
    await mkdir(cache.dir, { recursive: true });
    await writeFile(cache.path("alpha"), Buffer.alloc(DIM * 4 - 1, 7));
    assert.equal(await cache.get("alpha"), null, "a short file must not be widened into a vector");
    await writeFile(cache.path("alpha"), Buffer.alloc(DIM * 4 + 4, 7));
    assert.equal(await cache.get("alpha"), null, "a long file must not be sliced, either");

    // A corrupt entry costs one re-embed; the search still ranks and the entry
    // is rewritten at the exact width.
    const ranked = await rankByVector(cfg, [{ seq: 1, text: "alpha" }], "alpha");
    assert.equal(ranked.length, 1, "the corrupt cache entry did not break ranking");
    assert.ok(server.state.inputs.includes("alpha"), "the text was re-embedded after the corrupt read");
    assert.equal((await stat(cache.path("alpha"))).size, DIM * 4, "the rewritten entry has the exact width");
    const rewritten = await cache.get("alpha");
    assert.ok(rewritten instanceof Float32Array, "the rewritten entry is readable again");
    assert.equal(rewritten.length, DIM, "at the configured width");
    assert.deepEqual([...rewritten], [...(await cache.get("alpha"))], "and two reads agree on it");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[cache] an unusable directory degrades to a miss and never fails the search", async () => {
  const root = await scratch();
  const server = await tableServer({});
  try {
    const cfg = cfgOf(root, { vectorBaseUrl: server.baseUrl });
    const cache = vectorCache(cfg);
    // The model directory path is occupied by a regular file: every read is
    // ENOTDIR and every mkdir is EEXIST, which is what an unreadable or
    // read-only cache root looks like to this layer.
    await writeFile(cache.dir, "occupied-by-a-file");
    assert.equal(await cache.get("alpha"), null, "an unreadable directory is a miss");
    await assert.rejects(cache.set("alpha", f32([1, 2, 3, 4])), /EEXIST|ENOTDIR/u, "a write reports its failure to the caller");

    const ranked = await rankByVector(cfg, [{ seq: 1, text: "alpha" }, { seq: 2, text: "beta" }], "alpha");
    assert.equal(ranked.length, 2, "an unusable cache must not cost the ranking");
    assert.equal(server.state.requests, 1, "the miss was paid for with one request, not a retry storm");
    assert.equal(await cache.get("alpha"), null, "and nothing was written");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[cache] concurrent writers of one text both succeed and leave one intact file", async () => {
  const root = await scratch();
  try {
    const first = vectorCache(cfgOf(root));
    const second = vectorCache(cfgOf(root));
    const values = [f32([1, 0, 0, 0]), f32([0, 1, 0, 0]), f32([0, 0, 1, 0])];
    await Promise.all([
      first.set("same text", values[0]),
      second.set("same text", values[1]),
      first.set("same text", values[2])
    ]);
    const entries = await readdir(first.dir);
    assert.deepEqual(entries.filter((name) => name.endsWith(".f32")).length, 1, "one key, one file: " + entries.join(","));
    assert.deepEqual(entries.filter((name) => name.endsWith(".tmp")), [], "no temporary file survived the race: " + entries.join(","));
    assert.equal((await stat(first.path("same text"))).size, DIM * 4, "the surviving file is whole");
    const stored = [...(await first.get("same text"))];
    assert.ok(
      values.some((candidate) => JSON.stringify([...candidate]) === JSON.stringify(stored)),
      "the winner is one of the writers, never a blend: " + JSON.stringify(stored)
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[cache] each model owns its directory, so one model never reads another's vectors", async () => {
  const root = await scratch();
  try {
    const modelA = vectorCache(cfgOf(root, { vectorModel: "model-a" }));
    const modelB = vectorCache(cfgOf(root, { vectorModel: "model-b" }));
    assert.notEqual(modelA.dir, modelB.dir, "two models must not share a directory");
    assert.equal(basename(modelA.dir).endsWith("-" + DIM), true, modelA.dir);
    assert.notEqual(modelA.key("shared text"), modelB.key("shared text"), "the key covers the model, not just the text");

    await modelA.set("shared text", f32([9, 8, 7, 6]));
    assert.equal(await modelB.get("shared text"), null, "model B must not see model A's vector");
    assert.deepEqual([...(await modelA.get("shared text"))], [9, 8, 7, 6], "model A still reads its own entry");
    assert.deepEqual(await readdir(modelB.dir).catch(() => []), [], "model B wrote nothing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[cache] pruneForeignVectorCaches drops foreign models of a populated root and keeps the live one", async () => {
  const root = await scratch();
  try {
    const cfg = cfgOf(root);
    const cache = vectorCache(cfg);
    await cache.set("live", f32([1, 1, 1, 1]));
    await mkdir(join(root, "0123456789ab-" + DIM), { recursive: true });
    await writeFile(join(root, "0123456789ab-" + DIM, "a.f32"), Buffer.alloc(DIM * 4, 1));
    await mkdir(join(root, "ba9876543210-" + DIM, "nested"), { recursive: true });
    await writeFile(join(root, "ba9876543210-" + DIM, "nested", "b.f32"), Buffer.alloc(DIM * 2, 2));
    await writeFile(join(root, "README.txt"), "not a model directory");

    const pruned = await pruneForeignVectorCaches(cfg);
    assert.equal(pruned.removed, 2, "both foreign model directories were removed");
    assert.equal(pruned.bytes, DIM * 4 + DIM * 2, "the reported bytes are the files those directories held");
    const remaining = (await readdir(root)).sort();
    assert.deepEqual(remaining, [basename(cache.dir), "README.txt"].sort(), "the live model and the stray file stay: " + remaining.join(","));
    assert.deepEqual([...(await cache.get("live"))], [1, 1, 1, 1], "pruning did not touch the live cache");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[cache] pruneForeignVectorCaches on a missing root removes nothing and creates nothing", async () => {
  const parent = await scratch();
  const root = join(parent, "absent");
  try {
    const pruned = await pruneForeignVectorCaches(cfgOf(root));
    assert.deepEqual(pruned, { removed: 0, bytes: 0 }, "a missing root is zero work, not an error");
    await assert.rejects(stat(root), /ENOENT/u, "and it must not invent the directory");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("[cache] vectorCacheStats on an empty dir is zero files and zero bytes, with the directory named", async () => {
  const root = await scratch();
  try {
    const cfg = cfgOf(root);
    const empty = await vectorCacheStats(cfg);
    assert.equal(empty.files, 0, "an empty cache has no .f32 files");
    assert.equal(empty.bytes, 0);
    assert.equal(empty.model, "test-embedding");
    assert.equal(empty.dim, DIM);
    assert.equal(empty.dir, vectorCache(cfg).dir, "the reported directory is where a write would land, not the shared root");
    assert.ok(empty.dir.startsWith(root), empty.dir);

    const cache = vectorCache(cfg);
    await cache.set("a", f32([1, 2, 3, 4]));
    await cache.set("b", f32([4, 3, 2, 1]));
    await writeFile(join(cache.dir, "notes.txt"), "not a vector");
    const filled = await vectorCacheStats(cfg);
    assert.equal(filled.files, 2, "only .f32 payloads are counted");
    assert.equal(filled.bytes, 2 * DIM * 4, "the byte total is the payloads, not the stray file");

    const missing = await vectorCacheStats(cfgOf(join(root, "no-such-model-root")));
    assert.equal(missing.files, 0, "a missing model directory is zeros too");
    assert.equal(missing.bytes, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
