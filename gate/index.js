/**
 * dsh-lcm compaction gate: take the compaction slot inside agent-preset
 * sessions at LOAD TIME.
 *
 * The problem it solves: a profile that mounts @deepseek-ai/dsh-web-app runs
 * its compaction engine INSIDE an agent preset, behind
 * `isolate: {compaction: true}`. Those rows live in the preset's own resolved
 * config, so no bundle-patch layer can address them by Loader row id — the
 * host-plane `compaction-basic` row is a different realm. The documented way
 * to reach them is this gate, the same mechanism billion-context uses
 * (vendored reference: ref/billion-context/dsh-compaction-disable.ts, MIT
 * (c) 2026 deshark42):
 *
 *   1. the bundle patch makes each preset row `inject: [lcmCompactionPolicy]`,
 *      so a preset cannot register until that service exists;
 *   2. this entry (always on, no dependencies of its own) registers a GLOBAL
 *      middleware on `internal/config` and only then provides the service, so
 *      the transform is live before any gated preset resolves its config;
 *   3. the middleware receives each resolved plugin config and rewrites the
 *      compaction group it nests.
 *
 * Ours does more than the reference: billion-context only DISABLES basic
 * because its engine is not a dsh compaction plugin. dsh-lcm IS one, so it
 * takes the slot — the basic row becomes the LCM row, and the rest of the
 * group (`command-compact`, `tool-result-pruner` and its config) is untouched.
 *
 * Why matching on `name` and not on `id`: the walk is STRUCTURAL. Any entry
 * whose resolved config nests a compaction group is covered — shipped presets
 * need no restatement, upstream preset updates keep working, and a profile
 * that renames rows still resolves to the same package.
 *
 * Degradation is per-layer and fail-safe, never a brick:
 *   - no `ctx.on` (host predates the internal/config hook) → nothing is
 *     rewritten and every preset boots with stock basic compaction;
 *   - no `ctx.reflect.provide` → the presets never latch on this service and
 *     boot exactly as they did before this bundle was mounted.
 *
 * @module dsh-lcm/gate
 */

/** The stock engine this gate evicts from every preset compaction group. */
const DSH_COMPACTION_BASIC_PACKAGE = "@deepseek-ai/dsh-compaction-basic";

/** The row that takes its place. Same id the host-plane bundle row uses, so
 *  the two planes read as one engine. */
const LCM_COMPACTION_ROW = Object.freeze({ id: "compaction-lcm", name: "dsh-lcm" });

/** Gate service the four Web preset rows inject (cordis.patch.yml). A preset
 *  cannot register until this is provided, so the middleware below is
 *  guaranteed live before any protected preset resolves its config. */
const LCM_COMPACTION_POLICY_SERVICE = "lcmCompactionPolicy";

/** Process-global rewrite record. The gate entry and any operator-facing
 *  reader are separate module instances in the host, and globalThis is the
 *  only surface they share. */
const DSH_LCM_GATE_TELEMETRY_KEY = "__DSH_LCM_COMPACTION_GATE_TELEMETRY__";

/**
 * @typedef {object} DshLcmGateTelemetry
 * @property {Array<{ entry: string, rows: number }>} covered entry option
 *   names whose resolved config the gate rewrote, with the count of basic rows
 *   replaced there (max across resolutions of the same entry).
 * @property {boolean} sawFactoryPreset true once a covered entry is the
 *   factory @deepseek-ai/dsh-agent-preset package.
 */

const DSH_AGENT_PRESET_PACKAGE = "@deepseek-ai/dsh-agent-preset";

function noteGateCoverage(entryName, rows, isFactory) {
  const store = globalThis;
  const current = store[DSH_LCM_GATE_TELEMETRY_KEY];
  const telemetry = current ?? { covered: [], sawFactoryPreset: false };
  const existing = telemetry.covered.find((c) => c.entry === entryName);
  if (existing === undefined) {
    telemetry.covered = [...telemetry.covered, { entry: entryName, rows }];
  } else if (rows > existing.rows) {
    existing.rows = rows;
  }
  if (isFactory) telemetry.sawFactoryPreset = true;
  store[DSH_LCM_GATE_TELEMETRY_KEY] = telemetry;
}

/**
 * Coverage record of the load-time gate in this process. `null` means the
 * transform has not rewritten any entry yet — either no preset mounted a
 * compaction group, or the host predates the `internal/config` hook.
 * @returns {DshLcmGateTelemetry | null}
 */
export function dshLcmCompactionGateTelemetry() {
  const record = globalThis[DSH_LCM_GATE_TELEMETRY_KEY];
  return record === undefined ? null : record;
}

/** Test hook: forget any recorded coverage. */
export function _resetDshLcmCompactionGateTelemetryForTest() {
  delete globalThis[DSH_LCM_GATE_TELEMETRY_KEY];
}

/** A Loader group row: it carries its children in `config`, not a name. */
function isGroupRow(row) {
  return row !== null && typeof row === "object" && row.group === true && Array.isArray(row.config);
}

/**
 * Rewrite one row list. `insideGroup` is the whole rule: only rows nested in a
 * group are eligible, so a host-plane `compaction-basic` row (which the bundle
 * patch handles with `auto: false`) is never touched here.
 * @returns {{ rows: readonly unknown[], replaced: number }} the SAME array when
 *   nothing changed, so callers can keep object identity.
 */
function rewriteRows(rows, insideGroup) {
  let replaced = 0;
  let changed = false;
  const out = rows.map((row) => {
    if (row === null || typeof row !== "object") return row;
    if (isGroupRow(row)) {
      const child = rewriteRows(row.config, true);
      if (child.replaced === 0) return row;
      replaced += child.replaced;
      changed = true;
      return { ...row, config: child.rows };
    }
    if (insideGroup && row.name === DSH_COMPACTION_BASIC_PACKAGE) {
      replaced += 1;
      changed = true;
      return { ...LCM_COMPACTION_ROW };
    }
    return row;
  });
  return { rows: changed ? out : rows, replaced };
}

/**
 * Replace every nested `@deepseek-ai/dsh-compaction-basic` row with the LCM
 * row, leaving the rest of each compaction group (`command-compact`,
 * `tool-result-pruner` and their config) exactly as shipped.
 *
 * Pure: returns detached copies along the changed paths and never mutates the
 * input rows — a resolved config may be shared with other consumers. Returns
 * the SAME array instance when nothing matched.
 *
 * @param {readonly unknown[]} rows a resolved `plugins` tree.
 * @returns {readonly unknown[]}
 */
export function rewriteCompactionRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rewriteRows(rows, false).rows;
}

/**
 * @typedef {object} CompactionGateHost
 * @property {(event: string, listener: (raw: unknown, next: () => unknown) => unknown, options?: { global?: boolean }) => void} [on]
 * @property {{ provide?: (name: string, value: unknown) => void }} [reflect]
 */

/**
 * Register the load-time transform and publish the gate service. The provide
 * happens AFTER the middleware registers, so the inject latch can never be
 * satisfied before the transform is live.
 * @param {CompactionGateHost} ctx the plugin context.
 */
export function registerCompactionGate(ctx) {
  if (typeof ctx.on === "function") {
    ctx.on("internal/config", function (_raw, next) {
      const resolved = next();
      const config = resolved ?? {};
      // Match STRUCTURALLY: any entry whose config nests a compaction group.
      // Unrelated entries keep their resolved config object identity.
      if (!Array.isArray(config.plugins)) return resolved;
      const { rows, replaced } = rewriteRows(config.plugins, false);
      if (replaced === 0) return resolved;
      const rawName = this?.entry?.options?.name;
      const entryName = typeof rawName === "string" ? rawName : "unnamed-entry";
      noteGateCoverage(entryName.slice(0, 120), replaced, entryName === DSH_AGENT_PRESET_PACKAGE);
      return { ...config, plugins: rows };
    }, { global: true });
  }
  // Publish only after the middleware is registered; the host owns both lifetimes.
  ctx.reflect?.provide?.(LCM_COMPACTION_POLICY_SERVICE, Object.freeze({ owner: "dsh-lcm", takes: DSH_COMPACTION_BASIC_PACKAGE }));
}

export const name = "lcm-compaction-gate";
export const inject = [];

/**
 * @param {CompactionGateHost} ctx the plugin context.
 */
export function apply(ctx) {
  registerCompactionGate(ctx);
}
