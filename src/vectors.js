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

/**
 * Hard ceiling on events one search embeds, as a second bound.
 *
 * The primary budget is {@link DEFAULT_VECTOR_CANDIDATE_TOKENS}, because the
 * endpoint's cost tracks text length: 32 texts measured 27/33/60/119/230 ms per
 * text at 40/200/800/2000/4000 characters, i.e. `18 ms per text + 0.23 ms per
 * estimated token`. A count alone would underprice a log of huge tool dumps and
 * overprice a log of one-line markers, so the count stays only as a ceiling for
 * the second case: 500 tiny events still costs ~13 s.
 */
export const DEFAULT_VECTOR_CANDIDATE_LIMIT = 500;

/**
 * Token budget one search spends embedding the events it cannot otherwise read.
 *
 * Candidates come from OUTSIDE the session surface: events still on the surface
 * are already in the model's context verbatim, so embedding them is pure waste
 * and inflates the very first search. Measured on a real 24013-event session:
 * 4213 events were compacted and 19800 were still on the surface, so a
 * newest-first window over the whole log would have spent its budget entirely
 * on text the model could already see.
 *
 * 100000 estimated tokens admitted the real session's newest 203 compacted
 * events (99765 tokens, seq >= 21691, of 4213 compacted) and measured 26.7 s on
 * a cold cache, 132 ms warm. The residual limitation is real: the 4010 compacted
 * events older than that budget are still unreachable by similarity, and only a
 * lexical pattern finds them. `rank: "hybrid"` keeps those lexical hits in the
 * answer; `rank: "vector"` alone does not.
 */
export const DEFAULT_VECTOR_CANDIDATE_TOKENS = 100000;
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

/**
 * HTTP statuses that reject the request body, not the request.
 *
 * Only these can be caused by one poisoned string, so only these are bisected.
 * Anything else (auth, routing, rate limit, server error) is a backend problem
 * and must degrade the search instead of being silently bisected away.
 */
const POISON_STATUS = new Set([400, 422]);

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
  const candidateLimit = config.vectorCandidateLimit ?? DEFAULT_VECTOR_CANDIDATE_LIMIT;
  assertPositiveInteger("LcmVectorConfig.vectorCandidateLimit", candidateLimit);
  const candidateTokens = config.vectorCandidateTokens ?? DEFAULT_VECTOR_CANDIDATE_TOKENS;
  assertPositiveInteger("LcmVectorConfig.vectorCandidateTokens", candidateTokens);
  const timeoutMs = config.vectorTimeoutMs ?? DEFAULT_VECTOR_TIMEOUT_MS;
  assertPositiveInteger("LcmVectorConfig.vectorTimeoutMs", timeoutMs);
  const cacheDir = config.vectorCacheDir ?? DEFAULT_VECTOR_CACHE_DIR;
  assertNonEmptyString("LcmVectorConfig.vectorCacheDir", cacheDir);
  // The NAME of an environment variable, never the key itself.
  //
  // A hosted gateway needs a bearer token; a local LM Studio does not, which is
  // why this was absent while the only measured backend was keyless. Putting the
  // literal key in the bundle patch would ship a secret in a repository, so the
  // configuration carries the variable name and the value is read from the
  // process environment when a request is built.
  //
  // Empty (the default) sends no Authorization header at all, so every keyless
  // backend keeps working byte for byte.
  const apiKeyEnv = config.vectorApiKeyEnv ?? "";
  if (typeof apiKeyEnv !== "string") throw new Error("LcmVectorConfig.vectorApiKeyEnv must be a string");
  return Object.freeze({
    enabled,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model,
    dim,
    topK,
    candidateLimit,
    candidateTokens,
    timeoutMs,
    cacheDir,
    apiKeyEnv
  });
}

// ── embeddings over HTTP ───────────────────────────────────────────────────

/**
 * Embed texts in batches, preserving input order.
 *
 * The strict view of {@link embedTextsTolerant}: any input the backend refuses
 * fails the whole call. Ranking uses the tolerant view instead, because one
 * rejected string must not cost a question its semantic route.
 *
 * @param cfg - vector settings (raw or resolved).
 * @param texts - input strings.
 * @param signal - optional caller abort signal.
 * @returns one Float32Array per input, in input order.
 * @throws VectorBackendError on a disabled layer, transport failure, HTTP
 *   error, malformed payload, a dimension mismatch, or one refused input.
 *   Never returns zero vectors in place of a failure.
 */
export async function embedTexts(cfg, texts, signal) {
  const { vectors, failures } = await embedTextsTolerant(cfg, texts, signal);
  if (failures.length > 0) throw new VectorBackendError(failures[0].reason);
  return vectors;
}

/**
 * Embed texts, keeping the successes and reporting the failures.
 *
 * A batch is not all-or-nothing. The backend measured in production rejects
 * individual strings for reasons that are about those exact bytes (a 400 whose
 * body is `invalid_type expected number received nan`, stable across runs and
 * reproducible by removing one leading space), so treating a batch as a unit
 * throws away 31 good vectors over one bad one. On failure the batch is halved
 * and both halves are requested independently, recursively, which isolates each
 * refused string in O(log n) requests instead of O(n). Each isolated string gets
 * exactly one cleaned-variant retry (a leading space, which was measured to
 * clear the defect); a string that still fails is reported and skipped.
 *
 * @param cfg - vector settings (raw or resolved).
 * @param texts - input strings.
 * @param signal - optional caller abort signal.
 * @returns `{ vectors, failures }` where `vectors[i]` is a Float32Array or
 *   undefined, and `failures` is `[{ index, text, reason }]`.
 * @throws VectorBackendError when the layer is disabled or the backend itself
 *   is unusable (transport failure, timeout, 5xx, malformed payload) — a dead
 *   backend is never mistaken for a poisoned string.
 */
export async function embedTextsTolerant(cfg, texts, signal) {
  const resolved = resolveVectorConfig(cfg);
  if (!resolved.enabled) throw new VectorBackendError("vector layer is disabled (vectorEnabled: false)");
  const list = Array.from(texts ?? [], (text) => String(text ?? ""));
  const vectors = new Array(list.length);
  const failures = [];
  for (let start = 0; start < list.length; start += MAX_EMBED_BATCH) {
    const batch = list.slice(start, start + MAX_EMBED_BATCH);
    const slots = await embedBatchTolerant(resolved, batch, signal);
    slots.forEach((slot, offset) => {
      if (slot.vector !== undefined) vectors[start + offset] = slot.vector;
      else failures.push({ index: start + offset, text: batch[offset], reason: slot.reason });
    });
  }
  return { vectors, failures };
}

/**
 * Requests one batch may spend isolating refused inputs.
 *
 * Attributing one refused string in a batch of n costs one split per level of
 * the descent, two requests per split, plus one cleaned-variant retry — about
 * `2*log2(n) + 1`. Production showed one to three refusals per question, so the
 * budget is `4*log2(n) + 4`: two attributions of the worst case, and a hard
 * ceiling that keeps a backend refusing everything from turning the session log
 * into a linear scan. A range still unattributed when the budget runs out is
 * skipped and counted rather than embedded by guessing.
 *
 * @param batchSize - texts in the batch.
 * @returns the request budget, always at least 8.
 */
function bisectBudgetOf(batchSize) {
  return Math.max(8, 4 * Math.ceil(Math.log2(Math.max(2, batchSize))) + 4);
}

/**
 * Embed one batch, bisecting on failure until each refused string is isolated.
 *
 * The whole batch is tried once; on refusal both halves are tried, and every
 * half that is still refused is split again. One refused string therefore costs
 * `2*log2(n)` requests rather than n. Two guards keep this from becoming a
 * scan: the split budget caps total requests per batch, and a batch in which
 * *nothing* could be embedded is a backend verdict rather than n poisoned
 * strings, so it fails immediately instead of repeating the descent on every
 * later batch.
 *
 * @param cfg - resolved vector settings.
 * @param batch - the texts of this batch.
 * @param signal - optional caller abort signal.
 * @returns one `{ vector }` or `{ reason }` slot per input, in order.
 * @throws VectorBackendError when the failure is not about the input text, or
 *   when the backend refused every text of the batch.
 */
async function embedBatchTolerant(cfg, batch, signal) {
  const slots = new Array(batch.length);
  if (batch.length === 0) return slots;
  const budget = { left: bisectBudgetOf(batch.length) };
  await fillRange(cfg, batch, 0, batch.length, budget, signal, slots);
  if (slots.every((slot) => slot.vector === undefined)) {
    // Not one string survived, including its cleaned variant: the endpoint is
    // refusing this payload as a whole, so the route is dead, not partial.
    throw new VectorBackendError(slots[0]?.reason ?? "the backend refused every text of the batch");
  }
  return slots;
}

/**
 * Try one range, and split it while it keeps being refused.
 *
 * @param cfg - resolved vector settings.
 * @param batch - the whole batch.
 * @param start - inclusive index.
 * @param end - exclusive index.
 * @param budget - shared request budget, decremented in place.
 * @param signal - optional caller abort signal.
 * @param slots - output slots, mutated in place.
 * @throws VectorBackendError when the failure is not about the input text.
 */
async function fillRange(cfg, batch, start, end, budget, signal, slots) {
  if (budget.left < 1) {
    skipRange(slots, start, end, "embedding request budget exhausted");
    return;
  }
  budget.left -= 1;
  try {
    const vectors = await requestBatch(cfg, batch.slice(start, end), signal);
    vectors.forEach((vector, offset) => {
      slots[start + offset] = { vector };
    });
    return;
  } catch (error) {
    if (!isPoisonCandidate(error)) throw error;
    const reason = reasonOf(error);
    if (end - start === 1) {
      if (budget.left < 1) {
        skipRange(slots, start, end, reason);
        return;
      }
      budget.left -= 1;
      slots[start] = await retryWithPrefix(cfg, batch[start], reason, signal);
      return;
    }
    if (budget.left < 2) {
      skipRange(slots, start, end, reason);
      return;
    }
    const mid = start + Math.floor((end - start) / 2);
    await fillRange(cfg, batch, start, mid, budget, signal, slots);
    await fillRange(cfg, batch, mid, end, budget, signal, slots);
  }
}

/**
 * Mark one unattributed range as skipped and remember why.
 *
 * @param slots - output slots, mutated in place.
 * @param start - inclusive index.
 * @param end - exclusive index.
 * @param reason - the refusal that could not be attributed to a text.
 */
function skipRange(slots, start, end, reason) {
  for (let index = start; index < end; index += 1) slots[index] = { reason };
}

/**
 * One cleaned-variant retry for a single refused text.
 *
 * Measured: prepending a space clears the backend defect, so it is worth
 * exactly one attempt — a string that survives both forms is poison, and a
 * third attempt would only cost latency.
 *
 * @param cfg - resolved vector settings.
 * @param text - the refused text.
 * @param reason - why the original form was refused.
 * @param signal - optional caller abort signal.
 * @returns `{ vector }` on success, `{ reason }` when both forms fail.
 */
async function retryWithPrefix(cfg, text, reason, signal) {
  try {
    const [vector] = await requestBatch(cfg, [" " + text], signal);
    return { vector };
  } catch (retryError) {
    // The variant failed too, so the text is poison in both forms. Anything that
    // is not a verdict on these bytes (transport, 5xx, caller abort) means the
    // backend is in trouble, and that must degrade the search instead.
    if (!isPoisonCandidate(retryError)) throw retryError;
    return { reason };
  }
}

/** True when a failure is the server rejecting these exact bytes. */
function isPoisonCandidate(error) {
  return error instanceof VectorBackendError && error.poison === true;
}

/** Short notice-safe reason of one failure. */
function reasonOf(error) {
  return error instanceof Error ? error.message : String(error ?? "unknown reason");
}

/**
 * The Authorization header for one request, or nothing.
 *
 * Read at request time rather than resolved once, so an operator can rotate the
 * secret in the environment of a long-running process without a rebuild. An
 * empty or unset variable yields no header, which is what a keyless backend
 * expects; a variable that is NAMED but empty is treated the same way, because a
 * backend that needs a key answers 401 and that surfaces in the degradation
 * notice rather than being silently swallowed here.
 *
 * @param cfg - resolved vector settings.
 * @returns the header object to spread into the request, possibly empty.
 */
function authHeader(cfg) {
  if (typeof cfg.apiKeyEnv !== "string" || cfg.apiKeyEnv.length === 0) return {};
  const key = typeof process === "undefined" ? undefined : process.env?.[cfg.apiKeyEnv];
  if (typeof key !== "string" || key.length === 0) return {};
  return { authorization: `Bearer ${key}` };
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
        headers: { "content-type": "application/json", accept: "application/json", ...authHeader(cfg) },
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
      const error = new VectorBackendError(`embedding endpoint ${url} returned HTTP ${response.status}${detail.length > 0 ? ": " + detail : ""}`);
      // 400/413/422 are verdicts on the request payload, so they can be about
      // one string; auth, routing, rate-limit and server errors cannot.
      error.poison = POISON_STATUS.has(response.status);
      throw error;
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
 * Degradation is per text, not per call. A string the backend refuses (measured
 * in production: a stable HTTP 400 on exact bytes) is skipped, so the rest of
 * the log still ranks and one poisoned line cannot cost a question its semantic
 * route. The result carries `skipped` and `failedSeqs` so a caller can see that
 * coverage was partial.
 *
 * @param cfg - vector settings (raw or resolved).
 * @param items - `[{ seq, text }]` candidates (the whole session log).
 * @param queryText - the question, in natural language.
 * @param signal - optional caller abort signal.
 * @param limit - candidates to return; `0` keeps all. Defaults to `vectorTopK`.
 * @returns `[{ seq, score }]` by descending cosine, then descending seq, plus
 *   `skipped` (how many candidates had no usable vector) and `failedSeqs`
 *   (their seqs).
 * @throws VectorBackendError when the backend itself fails, when the question
 *   cannot be embedded, or when every candidate was skipped — those are the
 *   cases where there is no vector ranking to return at all.
 */
export async function rankByVector(cfg, items, queryText, signal, limit) {
  const resolved = resolveVectorConfig(cfg);
  if (!resolved.enabled) return rankedResult([], 0, []);
  const query = embedInputOf(queryText);
  if (query.length === 0) return rankedResult([], 0, []);
  const candidates = [];
  for (const item of items ?? []) {
    if (!Number.isSafeInteger(item?.seq)) continue;
    const text = embedInputOf(item.text);
    if (text.length === 0) continue;
    candidates.push({ seq: item.seq, text });
  }
  if (candidates.length === 0) return rankedResult([], 0, []);

  const cache = vectorCache(resolved);
  const vectors = await cache.getMany([query, ...candidates.map((candidate) => candidate.text)]);
  const needed = new Map();
  if (!vectors.has(query)) needed.set(query, true);
  for (const candidate of candidates) if (!vectors.has(candidate.text)) needed.set(candidate.text, true);
  const failures = [];
  if (needed.size > 0) {
    const texts = [...needed.keys()];
    const embedded = await embedTextsTolerant(resolved, texts, signal);
    embedded.vectors.forEach((vector, index) => {
      if (vector !== undefined) vectors.set(texts[index], vector);
    });
    for (const failure of embedded.failures) failures.push(failure);
    // A cache that cannot be written must not fail the search.
    await cache.setMany(
      texts.filter((text) => vectors.has(text)).map((text) => ({ text, vector: vectors.get(text) }))
    ).catch(() => {});
  }

  const queryVector = vectors.get(query);
  if (queryVector === undefined) {
    // The question itself was refused, so there is no ranking to produce. That
    // is a dead route, not a partial one: the caller must degrade.
    const why = failures.find((failure) => failure.text === query)?.reason ?? "no vector for the query";
    throw new VectorBackendError(why);
  }
  const queryNorm = vectorNorm(queryVector);
  if (queryNorm === 0) return rankedResult([], 0, []);

  const usable = [];
  const failedSeqs = [];
  for (const candidate of candidates) {
    if (vectors.has(candidate.text)) usable.push(candidate);
    else failedSeqs.push(candidate.seq);
  }
  if (usable.length === 0 && failedSeqs.length > 0) {
    // Every candidate was skipped: the backend is not usable for this log.
    const why = failures[0]?.reason ?? "no candidate could be embedded";
    throw new VectorBackendError(why);
  }
  const scored = usable.map((candidate) => ({
    seq: candidate.seq,
    score: cosineSimilarity(queryVector, queryNorm, vectors.get(candidate.text))
  }));
  scored.sort((left, right) => right.score - left.score || right.seq - left.seq);
  const cap = limit ?? resolved.topK;
  return rankedResult(cap > 0 ? scored.slice(0, cap) : scored, failedSeqs.length, failedSeqs);
}

/**
 * Attach the skip diagnostics to one ranking.
 *
 * The ranking stays an array so every existing consumer (`map`, `length`,
 * `[...ranked]`) keeps working unchanged; `skipped` and `failedSeqs` are the
 * added fields.
 *
 * @param entries - ordered `{ seq, score }`.
 * @param skipped - candidates with no usable vector.
 * @param failedSeqs - their seqs, in candidate order.
 * @returns the ranking array with diagnostics attached.
 */
function rankedResult(entries, skipped, failedSeqs) {
  const ranked = entries.slice();
  ranked.skipped = skipped;
  ranked.failedSeqs = failedSeqs.slice();
  return ranked;
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
    Number.isInteger(value.candidateLimit) &&
    Number.isInteger(value.candidateTokens) &&
    Number.isInteger(value.timeoutMs) &&
    typeof value.cacheDir === "string" &&
    typeof value.apiKeyEnv === "string";
}

function assertNonEmptyString(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
}

function assertPositiveInteger(name, value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} (${String(value)}) must be a positive integer`);
  }
}
