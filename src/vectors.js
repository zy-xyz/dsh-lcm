/**
 * Optional vector-recall layer for `dsh-lcm`.
 *
 * `./search.js` is lexical: a question whose wording does not overlap the
 * recorded text cannot hit it. A semantic route fixes that, and the shape here
 * is the smallest one that works:
 *
 *   - the session log stays the only store — vectors are a *side index*;
 *   - the index lives in memory for one call and on disk as a flat
 *     content-addressed cache (`sha256(model + "\n" + text)` → raw Float32s);
 *   - no database, no new dependency: built-in `fetch` and `node:crypto`;
 *   - the whole layer is inert unless `vectorEnabled: true`, and it is only
 *     consulted when `rank` is explicitly `vector` or `hybrid`.
 *
 * Failure is never fatal: callers catch `VectorBackendError` and fall back to
 * the lexical ranking with one notice line, so an unreachable embedding server
 * degrades a search, it does not break a session.
 *
 * @module dsh-lcm/vectors
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ── defaults ───────────────────────────────────────────────────────────────

/** The layer is opt-in. Off means zero extra work and zero network calls. */
export const DEFAULT_VECTOR_ENABLED = false;
/** OpenAI-compatible embeddings root; `/embeddings` is appended. */
export const DEFAULT_VECTOR_BASE_URL = "http://10.126.126.3:1234/v1";
/** Measured against a live endpoint: 4096 dimensions, unit-norm output. */
export const DEFAULT_VECTOR_MODEL = "text-embedding-qwen3-vl-embedding-8b";
/** Width of one embedding; a mismatch means the model changed, not that we guess. */
export const DEFAULT_VECTOR_DIM = 4096;
/** Candidates the vector route contributes to one ranking. */
export const DEFAULT_VECTOR_TOPK = 8;
/** Per-request ceiling, so a hung backend cannot hold a search open. */
export const DEFAULT_VECTOR_TIMEOUT_MS = 20000;
/** Relative cache directory, resolved against the process cwd by the caller. */
export const DEFAULT_VECTOR_CACHE_DIR = ".lcm-vectors";

/** Texts per POST. The endpoint measured 32 texts in 981 ms. */
export const MAX_EMBED_BATCH = 32;

/** Reciprocal-rank-fusion constant from the standard RRF formulation. */
export const RRF_K = 60;

/**
 * Characters of one event body used as embedding input.
 *
 * An event can be a 100 KB tool dump; embedding it whole is either rejected by
 * the server or costs more than the retrieval is worth. The slice is also what
 * the cache keys on, so a cache hit is always a hit on the exact bytes that
 * were embedded.
 */
export const VECTOR_TEXT_LIMIT = 4000;

/** Cache file suffix; the payload is little-endian Float32 with no header. */
const CACHE_EXT = ".f32";

/** The embedding backend failed in a way the caller should degrade for. */
export class VectorBackendError extends Error {
  /**
   * @param message - what failed, short enough to surface in a notice line.
   * @param options - standard `Error` options (`cause`).
   */
  constructor(message, options) {
    super(message, options);
    this.name = "VectorBackendError";
  }
}

// ── configuration ──────────────────────────────────────────────────────────

/**
 * Resolve the vector-layer view of one configuration.
 *
 * Reads only the `vector*` keys and validates their types with the same shape
 * of error the rest of the package throws (`src/config.js` owns unknown-key
 * rejection; this function tolerates the surrounding keys). Idempotent: the
 * resolved record is itself a valid input.
 *
 * @param config - plugin configuration, raw or already resolved.
 * @returns the frozen vector settings.
 */
export function resolveVectorConfig(config = {}) {
  // Idempotent by recognition, not by re-derivation: the resolved record keys
  // its switch as "enabled" (not "vectorEnabled"), so re-resolving it naively
  // would silently switch the layer off.
  if (isResolvedVectorConfig(config)) return config;
  const enabled = config.vectorEnabled ?? DEFAULT_VECTOR_ENABLED;
  if (typeof enabled !== "boolean") throw new Error("LcmVectorConfig: vectorEnabled must be a boolean");
  const baseUrl = config.vectorBaseUrl ?? DEFAULT_VECTOR_BASE_URL;
  assertNonEmptyString("LcmVectorConfig.vectorBaseUrl", baseUrl);
  const model = config.vectorModel ?? DEFAULT_VECTOR_MODEL;
  assertNonEmptyString("LcmVectorConfig.vectorModel", model);
  const dim = config.vectorDim ?? DEFAULT_VECTOR_DIM;
  assertPositiveInteger("LcmVectorConfig.vectorDim", dim);
  const topK = config.vectorTopK ?? DEFAULT_VECTOR_TOPK;
  assertPositiveInteger("LcmVectorConfig.vectorTopK", topK);
  const timeoutMs = config.vectorTimeoutMs ?? DEFAULT_VECTOR_TIMEOUT_MS;
  assertPositiveInteger("LcmVectorConfig.vectorTimeoutMs", timeoutMs);
  const cacheDir = config.vectorCacheDir ?? DEFAULT_VECTOR_CACHE_DIR;
  assertNonEmptyString("LcmVectorConfig.vectorCacheDir", cacheDir);
  return Object.freeze({
    enabled,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model,
    dim,
    topK,
    timeoutMs,
    cacheDir
  });
}

// ── embeddings over HTTP ───────────────────────────────────────────────────

/**
 * Embed texts in batches, preserving input order.
 *
 * @param cfg - vector settings (raw or resolved).
 * @param texts - input strings.
 * @param signal - optional caller abort signal.
 * @returns one Float32Array per input, in input order.
 * @throws VectorBackendError on a disabled layer, transport failure, HTTP
 *   error, malformed payload, or a dimension mismatch. Never returns zero
 *   vectors in place of a failure.
 */
export async function embedTexts(cfg, texts, signal) {
  const resolved = resolveVectorConfig(cfg);
  if (!resolved.enabled) throw new VectorBackendError("vector layer is disabled (vectorEnabled: false)");
  const list = Array.from(texts ?? [], (text) => String(text ?? ""));
  const vectors = [];
  for (let start = 0; start < list.length; start += MAX_EMBED_BATCH) {
    vectors.push(...await requestBatch(resolved, list.slice(start, start + MAX_EMBED_BATCH), signal));
  }
  return vectors;
}

/** POST one batch and decode its vectors, with a bounded wall clock. */
async function requestBatch(cfg, batch, signal) {
  const url = cfg.baseUrl + "/embeddings";
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, cfg.timeoutMs);
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal !== undefined && signal !== null) {
    if (signal.aborted) forwardAbort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
  }
  try {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ model: cfg.model, input: batch }),
        signal: controller.signal
      });
    } catch (error) {
      if (timedOut) throw new VectorBackendError(`embedding endpoint ${url} timed out after ${cfg.timeoutMs}ms`, { cause: error });
      if (signal?.aborted === true) throw new VectorBackendError(`embedding request aborted: ${describe(signal.reason)}`, { cause: error });
      throw new VectorBackendError(`embedding endpoint ${url} unreachable: ${networkReason(error)}`, { cause: error });
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
      throw new VectorBackendError(`embedding endpoint ${url} returned HTTP ${response.status}${detail.length > 0 ? ": " + detail : ""}`);
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if (timedOut) throw new VectorBackendError(`embedding endpoint ${url} timed out after ${cfg.timeoutMs}ms`, { cause: error });
      throw new VectorBackendError(`embedding endpoint ${url} returned a non-JSON body`, { cause: error });
    }
    return decodeEmbeddings(payload, cfg, url, batch.length);
  } finally {
    clearTimeout(timer);
    if (signal !== undefined && signal !== null) signal.removeEventListener("abort", forwardAbort);
  }
}

/** Validate and widen one `{ data: [{ embedding }] }` payload. */
function decodeEmbeddings(payload, cfg, url, expected) {
  const rows = payload?.data;
  if (!Array.isArray(rows) || rows.length !== expected) {
    throw new VectorBackendError(`embedding endpoint ${url} returned ${Array.isArray(rows) ? rows.length : "no"} vector(s), expected ${expected}`);
  }
  return rows.map((row, index) => {
    const embedding = row?.embedding;
    if (!Array.isArray(embedding)) throw new VectorBackendError(`embedding endpoint ${url} returned a malformed vector at index ${index}`);
    if (embedding.length !== cfg.dim) {
      throw new VectorBackendError(`embedding model ${cfg.model} returned ${embedding.length}-dimensional vector(s) but vectorDim is ${cfg.dim}`);
    }
    return Float32Array.from(embedding);
  });
}

// ── disk cache ─────────────────────────────────────────────────────────────

/**
 * Open the content-addressed vector cache.
 *
 * Key is `sha256(model + "\n" + text)`, value is a headerless little-endian
 * Float32 blob written to a temporary file and renamed into place, so a
 * concurrent reader never sees a half-written vector. Every failure to read is
 * a miss (the cache is an optimisation, never a source of truth); a failed
 * write is dropped by callers.
 *
 * @param cfg - vector settings (raw or resolved).
 * @returns `{ dir, model, key, path, get, set, getMany, setMany }`.
 */
export function vectorCache(cfg) {
  const resolved = resolveVectorConfig(cfg);
  const digest = (text) => createHash("sha256").update(resolved.model + "\n" + String(text ?? ""), "utf8").digest("hex");
  const fileOf = (text) => join(resolved.cacheDir, digest(text) + CACHE_EXT);

  /** Read one cached vector, or null on a miss, a short file, or bad bytes. */
  async function get(text) {
    let bytes;
    try {
      bytes = await readFile(fileOf(text));
    } catch {
      return null;
    }
    if (bytes.byteLength !== resolved.dim * 4) return null;
    const vector = new Float32Array(resolved.dim);
    for (let index = 0; index < resolved.dim; index += 1) vector[index] = bytes.readFloatLE(index * 4);
    return vector;
  }

  /** Atomically store one vector. */
  async function set(text, vector) {
    if (!(vector instanceof Float32Array) || vector.length !== resolved.dim) {
      throw new Error(`vector cache: expected a ${resolved.dim}-dimensional Float32Array`);
    }
    await mkdir(resolved.cacheDir, { recursive: true });
    const target = fileOf(text);
    const temp = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      const bytes = Buffer.alloc(vector.length * 4);
      for (let index = 0; index < vector.length; index += 1) bytes.writeFloatLE(vector[index], index * 4);
      await writeFile(temp, bytes);
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  /** Read many; missing entries are simply absent from the returned map. */
  async function getMany(texts) {
    const found = new Map();
    for (const text of new Set(Array.from(texts ?? [], (value) => String(value ?? "")))) {
      const vector = await get(text);
      if (vector !== null) found.set(text, vector);
    }
    return found;
  }

  /** Store many best-effort: a cache that cannot be written is still a fix. */
  async function setMany(entries) {
    for (const entry of entries ?? []) await set(entry.text, entry.vector);
  }

  return { dir: resolved.cacheDir, model: resolved.model, key: digest, path: fileOf, get, set, getMany, setMany };
}

// ── ranking ────────────────────────────────────────────────────────────────

/**
 * Rank items by cosine similarity to the query text.
 *
 * Cosine, explicitly: the endpoint returns unit vectors today, but a normalised
 * assumption is exactly the kind of thing that breaks silently when the model
 * or a proxy changes, so both norms are divided out.
 *
 * @param cfg - vector settings (raw or resolved).
 * @param items - `[{ seq, text }]` candidates (the whole session log).
 * @param queryText - the question, in natural language.
 * @param signal - optional caller abort signal.
 * @param limit - candidates to return; `0` keeps all. Defaults to `vectorTopK`.
 * @returns `[{ seq, score }]` by descending cosine, then descending seq.
 * @throws VectorBackendError when the backend fails (callers degrade).
 */
export async function rankByVector(cfg, items, queryText, signal, limit) {
  const resolved = resolveVectorConfig(cfg);
  if (!resolved.enabled) return [];
  const query = embedInputOf(queryText);
  if (query.length === 0) return [];
  const candidates = [];
  for (const item of items ?? []) {
    if (!Number.isSafeInteger(item?.seq)) continue;
    const text = embedInputOf(item.text);
    if (text.length === 0) continue;
    candidates.push({ seq: item.seq, text });
  }
  if (candidates.length === 0) return [];

  const cache = vectorCache(resolved);
  const vectors = await cache.getMany([query, ...candidates.map((candidate) => candidate.text)]);
  const needed = new Map();
  if (!vectors.has(query)) needed.set(query, true);
  for (const candidate of candidates) if (!vectors.has(candidate.text)) needed.set(candidate.text, true);
  if (needed.size > 0) {
    const texts = [...needed.keys()];
    const embedded = await embedTexts(resolved, texts, signal);
    texts.forEach((text, index) => vectors.set(text, embedded[index]));
    // A cache that cannot be written must not fail the search.
    await cache.setMany(texts.map((text) => ({ text, vector: vectors.get(text) }))).catch(() => {});
  }

  const queryVector = vectors.get(query);
  const queryNorm = vectorNorm(queryVector);
  if (queryNorm === 0) return [];
  const scored = candidates.map((candidate) => ({
    seq: candidate.seq,
    score: cosineSimilarity(queryVector, queryNorm, vectors.get(candidate.text))
  }));
  scored.sort((left, right) => right.score - left.score || right.seq - left.seq);
  const cap = limit ?? resolved.topK;
  return cap > 0 ? scored.slice(0, cap) : scored;
}

/**
 * Fuse the lexical and vector rankings with reciprocal rank fusion.
 *
 * `score(seq) = Σ 1 / (k + rank)` over the routes that returned it, which is
 * what LCM-X's `hybrid_rrf` does and what makes the two routes comparable at
 * all: a raw cosine and a match-density score share no scale, but their ranks
 * do. Ties break toward the later event, matching the lexical modes.
 *
 * @param cfg - vector settings (accepted for call-site symmetry; unused).
 * @param lexical - lexical candidates in their ranking order (`{ seq }` or seq).
 * @param vector - vector candidates in their ranking order (`{ seq }` or seq).
 * @param k - RRF constant.
 * @returns `[{ seq, score }]` in fused order.
 */
export function hybridRank(cfg, lexical, vector, k = RRF_K) {
  void cfg;
  const fused = new Map();
  const absorb = (entries) => {
    (entries ?? []).forEach((entry, index) => {
      const seq = typeof entry === "number" ? entry : entry?.seq;
      if (!Number.isSafeInteger(seq)) return;
      fused.set(seq, (fused.get(seq) ?? 0) + 1 / (k + index + 1));
    });
  };
  absorb(lexical);
  absorb(vector);
  return [...fused]
    .map(([seq, score]) => ({ seq, score }))
    .sort((left, right) => right.score - left.score || right.seq - left.seq);
}

// ── math and small helpers ─────────────────────────────────────────────────

/** The exact text one item is embedded as (see `VECTOR_TEXT_LIMIT`). */
function embedInputOf(text) {
  return String(text ?? "").slice(0, VECTOR_TEXT_LIMIT);
}

/** Euclidean length; 0 means the vector carries no direction. */
function vectorNorm(vector) {
  if (vector === undefined) return 0;
  let total = 0;
  for (let index = 0; index < vector.length; index += 1) total += vector[index] * vector[index];
  return Math.sqrt(total);
}

/** cos = (a·b) / (|a| |b|), with the query norm already computed. */
function cosineSimilarity(left, leftNorm, right) {
  if (right === undefined || leftNorm === 0) return 0;
  const rightNorm = vectorNorm(right);
  if (rightNorm === 0) return 0;
  const length = Math.min(left.length, right.length);
  let dot = 0;
  for (let index = 0; index < length; index += 1) dot += left[index] * right[index];
  return dot / (leftNorm * rightNorm);
}

/** Turn an `unknown` thrown value into a short notice-safe reason. */
function describe(value) {
  if (value instanceof Error) return value.message;
  return String(value ?? "unknown reason");
}

/** Prefer the socket-level reason over fetch's generic "fetch failed". */
function networkReason(error) {
  const code = error?.cause?.code ?? error?.code;
  if (typeof code === "string") return code;
  return describe(error?.cause ?? error);
}

/** True when one value is already a resolved vector settings record. */
function isResolvedVectorConfig(value) {
  return value !== null &&
    typeof value === "object" &&
    typeof value.enabled === "boolean" &&
    typeof value.baseUrl === "string" &&
    typeof value.model === "string" &&
    Number.isInteger(value.dim) &&
    Number.isInteger(value.topK) &&
    Number.isInteger(value.timeoutMs) &&
    typeof value.cacheDir === "string";
}

function assertNonEmptyString(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
}

function assertPositiveInteger(name, value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} (${String(value)}) must be a positive integer`);
  }
}
