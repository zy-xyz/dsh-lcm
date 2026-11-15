/**
 * Live (restart-free) tuning for the two config surfaces this plugin has.
 *
 * The engine row and the tool/command rows are separate Cordis rows with separate
 * configs, and both resolve their config ONCE at load. Resolved configs are read
 * as `cfg.key` at decision time everywhere, never destructured at construction —
 * which is what makes a swap-in-place sufficient: assign the new resolved object
 * onto the row's field (engine) or Object.assign it onto the row's live resolved
 * record (tool/command) and the next decision sees it.
 *
 * The overlay file is what makes it survive a restart: every row merges its
 * surface's slice in before resolving, so a value set from the panel is also the
 * value a freshly booted process starts with.
 *
 * The key list is a WHITELIST on purpose. `modelPolicies` and
 * `summarizationProvider/Model` change which route a pending request would use,
 * and a config edit mid-turn would silently re-target a request already priced
 * against the old route.
 *
 * @module dsh-lcm/live
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where the panel's edits are persisted. */
function overlayPath() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
  return path.join(home, "lcm-live.json");
}

/**
 * Every key the panel may change.
 *
 * `surface` says which row owns the key: the engine row reads `compaction`, the
 * tool and command rows read `vector`. `risk` is shown beside the field in the
 * panel — it does not block the edit, it says what changing it at runtime means.
 *
 * The two keys with no risk note are the ones this panel exists for: thresholds,
 * token budgets and embedding fan-out are pure decisions re-read on every use, so
 * a new value is in force at the next decision with nothing left half-applied.
 * Everything else is editable because the operator asked for the whole surface,
 * and carries the note that makes its consequence visible before the click.
 */
export const HOT_KEYS = Object.freeze([
  // ── compaction: pure decisions, safe by construction ──────────────────
  { key: "thresholdRatio", surface: "compaction", type: "number", min: 0, exclusiveMax: 1 },
  { key: "retainRatio", surface: "compaction", type: "number", min: 0, exclusiveMax: 1 },
  { key: "summaryRatio", surface: "compaction", type: "number", min: 0, exclusiveMax: 1 },
  { key: "summaryFloorTokens", surface: "compaction", type: "integer", min: 1 },
  { key: "checkpointCap", surface: "compaction", type: "integer", min: 1 },
  { key: "leafSpanTokens", surface: "compaction", type: "integer", min: 1 },
  { key: "condensationFanin", surface: "compaction", type: "integer", min: 2 },
  { key: "thresholdFullSweep", surface: "compaction", type: "boolean" },
  { key: "fullSweepMaxPasses", surface: "compaction", type: "integer", min: 1 },
  { key: "fullSweepMaxSeconds", surface: "compaction", type: "integer", min: 1 },
  { key: "fullSweepSoftSeconds", surface: "compaction", type: "integer", min: 1 },
  { key: "fullSweepTargetShare", surface: "compaction", type: "number", min: 0, exclusiveMax: 1 },
  { key: "fullSweepReserveSeconds", surface: "compaction", type: "number", min: 0 },
  { key: "leafEstimateFloorSeconds", surface: "compaction", type: "number", min: 0 },
  { key: "stallCooldownMs", surface: "compaction", type: "integer", min: 0 },
  { key: "anchorPointers", surface: "compaction", type: "boolean" },
  { key: "emptySummaryRetries", surface: "compaction", type: "integer", min: 0 },
  { key: "backgroundLeafPrep", surface: "compaction", type: "boolean" },
  { key: "auto", surface: "compaction", type: "boolean" },
  { key: "maxTokens", surface: "compaction", type: "integer", min: 1 },
  { key: "headroomTokens", surface: "compaction", type: "integer", min: 1 },
  { key: "compactionRetries", surface: "compaction", type: "integer", min: 0 },
  { key: "maxOverflowRetries", surface: "compaction", type: "integer", min: 0 },
  // ── compaction: changes an in-flight decision's inputs ────────────────
  {
    key: "retainTokens",
    surface: "compaction",
    type: "integer",
    min: 1,
    risk: "Exclusive with retainRatio: setting it drops retainRatio, and a compaction already priced against the ratio keeps the old boundary."
  },
  {
    key: "summarizationProvider",
    surface: "compaction",
    type: "string",
    risk: "Re-routes summarization. The next leaf uses it; a request already streaming to the old route finishes there. Must be set together with summarizationModel."
  },
  {
    key: "summarizationModel",
    surface: "compaction",
    type: "string",
    risk: "Re-routes summarization. Same rule as summarizationProvider: both or neither."
  },
  {
    key: "temporalRollups",
    surface: "compaction",
    type: "boolean",
    risk: "Toggles the background rollup pass. Turning it off leaves already-built rollups on disk; nothing deletes them."
  },
  {
    key: "rollupBuildsPerPass",
    surface: "compaction",
    type: "integer",
    min: 1,
    risk: "Background rollup budget per idle pass. No effect while temporalRollups is off."
  },
  {
    key: "rollupMaintenanceBudgetMs",
    surface: "compaction",
    type: "integer",
    min: 1,
    risk: "Wall clock for one rollup pass. Raising it holds the idle slot longer."
  },
  {
    key: "rollupDailyTargetTokens",
    surface: "compaction",
    type: "integer",
    min: 1,
    risk: "Target size of one day's rollup; the pass asks the model for this many tokens."
  },
  {
    key: "rollupDailyMaxTokens",
    surface: "compaction",
    type: "integer",
    min: 1,
    risk: "Ceiling for one day's rollup. A value below rollupDailyTargetTokens makes the target unreachable."
  },
  {
    key: "assertionExtraction",
    surface: "compaction",
    type: "boolean",
    risk: "Toggles the background assertion mining pass. Existing sidecar rows stay on disk."
  },
  {
    key: "assertionMaxSourcesPerPass",
    surface: "compaction",
    type: "integer",
    min: 1,
    risk: "How many checkpoints one mining pass reads. It is also the pass's cost."
  },
  {
    key: "assertionTimeoutSeconds",
    surface: "compaction",
    type: "integer",
    min: 1,
    risk: "Deadline for one mining pass; a slower model needs a larger value or the pass is skipped."
  },
  {
    key: "rollupDir",
    surface: "compaction",
    type: "string",
    risk: "Where rollups are read from. Changing it makes every existing rollup look absent; the files stay where they were."
  },
  {
    key: "assertionDir",
    surface: "compaction",
    type: "string",
    risk: "Where assertions are read from. Same consequence as rollupDir."
  },
  {
    key: "debug",
    surface: "compaction",
    type: "boolean",
    risk: "Diagnostic logging. On, every decision appends a line to debugLogPath."
  },
  {
    key: "modelPolicies",
    surface: "compaction",
    type: "json",
    risk: "Per-route overrides, as a JSON array of {provider, model, ...policy}. A policy that names a model with no exact-target match does nothing, and an entry missing provider or model is rejected. Edited as raw JSON because the shape is a table, not a field."
  },
  {
    key: "debugLogPath",
    surface: "compaction",
    type: "string",
    risk: "Where diagnostic lines go. Only read while debug is on."
  },
  // ── vector surface: the tool and command rows ────────────────────────
  { key: "vectorEnabled", surface: "vector", type: "boolean" },
  { key: "vectorConcurrency", surface: "vector", type: "integer", min: 1 },
  { key: "vectorTimeoutMs", surface: "vector", type: "integer", min: 1 },
  { key: "vectorTopK", surface: "vector", type: "integer", min: 1 },
  { key: "vectorCandidateTokens", surface: "vector", type: "integer", min: 1 },
  { key: "vectorCandidateLimit", surface: "vector", type: "integer", min: 1 },
  { key: "embedMaintenanceLimit", surface: "vector", type: "integer", min: 1 },
  {
    key: "rank",
    surface: "vector",
    type: "string",
    risk: "Changes how lcm_search ranks. A vector or hybrid value is inert unless vectorEnabled is on."
  },
  { key: "maxRecallTokens", surface: "vector", type: "integer", min: 1 },
  { key: "maxSearchHits", surface: "vector", type: "integer", min: 1 },
  {
    key: "legacyNames",
    surface: "vector",
    type: "boolean",
    risk: "The legacy recall/search aliases are chosen when the tools are registered, so this one keeps the old aliases until dsh restarts. Every other key here is live."
  },
  { key: "allowLanAccess", surface: "vector", type: "boolean", risk: "Serving the insight endpoints beyond loopback. This panel writes config; leaving it off keeps the write path local." },
  {
    key: "vectorBaseUrl",
    surface: "vector",
    type: "string",
    risk: "Points the layer at a different endpoint. Vectors already cached were produced by the old one and are keyed by model, so a mismatched pair mixes two spaces."
  },
  {
    key: "vectorModel",
    surface: "vector",
    type: "string",
    risk: "Changes the embedding model. The cache is keyed by model, so nothing embedded so far is reused."
  },
  {
    key: "vectorDim",
    surface: "vector",
    type: "integer",
    min: 1,
    risk: "Must match the model's real width; a mismatch makes every stored vector unusable."
  },
  {
    key: "vectorCacheDir",
    surface: "vector",
    type: "string",
    risk: "Switching it makes the whole existing cache look absent."
  },
  {
    key: "vectorApiKeyEnv",
    surface: "vector",
    type: "string",
    risk: "Names an environment variable, never the key itself. A name the process does not export sends no Authorization header."
  }
]);

const BY_KEY = new Map(HOT_KEYS.map((entry) => [entry.key, entry]));

/**
 * Resolved field names for the vector keys.
 *
 * `resolveVectorConfig` RENAMES them when it freezes the record — the raw key is
 * `vectorEnabled`, the resolved field is `enabled`. A row reporting its live values
 * hands back the RESOLVED object, so without this table the form showed every
 * `vector*` field as unset while the layer was running. Same trap the panel's
 * vector-detection test pins for `enabled`.
 */
const RESOLVED_NAMES = Object.freeze({
  vectorEnabled: "enabled",
  vectorBaseUrl: "baseUrl",
  vectorModel: "model",
  vectorDim: "dim",
  vectorTopK: "topK",
  vectorCandidateLimit: "candidateLimit",
  vectorCandidateTokens: "candidateTokens",
  vectorTimeoutMs: "timeoutMs",
  vectorConcurrency: "concurrency",
  vectorCacheDir: "cacheDir",
  vectorApiKeyEnv: "apiKeyEnv"
});

/**
 * The hot keys one surface owns.
 *
 * Both the tool row and the command row resolve the same `vector*` keys, so a
 * patch must reach both; routing per key instead would let the row that happens
 * to be registered first absorb an edit the other never sees.
 * @param surface - `compaction` or `vector`.
 * @returns a Set of key names.
 */
export function hotKeysFor(surface) {
  const out = new Set();
  for (const entry of HOT_KEYS) if (entry.surface === surface) out.add(entry.key);
  return out;
}

/** Rows that can absorb a live patch, in registration order. */
const consumers = new Map();

/**
 * The persisted overlay, read fresh each call.
 *
 * A malformed or unreadable file must not take the row down: the overlay is a
 * convenience layer over the patch file, so an unreadable one means "no
 * overrides", which is also what a missing file means.
 * @returns the stored `{ compaction?, vector? }` object, or an empty one.
 */
export function readOverlay() {
  let raw;
  try {
    raw = fs.readFileSync(overlayPath(), "utf8");
  } catch {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out = {};
  for (const surface of ["compaction", "vector"]) {
    const slice = parsed[surface];
    if (slice === null || typeof slice !== "object" || Array.isArray(slice)) continue;
    const clean = {};
    for (const [key, value] of Object.entries(slice)) {
      const entry = BY_KEY.get(key);
      if (entry === undefined || entry.surface !== surface) continue;
      clean[key] = value;
    }
    if (Object.keys(clean).length > 0) out[surface] = clean;
  }
  return out;
}

/**
 * One surface's persisted overrides.
 * @param surface - `compaction` or `vector`.
 * @returns the stored key/value pairs for that surface, or an empty object.
 */
export function overlayFor(surface) {
  return readOverlay()[surface] ?? {};
}

/**
 * Persist one surface's overrides, replacing what was there.
 *
 * Atomic by rewrite-through-rename: the panel can be saved twice in a second and
 * a half-written file would make every later boot fall back to "no overrides"
 * until someone noticed.
 * @param surface - `compaction` or `vector`.
 * @param patch - complete override set for that surface; an empty object clears it.
 */
function writeOverlay(surface, patch) {
  const file = overlayPath();
  const current = readOverlay();
  if (Object.keys(patch).length === 0) delete current[surface];
  else current[surface] = patch;
  const tmp = file + ".tmp";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Register a row that can absorb a live patch.
 *
 * `keys` is what that row actually resolves — the tool row and the command row
 * share the `vector` surface but do not own the same key set, so the surface alone
 * cannot say who should receive a patch.
 * @param name - row identity used in errors.
 * @param surface - which overlay slice this row's keys are persisted under.
 * @param keys - zero-argument function returning the keys this row accepts.
 * @param apply - `(patch, options) => (commit | undefined)`.
 * @param describe - `() => object`, the row's current effective hot values.
 * @returns a disposer that unregisters the row.
 */
export function registerLiveConsumer(name, surface, keys, apply, describe) {
  const token = Symbol(name);
  consumers.set(token, { name, surface, keys, apply, describe });
  return () => consumers.delete(token);
}

/**
 * Current effective value of every hot key, as the live rows see it.
 * @returns `{ key: value }` for keys some registered row reports.
 */
export function describeLive() {
  const out = {};
  for (const consumer of consumers.values()) {
    let snapshot;
    try {
      snapshot = consumer.describe();
    } catch {
      continue;
    }
    // Only keys this row CLAIMS count: two rows share the vector surface but not
    // the same key set, and a row that does not own `rank` must not overwrite the
    // value the row that does own it reported.
    let owned;
    try { owned = consumer.keys(); } catch { owned = null; }
    for (const [key, value] of Object.entries(snapshot ?? {})) {
      const entry = BY_KEY.get(key);
      if (entry === undefined) continue;
      if (entry.surface !== consumer.surface) continue;
      if (owned !== null && owned !== undefined) {
        const claims = owned instanceof Set ? owned.has(key) : Array.isArray(owned) && owned.includes(key);
        if (!claims) continue;
      }
      out[key] = value;
    }
    // A vector row reports the RESOLVED record, whose field names are not the
    // config key names. Map them so the form shows what the row is really using.
    if (consumer.surface === "vector") {
      for (const [raw, resolvedName] of Object.entries(RESOLVED_NAMES)) {
        const value = snapshot?.[resolvedName];
        if (value !== undefined) out[raw] = value;
      }
    }
  }
  return out;
}

/** The form's own description of the whitelist, so the client never restates it. */
export function describeKeys() {
  return HOT_KEYS.map((entry) => ({
    key: entry.key,
    surface: entry.surface,
    type: entry.type,
    min: entry.min ?? null,
    exclusiveMax: entry.exclusiveMax ?? null,
    // Carried to the form so the warning sits beside the field it applies to. A key
    // without one is a pure decision that the next use re-reads.
    risk: entry.risk ?? null
  }));
}

/** Every key some registered row accepts, with the rows that accept it. */
function ownersOf(key) {
  const entry = BY_KEY.get(key);
  if (entry === undefined) return [];
  const owners = [];
  for (const consumer of consumers.values()) {
    if (consumer.surface !== entry.surface) continue;
    let owned;
    try {
      owned = consumer.keys();
    } catch {
      continue;
    }
    const ok = owned === undefined || owned === null
      ? true
      : owned instanceof Set ? owned.has(key) : Array.isArray(owned) && owned.includes(key);
    if (ok) owners.push(consumer);
  }
  return owners;
}

/**
 * Apply one panel patch to every row that owns a key in it.
 *
 * Validation happens in the owning row's own resolver, not here: that resolver is
 * the single source of what a legal value is, and restating its rules in this
 * module is how the two drift apart.
 *
 * Two-phase: every touched row dry-runs first and returns a commit closure, and
 * only when all of them accepted is the overlay written and the commits fired. A
 * rejected value therefore changes nothing, instead of leaving the process
 * half-updated with the file holding a value no row accepted.
 * @param patch - `{ key: value }` from the panel.
 * @returns `{ values }` — the effective values after the change.
 * @throws Error carrying the row's own message when a value is refused.
 */
export function applyLive(patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("lcm live config: the patch must be an object");
  }
  const staged = new Map();
  const accepted = {};
  for (const [key, value] of Object.entries(patch)) {
    const entry = BY_KEY.get(key);
    if (entry === undefined) throw new Error(`lcm live config: "${key}" is not a live-tunable key`);
    const owners = ownersOf(key);
    if (owners.length === 0) throw new Error(`lcm live config: no loaded row owns "${key}"`);
    for (const owner of owners) {
      if (!staged.has(owner)) staged.set(owner, {});
      staged.get(owner)[key] = value;
    }
    (accepted[entry.surface] ??= {})[key] = value;
  }
  const prepared = [...staged.entries()].map(([consumer, rowPatch]) => ({
    consumer,
    commit: consumer.apply(rowPatch, { dryRun: true })
  }));
  for (const { consumer, commit } of prepared) {
    if (typeof commit !== "function") throw new Error(`lcm live config: row "${consumer.name}" refused to stage a patch`);
  }
  // Persist first: a failed write must leave the running rows on their old values,
  // otherwise the process is patched to something no restart would reproduce.
  for (const [surface, slice] of Object.entries(accepted)) {
    writeOverlay(surface, { ...overlayFor(surface), ...slice });
  }
  for (const { commit } of prepared) commit();
  return { values: describeLive() };
}
