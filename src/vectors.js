/**
 * Optional vector-recall layer for `dsh-lcm`.
 *
 * `./search.js` is lexical: a question whose wording does not overlap the
 * recorded text cannot hit it. A semantic route fixes that, and the shape here
 * is the smallest one that works:
 *
 *   - the session log stays the only store — vectors are a *side index*;
 *   - the index lives in memory for one call and on disk as a
 *     content-addressed cache (`sha256(model + "\n" + text)` → raw Float32s),
 *     one directory per model and width under `vectorCacheDir`;
 *   - no database, no new dependency: built-in `fetch`, `node:crypto` and
 *     `node:fs/promises`;
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
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// ── defaults ───────────────────────────────────────────────────────────────

/** The layer is opt-in. Off means zero extra work and zero network calls. */
export const DEFAULT_VECTOR_ENABLED = false;
/**
 * OpenAI-compatible embeddings root; `/embeddings` is appended.
 *
 * These three defaults describe the endpoint the SHIPPED bundle rows use, not a
 * guess: a bare `vectorEnabled: true` with nothing else must land somewhere real.
 * They previously named a LAN LM Studio serving a 4096-d model, which no longer
 * answers — a default pointing at a dead host is worse than one pointing at a
 * host that replies 401, because a 401 names the problem and an unreachable host
 * does not. The layer stays off unless asked, so this changes no existing setup.
 */
export const DEFAULT_VECTOR_BASE_URL = "http://10.126.126.4:20128/v1";
/** Measured live 2026-11-09: 1536 dimensions, unit-norm output. */
export const DEFAULT_VECTOR_MODEL = "mistral-proxy/codestral-embed";
/** Width of one embedding; a mismatch means the model changed, not that we guess. */
export const DEFAULT_VECTOR_DIM = 1536;
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
 *
 * A window is a price, not a promise: how much of it one search actually reaches
 * is decided by {@link DEFAULT_VECTOR_SEARCH_BUDGET_MS}, so a window wider than
 * the budget covers is filled by repeated searches (each one resumes from the
 * cache the previous one warmed) or by `/lcm-embed backfill`.
 */
export const DEFAULT_VECTOR_CANDIDATE_TOKENS = 100000;
/** Per-request ceiling, so a hung backend cannot hold a search open. */
export const DEFAULT_VECTOR_TIMEOUT_MS = 20000;

/**
 * Wall-clock ceiling one SEARCH may spend embedding, across every request.
 *
 * A per-request timeout is not a bound on a search: it multiplies by the number
 * of batches the candidate window needs. Measured on the shipped endpoint
 * (mistral-proxy/codestral-embed, 2026-11-09), a 32-text batch costs 2.6-5.1 s
 * with one 65.6 s tail, so a 60-event window is two POSTs and a stalled one
 * costs the full per-request timeout:
 *
 *   2 batches x 20 000 ms = 40 s, doubled by the transient retry, and 2*log2(32)
 *   + 1 = 11 more probe requests when a batch is refused and the caller bisects;
 *
 * i.e. the search's worst case was the *number of batches* x the ceiling, which
 * is how a live search sat 40+ s and then degraded. One deadline makes the whole
 * embedding phase cost at most this, whatever the window and whatever the
 * refusal pattern: every request's timeout becomes
 * `min(vectorTimeoutMs, deadline - now)`, bisection included.
 *
 * The effective budget is `max(this, vectorTimeoutMs)` — see
 * {@link vectorSearchBudgetMs} — so a configured per-request ceiling is never
 * silently shortened. A constant, not a configuration key, for the same reason
 * `MAX_EMBED_BATCH` is: it is a safety bound against a stalled endpoint, not a
 * performance setting. Raising it only lengthens a stall.
 */
export const DEFAULT_VECTOR_SEARCH_BUDGET_MS = 30000;

/**
 * The embedding budget one search actually gets, in milliseconds.
 *
 * `max(ceiling, default budget)`: a caller that raised `vectorTimeoutMs` for a
 * slow endpoint still gets one full-length request, while the budget still
 * refuses the second one once that time is gone. Never shorter than the
 * per-request ceiling, so the configured knob is honoured exactly once.
 *
 * @param cfg - vector settings (raw or resolved).
 * @returns the budget in milliseconds, a positive integer.
 */
export function vectorSearchBudgetMs(cfg) {
  const resolved = resolveVectorConfig(cfg);
  return Math.max(DEFAULT_VECTOR_SEARCH_BUDGET_MS, resolved.timeoutMs);
}
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

/** Credential store file name inside the dsh home. */
const CREDENTIAL_STORE_FILE = ".credentials.yaml";

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
 * @param options - optional `{ deadline }`, an absolute epoch-ms instant the
 *   whole call must fit in. Every request's timeout becomes
 *   `min(vectorTimeoutMs, deadline - now)`, bisection included, so a refused
 *   batch cannot spend more wall clock than a clean one. Absent means the plain
 *   per-request ceiling.
 * @returns `{ vectors, failures }` where `vectors[i]` is a Float32Array or
 *   undefined, and `failures` is `[{ index, text, reason }]`.
 * @throws VectorBackendError when the layer is disabled or the backend itself
 *   is unusable (transport failure, timeout, budget exhaustion, 5xx, malformed
 *   payload) — a dead backend is never mistaken for a poisoned string.
 */
export async function embedTextsTolerant(cfg, texts, signal, options = {}) {
  const resolved = resolveVectorConfig(cfg);
  if (!resolved.enabled) throw new VectorBackendError("vector layer is disabled (vectorEnabled: false)");
  const list = Array.from(texts ?? [], (text) => String(text ?? ""));
  const deadline = options?.deadline;
  const vectors = new Array(list.length);
  const failures = [];
  for (let start = 0; start < list.length; start += MAX_EMBED_BATCH) {
    const batch = list.slice(start, start + MAX_EMBED_BATCH);
    const slots = await embedBatchTolerant(resolved, batch, signal, deadline);
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
 * @param deadline - optional absolute epoch-ms budget for the whole batch.
 * @returns one `{ vector }` or `{ reason }` slot per input, in order.
 * @throws VectorBackendError when the failure is not about the input text, or
 *   when the backend refused every text of the batch.
 */
async function embedBatchTolerant(cfg, batch, signal, deadline) {
  const slots = new Array(batch.length);
  if (batch.length === 0) return slots;
  const budget = { left: bisectBudgetOf(batch.length) };
  await fillRange(cfg, batch, 0, batch.length, budget, signal, slots, deadline);
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
 * @param deadline - optional absolute epoch-ms budget, shared by every probe.
 * @throws VectorBackendError when the failure is not about the input text.
 */
async function fillRange(cfg, batch, start, end, budget, signal, slots, deadline) {
  if (budget.left < 1) {
    skipRange(slots, start, end, "embedding request budget exhausted");
    return;
  }
  budget.left -= 1;
  try {
    const vectors = await requestBatch(cfg, batch.slice(start, end), signal, deadline);
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
      slots[start] = await retryWithPrefix(cfg, batch[start], reason, signal, deadline);
      return;
    }
    if (budget.left < 2) {
      skipRange(slots, start, end, reason);
      return;
    }
    const mid = start + Math.floor((end - start) / 2);
    await fillRange(cfg, batch, start, mid, budget, signal, slots, deadline);
    await fillRange(cfg, batch, mid, end, budget, signal, slots, deadline);
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
 * @param deadline - optional absolute epoch-ms budget, shared with the descent.
 * @returns `{ vector }` on success, `{ reason }` when both forms fail.
 */
async function retryWithPrefix(cfg, text, reason, signal, deadline) {
  try {
    const [vector] = await requestBatch(cfg, [" " + text], signal, deadline);
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
 * Authorization for one request, and which source answered it.
 *
 * The configuration carries the NAME of a variable, never a key: this bundle
 * ships in a repository, so the literal secret cannot live in the composition.
 * Two sources can satisfy that name, in priority order:
 *
 *   1. the process environment — read per request, so a long-running process
 *      can rotate the secret without a rebuild;
 *   2. the dsh credential store, `$DSH_HOME/.credentials.yaml` (or
 *      `$HOME/.dsh/.credentials.yaml` when `DSH_HOME` is unset), whose
 *      top-level `refs:` block holds `NAME: value` pairs. This is what makes
 *      the layer operable without exporting a variable into every process.
 *
 * An unset OR empty variable is not a key, so it falls through to the store; a
 * named-but-empty store entry is the same. Nothing found yields no header at
 * all, which is what a keyless backend expects — a backend that does need one
 * answers 401, and that surfaces in the degradation notice instead of being
 * silently swallowed here.
 *
 * The record names the source and puts the secret in exactly one place (the
 * header), so the record itself can be logged.
 *
 * @param cfg - vector settings (raw or resolved).
 * @returns `{ header, source }` — header is the object to spread into fetch
 *   headers (`{}` when none), source is "env" | "credential-store" | "none".
 */
export async function resolveVectorAuth(cfg) {
  const resolved = resolveVectorConfig(cfg);
  const name = resolved.apiKeyEnv;
  if (typeof name !== "string" || name.length === 0) return { header: {}, source: "none" };
  const fromEnv = typeof process === "undefined" ? undefined : process.env?.[name];
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return { header: { authorization: `Bearer ${fromEnv}` }, source: "env" };
  }
  for (const path of credentialStorePaths()) {
    const stored = parseCredentialRefs(await readCredentialStore(path)).get(name);
    if (typeof stored === "string" && stored.length > 0) {
      return { header: { authorization: `Bearer ${stored}` }, source: "credential-store" };
    }
  }
  return { header: {}, source: "none" };
}

/**
 * Where the credential store may live, most specific first.
 *
 * Only these two paths are consulted; an operator who keeps the file elsewhere
 * sets `DSH_HOME` at it, which is the documented dsh home.
 *
 * @returns absolute candidate paths, de-duplicated, never empty unless the
 *   process has neither `DSH_HOME` nor a home directory.
 */
function credentialStorePaths() {
  const env = typeof process === "undefined" ? undefined : process.env;
  const paths = [];
  const dshHome = env?.DSH_HOME;
  if (typeof dshHome === "string" && dshHome.length > 0) paths.push(join(dshHome, CREDENTIAL_STORE_FILE));
  const home = typeof env?.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir();
  if (typeof home === "string" && home.length > 0) {
    const fallback = join(home, ".dsh", CREDENTIAL_STORE_FILE);
    if (!paths.includes(fallback)) paths.push(fallback);
  }
  return paths;
}

/**
 * Read one credential file, or "" when it is absent.
 *
 * The store is optional and is consulted on every request that has no
 * environment value, so a missing, unreadable or directory-shaped path is an
 * empty store rather than a failed search. The content is never logged.
 *
 * @param path - absolute path of the credential store.
 * @returns the file text, or "" when it cannot be read.
 */
async function readCredentialStore(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Parse the top-level `refs:` block of the credential store.
 *
 * Deliberately not a YAML parser: the store also holds a nested `records:`
 * block whose keys contain "/" and whose values are quoted blobs, and all this
 * layer needs is the flat `NAME: value` map under `refs:`. A new top-level
 * key ends the block, so `records:` content can never be mistaken for a ref
 * even when it appears first.
 *
 * @param text - raw file content.
 * @returns a Map of reference name to value; empty when the block is absent.
 */
function parseCredentialRefs(text) {
  const refs = new Map();
  let inRefs = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const top = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (top !== null) {
      inRefs = top[1] === "refs";
      continue;
    }
    if (!inRefs) continue;
    const entry = /^\s+([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (entry === null) continue;
    const value = unquote(entry[2].trim());
    if (value.length > 0) refs.set(entry[1], value);
  }
  return refs;
}

/** Strip one pair of matching YAML quotes from a scalar. */
function unquote(value) {
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Transient attempts per batch, including the first.
 *
 * Measured on the shipped endpoint (mistral-proxy/codestral-embed, 2026-11-09):
 * eight consecutive 32-text batches returned 200 in 2.6/5.1/3.0/65.6/2.6/... s,
 * and a longer run produced an HTTP 500 mid-way. The 500 aborted a whole backfill
 * pass — one server-side hiccup and nothing was warmed — so a batch retries once
 * before the failure is believed.
 *
 * A TIMEOUT is deliberately not retried: the wall clock was already spent, and a
 * second 20 s wait inside a live search is worse than degrading to lexical.
 */
const TRANSIENT_ATTEMPTS = 2;

/** Delay before the retry, long enough for a proxy hiccup to clear. */
const TRANSIENT_RETRY_MS = 250;

/**
 * Whether a failure is worth one more identical request.
 *
 * 5xx and transport errors are the server's problem, so the same bytes may
 * succeed. A payload verdict (400/413/422) and a timeout are not retried here:
 * the first is about these bytes and belongs to the bisection path, the second
 * has no budget left.
 *
 * @param error - the failure from one attempt.
 * @returns true when the same request may be repeated once.
 */
function isTransientBackendFailure(error) {
  if (!(error instanceof VectorBackendError)) return false;
  if (error.poison === true) return false;
  if (error.budget === true) return false;
  if (/timed out|aborted/u.test(error.message)) return false;
  if (typeof error.status === "number") return error.status >= 500;
  return true;
}

/**
 * POST one batch, retrying a transient failure once.
 *
 * @param cfg - vector settings.
 * @param batch - input strings.
 * @param signal - optional caller abort signal.
 * @param deadline - optional absolute epoch-ms budget, re-read per attempt.
 * @returns one Float32Array per input.
 */
async function requestBatch(cfg, batch, signal, deadline) {
  let last;
  for (let attempt = 1; attempt <= TRANSIENT_ATTEMPTS; attempt += 1) {
    try {
      return await requestBatchOnce(cfg, batch, signal, deadline);
    } catch (error) {
      if (signal?.aborted === true || !isTransientBackendFailure(error)) throw error;
      last = error;
      if (attempt < TRANSIENT_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_MS));
    }
  }
  throw last;
}

/**
 * The wall clock one request may use: the ceiling, or what is left of the budget.
 *
 * Both bounds are real: the ceiling is what an operator configured, the budget is
 * what this search may still spend. Without the second one a five-batch window
 * spends five ceilings, which is the shape that made a live search sit for 40+ s.
 * A budget that is already gone refuses the request instead of sending a doomed
 * one — a distinct `budget` error, never a poison verdict and never retried.
 *
 * @param cfg - resolved vector settings.
 * @param deadline - absolute epoch-ms budget, or undefined for the plain ceiling.
 * @returns the timeout to arm, a positive integer.
 * @throws VectorBackendError with `budget: true` when the budget is spent.
 */
function budgetedTimeout(cfg, deadline) {
  if (deadline === undefined) return cfg.timeoutMs;
  const remaining = deadline - Date.now();
  if (remaining < 1) {
    const error = new VectorBackendError("embedding time budget exhausted");
    error.budget = true;
    throw error;
  }
  return Math.min(cfg.timeoutMs, remaining);
}

/** POST one batch and decode its vectors, with a bounded wall clock. */
async function requestBatchOnce(cfg, batch, signal, deadline) {
  const url = cfg.baseUrl + "/embeddings";
  const timeoutMs = budgetedTimeout(cfg, deadline);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal !== undefined && signal !== null) {
    if (signal.aborted) forwardAbort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
  }
  try {
    const auth = await resolveVectorAuth(cfg);
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...auth.header },
        body: JSON.stringify({ model: cfg.model, input: batch }),
        signal: controller.signal
      });
    } catch (error) {
      if (timedOut) throw new VectorBackendError(`embedding endpoint ${url} timed out after ${timeoutMs}ms`, { cause: error });
      if (signal?.aborted === true) throw new VectorBackendError(`embedding request aborted: ${describe(signal.reason)}`, { cause: error });
      throw new VectorBackendError(`embedding endpoint ${url} unreachable: ${networkReason(error)}`, { cause: error });
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
      const error = new VectorBackendError(`embedding endpoint ${url} returned HTTP ${response.status}${detail.length > 0 ? ": " + detail : ""}`);
      // 400/413/422 are verdicts on the request payload, so they can be about
      // one string; auth, routing, rate-limit and server errors cannot.
      error.poison = POISON_STATUS.has(response.status);
      error.status = response.status;
      throw error;
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if (timedOut) throw new VectorBackendError(`embedding endpoint ${url} timed out after ${timeoutMs}ms`, { cause: error });
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
 * The directory one model owns under the cache root.
 *
 * Flat, every model wrote into one directory and an old model's files were
 * indistinguishable from live ones — visible bytes with an invisible owner.
 * Twelve hex characters of the model digest plus the vector width name the
 * owner, so two models never share a directory, a stale model can be deleted as
 * one unit, and the per-text key stays what it always was.
 *
 * @param resolved - resolved vector settings.
 * @returns absolute directory path for this model and width.
 */
export function vectorCacheDirOf(resolved) {
  const modelTag = createHash("sha256").update(resolved.model, "utf8").digest("hex").slice(0, 12);
  return join(resolved.cacheDir, `${modelTag}-${resolved.dim}`);
}

/**
 * Open the content-addressed vector cache.
 *
 * Directory is `<cacheDir>/<12 hex of sha256(model)>-<dim>/`, key is
 * `sha256(model + "\n" + text)`, value is a headerless little-endian Float32
 * blob written to a temporary file and renamed into place, so a concurrent
 * reader never sees a half-written vector. Every failure to read is a miss (the
 * cache is an optimisation, never a source of truth); a failed write is dropped
 * by callers.
 *
 * @param cfg - vector settings (raw or resolved).
 * @returns `{ dir, model, key, path, get, set, getMany, setMany }` — `dir` is
 *   the model's own directory, not the shared root.
 */
export function vectorCache(cfg) {
  const resolved = resolveVectorConfig(cfg);
  const dir = vectorCacheDirOf(resolved);
  const digest = (text) => createHash("sha256").update(resolved.model + "\n" + String(text ?? ""), "utf8").digest("hex");
  const fileOf = (text) => join(dir, digest(text) + CACHE_EXT);

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
    await mkdir(dir, { recursive: true });
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

  return { dir, model: resolved.model, key: digest, path: fileOf, get, set, getMany, setMany };
}

/**
 * What the current model's cache directory holds.
 *
 * `dir` is reported even when nothing has been cached yet, because the caller
 * needs to know WHERE the layer would write; a missing directory is zeros, not
 * an error — the first search legitimately runs before any file exists.
 *
 * @param cfg - vector settings (raw or resolved).
 * @returns `{ dir, model, dim, files, bytes }`, counting `.f32` files only.
 */
export async function vectorCacheStats(cfg) {
  const resolved = resolveVectorConfig(cfg);
  const dir = vectorCacheDirOf(resolved);
  const report = { dir, model: resolved.model, dim: resolved.dim, files: 0, bytes: 0 };
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return report;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(CACHE_EXT)) continue;
    report.bytes += (await stat(join(dir, entry.name))).size;
    report.files += 1;
  }
  return report;
}

/**
 * Delete every sibling cache directory that belongs to another model.
 *
 * The cache root is the layer's own (`vectorCacheDir`), and each subdirectory
 * under it is one model's index, so anything that is not the current one is a
 * superseded or foreign model. Removal is per directory, recursively, and a
 * missing root removes nothing.
 *
 * @param cfg - vector settings (raw or resolved).
 * @returns `{ removed, bytes }` — directories deleted and the bytes they held.
 */
export async function pruneForeignVectorCaches(cfg) {
  const resolved = resolveVectorConfig(cfg);
  const keep = basename(vectorCacheDirOf(resolved));
  let entries;
  try {
    entries = await readdir(resolved.cacheDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { removed: 0, bytes: 0 };
    throw error;
  }
  let removed = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keep) continue;
    const path = join(resolved.cacheDir, entry.name);
    bytes += await directoryBytes(path);
    await rm(path, { recursive: true, force: true });
    removed += 1;
  }
  return { removed, bytes };
}

/**
 * Total bytes of the regular files under one directory, recursively.
 *
 * @param dir - directory to measure.
 * @returns bytes, or 0 for a directory that vanished before it could be read.
 */
async function directoryBytes(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
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
 * The embedding phase is bounded in WALL CLOCK, not in requests submitted:
 * {@link vectorSearchBudgetMs} is one deadline for every POST this call makes,
 * and each POST's timeout is `min(vectorTimeoutMs, deadline - now)`, bisection
 * included. Work is done one {@link MAX_EMBED_BATCH} group at a time, newest
 * candidate first, and each group is written to the cache the moment it returns.
 * Two consequences that matter more than the tuning:
 *
 *   - a stall costs the budget, not the budget times the number of batches, so a
 *     search cannot sit for minutes on a slow endpoint;
 *   - a search that times out half-way still ANSWERS with the vectors it has and
 *     still leaves them on disk, so the next search resumes instead of paying for
 *     the same texts again. Before this, the whole embedding pass was written
 *     after the single tolerant call returned, and a throw discarded every vector
 *     the endpoint had already produced — a cold cache on a flaky endpoint could
 *     never warm.
 *
 * @param cfg - vector settings (raw or resolved).
 * @param items - `[{ seq, text }]` candidates (the whole session log).
 * @param queryText - the question, in natural language.
 * @param signal - optional caller abort signal.
 * @param limit - candidates to return; `0` keeps all. Defaults to `vectorTopK`.
 * @param options - optional `{ budgetMs }` override for the embedding deadline
 *   (tests and callers that measure a different tolerance). Defaults to
 *   {@link vectorSearchBudgetMs}.
 * @returns `[{ seq, score }]` by descending cosine, then descending seq, plus
 *   `skipped` (how many candidates had no usable vector), `failedSeqs` (their
 *   seqs) and `budgetExhausted` (true when the deadline, not the text, is what
 *   stopped the embedding: the ranking is partial by construction).
 * @throws VectorBackendError when the backend itself fails, when the question
 *   cannot be embedded, or when every candidate was skipped — those are the
 *   cases where there is no vector ranking to return at all.
 */
export async function rankByVector(cfg, items, queryText, signal, limit, options = {}) {
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
  const budgetMs = Number.isSafeInteger(options?.budgetMs) && options.budgetMs > 0
    ? options.budgetMs
    : vectorSearchBudgetMs(resolved);
  const deadline = Date.now() + budgetMs;
  const failures = [];
  // The query first, then the NEWEST candidate: the recent-but-compacted event is
  // the likelier answer, so a budget that runs out has spent itself on the half of
  // the window worth having. The window arrives oldest-first (log order).
  const pending = missingTextsOf(vectors, query, candidates);
  let budgetExhausted = false;
  for (let start = 0; start < pending.length; start += MAX_EMBED_BATCH) {
    if (Date.now() >= deadline) {
      budgetExhausted = true;
      break;
    }
    const batch = pending.slice(start, start + MAX_EMBED_BATCH);
    let embedded;
    try {
      embedded = await embedTextsTolerant(resolved, batch, signal, { deadline });
    } catch (error) {
      // A caller abort is the caller's decision, not a budget: pass it through.
      if (signal?.aborted === true) throw error;
      // Without the query there is no ranking at all, so a dead route stays dead
      // (the caller degrades to lexical, as before). After the query has landed,
      // what this search already paid for is worth keeping: stop asking and answer
      // with the groups that did return.
      if (!vectors.has(query)) throw error;
      budgetExhausted = true;
      failures.push({ index: start, text: batch[0], reason: reasonOf(error) });
      break;
    }
    embedded.vectors.forEach((vector, index) => {
      if (vector !== undefined) vectors.set(batch[index], vector);
    });
    for (const failure of embedded.failures) failures.push(failure);
    // Persist THIS group before asking for the next one. A cache that cannot be
    // written must not fail the search.
    await cache.setMany(
      batch.filter((text) => vectors.has(text)).map((text) => ({ text, vector: vectors.get(text) }))
    ).catch(() => {});
  }

  const queryVector = vectors.get(query);
  if (queryVector === undefined) {
    // The question itself was never embedded, so there is no ranking to produce.
    // That is a dead route, not a partial one: the caller must degrade.
    const why = failures.find((failure) => failure.text === query)?.reason ??
      (budgetExhausted
        ? `embedding time budget exhausted (${budgetMs}ms) before the query was embedded`
        : "no vector for the query");
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
  return rankedResult(cap > 0 ? scored.slice(0, cap) : scored, failedSeqs.length, failedSeqs, budgetExhausted);
}

/**
 * The texts one search still has to embed, in the order it will embed them.
 *
 * The query leads, because without it there is no ranking at all; the candidates
 * follow NEWEST first, because the window is a recency window and a budget that
 * runs out should have bought the likelier half. De-duplicated by text, which is
 * also the cache key, so two events with identical bodies cost one vector.
 *
 * @param vectors - the warmed cache entries, keyed by text.
 * @param query - the embedded query text.
 * @param candidates - `[{ seq, text }]` in log order.
 * @returns the texts to embed, query first, candidates newest-first.
 */
function missingTextsOf(vectors, query, candidates) {
  const texts = [];
  const seen = new Set();
  if (!vectors.has(query)) {
    texts.push(query);
    seen.add(query);
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const text = candidates[index].text;
    if (vectors.has(text) || seen.has(text)) continue;
    seen.add(text);
    texts.push(text);
  }
  return texts;
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
 * @param budgetExhausted - true when the embedding deadline, not the text, is
 *   what left candidates without a vector. Defaults to false.
 * @returns the ranking array with diagnostics attached.
 */
function rankedResult(entries, skipped, failedSeqs, budgetExhausted = false) {
  const ranked = entries.slice();
  ranked.skipped = skipped;
  ranked.failedSeqs = failedSeqs.slice();
  ranked.budgetExhausted = budgetExhausted === true;
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
