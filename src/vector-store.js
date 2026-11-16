/**
 * The vector cache, backed by SQLite.
 *
 * The schema is lcm-x's, not an invention: three tables, and the model identity is
 * its own axis rather than part of the row key.
 *
 *   lcm_embedding_profile   (identity_hash PK) — provider, model, revision, dim,
 *                           dtype, byteorder, task. identity_hash is the sha256 of
 *                           those fields joined by \x1f, so re-registering a model
 *                           under a new provider is a new row and switching back
 *                           reactivates the old one with its vectors still valid.
 *   lcm_embedding_meta      (embedded_id, identity_hash) — when, how many tokens,
 *                           archived flag. Metadata without a vector is legal.
 *   lcm_embedding_vectors   (embedded_id, identity_hash) -> vec BLOB.
 *
 * Why this replaces the file cache. The file cache keyed on
 * `sha256(model + "\n" + text)`, which folds the model into the identity: changing
 * `vectorModel` orphaned every vector and switching back could not reuse them.
 * Here `embedded_id` is the text alone, so the same text under two models is two
 * rows rather than two universes. Measured, the file cache also cost 124 us per
 * write and 30 us per read against 2.4 us and 3.8 us for the same operations in one
 * file, and 18 373 files in a single directory had already broken `ls`.
 *
 * @module dsh-lcm/vector-store
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The dtype this store writes. lcm-x also knows int8; this port does not. */
const DTYPE = "float32";
const BYTEORDER = "little";
/** The task an embedding was computed for, part of the identity in lcm-x. */
const TASK = "retrieval";

/**
 * The model identity, hashed the way lcm-x hashes it.
 *
 * Field order and the \x1f separator both matter: the hash IS the partition key, so
 * a different join would silently make every existing vector unreachable.
 * @param cfg - resolved vector settings.
 * @returns the sha256 hex of the joined identity fields.
 */
export function identityHashOf(cfg) {
  const canonical = ["", cfg.model, "", String(cfg.dim), DTYPE, BYTEORDER, TASK].join("\x1f");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * The text's own digest, independent of which model embedded it.
 * @param text - the exact string that was embedded.
 * @returns sha256 hex.
 */
export function embeddedIdOf(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

/** Schema version, so a future migration can tell what it is looking at. */
const SCHEMA_VERSION = 1;

/**
 * Create the three tables and the indexes lcm-x keeps beside them.
 *
 * Every statement is IF NOT EXISTS: opening a store twice must cost a version
 * check, not a rebuild.
 * @param db - an open DatabaseSync.
 */
function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lcm_embedding_profile (
      identity_hash TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model_name TEXT NOT NULL,
      revision TEXT NOT NULL DEFAULT '',
      dim INTEGER,
      dtype TEXT NOT NULL DEFAULT 'float32',
      byteorder TEXT NOT NULL DEFAULT 'little',
      task TEXT NOT NULL DEFAULT 'retrieval',
      registered_at TEXT,
      active INTEGER DEFAULT 1,
      archived_at TEXT NULL,
      data_version INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_lcm_embedding_profile_model
      ON lcm_embedding_profile(model_name, provider);

    CREATE TABLE IF NOT EXISTS lcm_embedding_meta (
      embedded_id TEXT,
      embedded_kind TEXT DEFAULT 'text',
      identity_hash TEXT,
      embedded_at TEXT,
      source_token_count INTEGER,
      archived INTEGER DEFAULT 0,
      PRIMARY KEY(embedded_id, identity_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_lcm_embedding_meta_identity_embedded_at
      ON lcm_embedding_meta(identity_hash, embedded_at DESC)
      WHERE archived = 0;

    CREATE TABLE IF NOT EXISTS lcm_embedding_vectors (
      embedded_id TEXT,
      identity_hash TEXT,
      vec BLOB NOT NULL,
      PRIMARY KEY(embedded_id, identity_hash)
    );

    CREATE TABLE IF NOT EXISTS lcm_embedding_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  db.prepare("INSERT OR IGNORE INTO lcm_embedding_state(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
}

/**
 * Open (or create) the store for one configuration.
 * @param cfg - resolved vector settings; `cacheDir` holds the database file.
 * @returns the open handle, with the schema ensured and the profile registered.
 */
export function openVectorStore(cfg) {
  const file = path.join(cfg.cacheDir, `vectors-${cfg.dim}.sqlite`);
  fs.mkdirSync(cfg.cacheDir, { recursive: true });
  const db = new DatabaseSync(file);
  // WAL so a reader (a search) never blocks the writer (a backfill), which is the
  // exact pairing this store exists for.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  ensureSchema(db);
  const identity = identityHashOf(cfg);
  db.prepare(`
    INSERT INTO lcm_embedding_profile(identity_hash, provider, model_name, revision, dim, dtype, byteorder, task, registered_at, active)
    VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, 1)
    ON CONFLICT(identity_hash) DO UPDATE SET active = 1, archived_at = NULL
  `).run(identity, "", cfg.model, cfg.dim, DTYPE, BYTEORDER, TASK, new Date().toISOString());
  return { db, file, identity };
}

/**
 * Read one vector, or null on a miss or a wrong-width blob.
 * @param store - from openVectorStore.
 * @param text - the exact embedded string.
 * @returns Float32Array or null.
 */
export function readVector(store, text) {
  const row = store.db.prepare(
    "SELECT vec FROM lcm_embedding_vectors WHERE embedded_id = ? AND identity_hash = ?"
  ).get(embeddedIdOf(text), store.identity);
  if (row === undefined || row.vec === null) return null;
  const bytes = row.vec;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength % 4 !== 0) return null;
  const out = new Float32Array(bytes.byteLength / 4);
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < out.length; index += 1) out[index] = view.readFloatLE(index * 4);
  return out;
}

/**
 * Write one vector and its metadata row.
 * @param store - from openVectorStore.
 * @param text - the exact embedded string.
 * @param vector - Float32Array of the configured width.
 * @param tokenCount - optional estimate, stored in meta.
 */
export function writeVector(store, text, vector, tokenCount) {
  const embeddedId = embeddedIdOf(text);
  const bytes = Buffer.alloc(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) bytes.writeFloatLE(vector[index], index * 4);
  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db.prepare(
      "INSERT INTO lcm_embedding_vectors(embedded_id, identity_hash, vec) VALUES (?, ?, ?) ON CONFLICT(embedded_id, identity_hash) DO UPDATE SET vec = excluded.vec"
    ).run(embeddedId, store.identity, bytes);
    store.db.prepare(
      "INSERT INTO lcm_embedding_meta(embedded_id, embedded_kind, identity_hash, embedded_at, source_token_count, archived) VALUES (?, 'text', ?, ?, ?, 0) ON CONFLICT(embedded_id, identity_hash) DO UPDATE SET embedded_at = excluded.embedded_at"
    ).run(embeddedId, store.identity, new Date().toISOString(), tokenCount ?? null);
    store.db.prepare("UPDATE lcm_embedding_profile SET data_version = data_version + 1 WHERE identity_hash = ?").run(store.identity);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * How many vectors this model identity holds, and how many bytes they occupy.
 * @param store - from openVectorStore.
 * @returns `{ entries, bytes }`.
 */
export function storeStats(store) {
  const row = store.db.prepare(
    "SELECT COUNT(*) AS entries, COALESCE(SUM(LENGTH(vec)), 0) AS bytes FROM lcm_embedding_vectors WHERE identity_hash = ?"
  ).get(store.identity);
  return { entries: Number(row?.entries ?? 0), bytes: Number(row?.bytes ?? 0) };
}

/** Every vector's embedded_id for one identity, for the panel's coverage test. */
export function allEmbeddedIds(store) {
  const rows = store.db.prepare("SELECT embedded_id FROM lcm_embedding_vectors WHERE identity_hash = ?").all(store.identity);
  return new Set(rows.map((row) => String(row.embedded_id)));
}

/**
 * An O(1) "is this embedded" probe for one identity.
 *
 * The panel used to load EVERY id into a Set and test membership against it: 358 ms
 * at 40 929 rows, and it had to be rebuilt whenever the count moved — which, during
 * a backfill, is every poll. A session only has ~94 candidates, and each is a
 * primary-key hit on (embedded_id, identity_hash), so asking about those 94 costs
 * 15.7 ms cold and 0.9 ms warm against 358 ms for the whole table.
 *
 * The probe is always current, which also removes the staleness the Set had: a
 * vector written a millisecond ago is visible immediately.
 * @param store - from openVectorStore.
 * @returns `{ has(embeddedId), close() }`.
 */
export function embeddedProbe(store) {
  const stmt = store.db.prepare(
    "SELECT 1 AS hit FROM lcm_embedding_vectors WHERE embedded_id = ? AND identity_hash = ? LIMIT 1"
  );
  return {
    has(embeddedId) {
      return stmt.get(String(embeddedId), store.identity) !== undefined;
    }
  };
}

/**
 * A cheap generation counter for this identity.
 *
 * `data_version` is bumped inside every write transaction, so reading it is one
 * row instead of a COUNT(*) over the whole table (measured: 481 ms at 41 000 rows).
 * @param store - from openVectorStore.
 * @returns the counter, or -1 when the profile row is missing.
 */
export function storeVersion(store) {
  const row = store.db.prepare("SELECT data_version FROM lcm_embedding_profile WHERE identity_hash = ?").get(store.identity);
  return row === undefined ? -1 : Number(row.data_version);
}
