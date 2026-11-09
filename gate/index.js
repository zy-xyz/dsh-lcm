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
 * The inject latch is what makes the COMMON case deterministic, but it is not
 * the whole story: cordis.patch.yml can only latch the ids it names, and a
 * profile composes further presets from other bundles. Measured on the live web
 * profile, six preset entries exist — the four latched ones plus
 * 'preset-router-spec' / 'preset-router-standard' from
 * @dsh-external/dsh-router-*, which --dump-config shows nesting
 * 'id: compaction-basic' with NO inject on the row
 * (node_modules/@dsh-external/dsh-router-standard/cordis.patch.yml:81). The
 * middleware is global and WOULD rewrite them, but an entry that resolves its
 * config BEFORE the middleware registers is never revisited — measured against
 * real cordis+loader, a preset mounted ahead of the gate with no inject keeps
 * basic 15/15. Hence the runtime SWEEP: once mounted, walk the loader for preset
 * entries whose resolved config still names basic and force them to re-resolve
 * now that the middleware is live.
 *
 * Why matching on `name` and not on `id`: the walk is STRUCTURAL. Any entry
 * whose resolved config nests a compaction group is covered — shipped presets
 * need no restatement, upstream preset updates keep working, and a profile
 * that renames rows still resolves to the same package.
 *
 * Degradation is per-layer and fail-safe, never a brick:
 *   - no `ctx.on` (host predates the internal/config hook) → nothing is rewritten
 *     and every preset boots with stock basic compaction;
 *   - no `ctx.reflect.provide` → the presets never latch on this service and boot
 *     exactly as they did before this bundle was mounted;
 *   - no reachable loader / no `entry.update` → the sweep does nothing and the
 *     profile keeps the pre-sweep composition (the latch and the middleware
 *     still handle every entry that resolves after this gate).
 *
 * @module dsh-lcm/gate
 */
import z from "@deepseek-ai/schemastery";

/** The stock engine this gate evicts from every preset compaction group. */
const DSH_COMPACTION_BASIC_PACKAGE = "@deepseek-ai/dsh-compaction-basic";

/** Id the replacement row carries. Same id the host-plane bundle row uses, so
 *  the two planes read as one engine — and the id that must never appear twice
 *  in one group: the loader keys a group's entries by id with `store[id] ??=`,
 *  so a duplicate silently discards one of the two configs. */
const LCM_COMPACTION_ROW_ID = "compaction-lcm";

/** Package that implements that row. */
const LCM_COMPACTION_ROW_NAME = "dsh-lcm";

/** The row that takes the basic row's place. */
const LCM_COMPACTION_ROW = Object.freeze({ id: LCM_COMPACTION_ROW_ID, name: LCM_COMPACTION_ROW_NAME });

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
 *   names whose resolved config the gate rewrote (middleware or sweep), with
 *   the count of basic rows replaced there (max across resolutions of the same
 *   entry).
 * @property {boolean} sawFactoryPreset true once a covered entry is the
 *   factory @deepseek-ai/dsh-agent-preset package.
 */

const DSH_AGENT_PRESET_PACKAGE = "@deepseek-ai/dsh-agent-preset";

/** Sweep budget. Each round first waits for the Loader to settle and then looks
 *  for stalled presets, so a handful of rounds covers both "the preset resolved
 *  after this gate" and "the restart I just requested is still landing". */
const SWEEP_ROUNDS = 6;
const SWEEP_ROUND_DELAY_MS = 25;

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
 * Coverage record of the load-time gate in this process. null means the
 * transform has not rewritten any entry yet — either no preset mounted a
 * compaction group, or the host predates the internal/config hook.
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

/**
 * The Loader entry behind a waterfall fiber or an Entry, named for telemetry.
 *
 * Measured in a real internal/config waterfall: cordis dispatches with
 * Reflect.apply(callback, thisArg, [fiber, next]) where thisArg comes from the
 * first dispatch argument, and Fiber.resolveConfig passes only the event name —
 * so the listener's 'this' is null and this.entry never exists. The fiber (the
 * FIRST ARGUMENT) is the only carrier of the entry, and its options.name is the
 * package name, which is also what makes sawFactoryPreset observable at all.
 * The sweep holds an Entry instead of a fiber, so both shapes are accepted:
 * fiber.entry.options and entry.options name the same Loader row.
 * @param {unknown} target a waterfall fiber or a Loader entry.
 * @returns {string} an entry name, an entry id, or "unnamed-entry".
 */
function entryNameOf(target) {
  const options = target?.entry?.options ?? target?.options ?? {};
  if (typeof options.name === "string") return options.name;
  if (typeof options.id === "string") return options.id;
  return "unnamed-entry";
}

/** A Loader group row: it carries its children in config, not a name. */
function isGroupRow(row) {
  return row !== null && typeof row === "object" && row.group === true && Array.isArray(row.config);
}

/** Any non-group row: the only shape the gate rewrites. */
function isLeafRow(row) {
  return row !== null && typeof row === "object" && !isGroupRow(row);
}

function isBasicRow(row) {
  return isLeafRow(row) && row.name === DSH_COMPACTION_BASIC_PACKAGE;
}

function isLcmRow(row) {
  return isLeafRow(row) && row.id === LCM_COMPACTION_ROW_ID;
}

/**
 * Turn one basic row into the LCM row, KEEPING what belongs to it.
 *
 * Measured before this rule: replacing with a bare { ...LCM_COMPACTION_ROW }
 * dropped a preset's "config: {thresholdRatio: 0.7, retainTokens: 5000}" (bare
 * row came back) and inverted an operator's `disabled: true` into an ENABLED
 * engine. Both are wrong for this engine specifically: dsh-lcm's key surface is
 * a strict superset of basic's, every shared key keeps its meaning and its
 * default (`src/config.js`), so carrying config over is exactly what a migrating
 * configuration expects. disabled carries because a stand-down is an operator
 * statement about this group, not about basic's implementation.
 *
 * Everything else on the basic row is DROPPED on purpose: `inject`/`isolate` there
 * describe when and in which realm BASIC activates, and inheriting them would
 * change when LCM takes the slot.
 * @param {Record<string, unknown>} row the basic row.
 * @returns {Record<string, unknown>} the replacement row.
 */
function migrateRow(row) {
  const migrated = { id: LCM_COMPACTION_ROW_ID, name: LCM_COMPACTION_ROW_NAME };
  if (row.config !== undefined) migrated.config = row.config;
  if (row.disabled !== undefined) migrated.disabled = row.disabled;
  return migrated;
}

/**
 * Fold a migrated basic row into an LCM row the group already carries.
 *
 * Merge rule, precisely: the EXISTING LCM row wins every key it states, because
 * it is the explicit statement about this engine, while a config key only the
 * basic row names is carried over (same key, same meaning — a tuned
 * retainTokens must not vanish because a profile also wrote an lcm row).
 * disabled is inherited only when the existing row does not state it: an
 * explicit stand-down must not be silently undone, and an explicit
 * "disabled: false" on the lcm row must not be overridden.
 * @param {Record<string, unknown>} existing the lcm row already in the group.
 * @param {Record<string, unknown>} basic the basic row being retired.
 * @returns {Record<string, unknown>} one merged lcm row.
 */
function mergeRow(existing, basic) {
  const merged = { ...existing, id: LCM_COMPACTION_ROW_ID, name: LCM_COMPACTION_ROW_NAME };
  if (basic.config !== undefined) merged.config = { ...basic.config, ...existing.config };
  if (merged.disabled === undefined && basic.disabled !== undefined) merged.disabled = basic.disabled;
  return merged;
}

/**
 * Rewrite one compaction group's own child list.
 *
 * Replace by ID, never by appending: a group that already carries
 * compaction-lcm gets that row merged (see `mergeRow`) and the basic row removed,
 * because the loader keys a group's entries by id (`store[id] ??=`) and would
 * silently discard one of two same-id configs. Further basic rows in the same
 * list collapse into the one migrated row, for the same reason.
 * @param {readonly unknown[]} rows the group's children.
 * @returns {{ rows: readonly unknown[], replaced: number }} the SAME array when
 *   nothing matched.
 */
function rewriteGroupChildren(rows) {
  const basicIndexes = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (isBasicRow(rows[index])) basicIndexes.push(index);
  }
  if (basicIndexes.length === 0) return { rows, replaced: 0 };
  const basics = new Set(basicIndexes);
  const first = rows[basicIndexes[0]];
  const targetIndex = rows.findIndex((row, index) => !basics.has(index) && isLcmRow(row));
  const out = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (basics.has(index)) {
      // Merge into the existing row, or migrate the FIRST basic row in place
      // and drop any duplicate behind it.
      if (targetIndex < 0 && index === basicIndexes[0]) out.push(migrateRow(rows[index]));
      continue;
    }
    out.push(index === targetIndex ? mergeRow(rows[index], first) : rows[index]);
  }
  return { rows: out, replaced: basicIndexes.length };
}

/**
 * Rewrite one row list. `insideGroup` is the whole rule: only rows nested in a
 * group are eligible, so a host-plane `compaction-basic` row (which the bundle
 * patch handles with `disabled: true`) is never touched here.
 * @returns {{ rows: readonly unknown[], replaced: number }} the SAME array when
 *   nothing changed, so callers can keep object identity.
 */
function rewriteRows(rows, insideGroup) {
  let replaced = 0;
  let changed = false;
  const expanded = rows.map((row) => {
    if (!isGroupRow(row)) return row;
    const child = rewriteRows(row.config, true);
    if (child.replaced === 0) return row;
    replaced += child.replaced;
    changed = true;
    return { ...row, config: child.rows };
  });
  if (insideGroup) {
    const swapped = rewriteGroupChildren(expanded);
    if (swapped.replaced > 0) return { rows: swapped.rows, replaced: replaced + swapped.replaced };
  }
  return { rows: changed ? expanded : rows, replaced };
}

/**
 * Replace every nested @deepseek-ai/dsh-compaction-basic row with the LCM row,
 * leaving the rest of each compaction group (command-compact,
 * tool-result-pruner and their config) exactly as shipped.
 *
 * Pure: returns detached copies along the changed paths and never mutates the
 * input rows — a resolved config may be shared with other consumers. Returns
 * the SAME array instance when nothing matched.
 *
 * @param {readonly unknown[]} rows a resolved plugins tree.
 * @returns {readonly unknown[]}
 */
export function rewriteCompactionRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rewriteRows(rows, false).rows;
}

/**
 * Preset entries that resolved their config before the middleware was live and
 * therefore still bind the stock engine.
 *
 * Detection reads the entry's RESOLVED config (`fiber.effectiveConfig`), not the
 * raw options: an entry the middleware already rewrote is healthy even though
 * its authored config.plugins still names basic, and re-resolving it would
 * restart a preset for nothing.
 * @param {any} loader the host Loader service.
 * @returns {Array<{ entry: any, config: any, plugins: readonly unknown[], replaced: number }>}
 */
function stalledPresetEntries(loader) {
  const stalled = [];
  for (const entry of loader?.entries?.() ?? []) {
    if (entry?.options?.name !== DSH_AGENT_PRESET_PACKAGE) continue;
    const effective = entry.fiber?.effectiveConfig;
    // Not resolved yet: its own activation runs the live middleware.
    if (!Array.isArray(effective?.plugins)) continue;
    if (rewriteRows(effective.plugins, false).replaced === 0) continue;
    const config = entry.options.config;
    const { rows, replaced } = rewriteRows(config?.plugins ?? [], false);
    if (replaced === 0) continue;
    stalled.push({ entry, config, plugins: rows, replaced });
  }
  return stalled;
}

/**
 * Force every stalled preset entry to re-resolve, now that the middleware is
 * live, so the rows it mounts are the ones the gate installs.
 *
 * The API: `entry.update(options, create, force)` from cordis-plugin-loader. A
 * forced update that carries a CHANGED config is the only variant that reaches
 * the waterfall — measured against real cordis+loader:
 *   - `entry.update({}, false, true)` re-resolves NOTHING (an empty diff skips
 *     fiber.update, so the preset keeps basic and never re-registers);
 *   - a deep-equal config copy is not a change either (`deepEqual` on config);
 *   - a config whose compaction group differs takes the loader's
 *     _patchContext(["config"]) branch, which calls
 *     `fiber.update(this.options.config, true)` → the global `internal/config`
 *     middleware runs again → the entry restarts and re-registers with the LCM
 *     rows (measured: engines basic then lcm, preset registry entry kept, no
 *     duplicate-preset error).
 * Because this engine's config is a superset of basic's, every carried key
 * means the same thing, so the only real difference is the engine row itself.
 *
 * Absent `update`, or a host without a reachable loader, leaves the entry as it
 * was: degradation, not a crash.
 * @param {any} ctx the plugin context.
 */
async function sweepStalledPresets(ctx) {
  for (let round = 0; round < SWEEP_ROUNDS; round += 1) {
    const loader = ctx?.reflect?.get?.("loader", false);
    if (loader === undefined) return; // host without a Loader service: nothing to sweep
    // Settle BEFORE looking: this entry and the presets it protects are created
    // in the same concurrent batch, so at the moment apply() runs a preset may
    // still have no resolved config at all — an immediate scan would see
    // "nothing stalled" and stop. Waiting is what makes the sweep see the
    // post-settlement tree.
    if (typeof loader.await === "function") await loader.await();
    else if (round > 0) await new Promise((resolve) => setTimeout(resolve, SWEEP_ROUND_DELAY_MS));
    const stalled = stalledPresetEntries(loader);
    if (stalled.length === 0) return;
    for (const { entry, config, plugins, replaced } of stalled) {
      if (typeof entry.update !== "function") continue;
      await entry.update({ config: { ...config, plugins } }, false, true);
      const entryName = entryNameOf(entry);
      noteGateCoverage(entryName.slice(0, 120), replaced, entryName === DSH_AGENT_PRESET_PACKAGE);
    }
  }
}

/**
 * Test hook: run the sweep to completion instead of the fire-and-forget task
 * apply() starts, so a test can assert the post-sweep composition.
 * @param {any} ctx the plugin context.
 * @returns {Promise<void>}
 */
export function _sweepStalledPresetsForTest(ctx) {
  return sweepStalledPresets(ctx);
}

/**
 * @typedef {object} CompactionGateHost
 * @property {(event: string, listener: (fiber: unknown, next: () => unknown) => unknown, options?: { global?: boolean }) => void} [on]
 * @property {{ provide?: (name: string, value: unknown) => void, get?: (name: string, strict?: boolean) => unknown }} [reflect]
 * @property {{ warn?: (...args: unknown[]) => void }} [logger]
 */

/**
 * Register the load-time transform and publish the gate service. The provide
 * happens AFTER the middleware registers, so the inject latch can never be
 * satisfied before the transform is live.
 * @param {CompactionGateHost} ctx the plugin context.
 */
export function registerCompactionGate(ctx) {
  if (typeof ctx.on === "function") {
    ctx.on("internal/config", function (fiber, next) {
      const resolved = next();
      const config = resolved ?? {};
      // Match STRUCTURALLY: any entry whose config nests a compaction group.
      // Unrelated entries keep their resolved config object identity.
      if (!Array.isArray(config.plugins)) return resolved;
      const { rows, replaced } = rewriteRows(config.plugins, false);
      if (replaced === 0) return resolved;
      const entryName = entryNameOf(fiber);
      noteGateCoverage(entryName.slice(0, 120), replaced, entryName === DSH_AGENT_PRESET_PACKAGE);
      return { ...config, plugins: rows };
    }, { global: true });
  }
  // Publish only after the middleware is registered; the host owns both lifetimes.
  ctx.reflect?.provide?.(LCM_COMPACTION_POLICY_SERVICE, Object.freeze({ owner: "dsh-lcm", takes: DSH_COMPACTION_BASIC_PACKAGE }));
}

/**
 * The gate consumes no configuration, and says so on the surface the other rows
 * use. An empty object schema lets `Config.listConfigs` render "takes no options"
 * instead of no schema at all, and makes `simplify` — the whitelist a config is
 * written back through on an `internal/commit` — drop a stray key instead of
 * persisting one nobody reads.
 *
 * It deliberately does NOT reject a stray key at activation: schemastery's object
 * resolver re-merges undeclared keys (strict = false), and a gate that failed to
 * activate would never publish `lcmCompactionPolicy`, leaving every gated preset
 * unregistered and the profile silently back on stock basic compaction. A key
 * nobody reads is cheaper than that brick.
 */
const Config = z.object({});

export const name = "lcm-compaction-gate";
export const inject = [];
export { Config };

/**
 * @param {CompactionGateHost} ctx the plugin context.
 */
export function apply(ctx) {
  registerCompactionGate(ctx);
  // Safety net for presets that outran the latch: a preset mounted ahead of this
  // gate never sees the middleware, so walk the loader once it settles and
  // re-resolve those entries. Fire-and-forget: this runs after the entry tree
  // settles, and a rejected background task must never take the profile down.
  sweepStalledPresets(ctx).catch((error) => {
    ctx?.logger?.warn?.("dsh-lcm gate: preset sweep skipped", error);
  });
}
