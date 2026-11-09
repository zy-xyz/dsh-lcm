/**
 * The original backend's tool and command names must survive.
 *
 * `dsh-compaction-instant` shipped `recall`, `search` and `/recall`. Anything
 * already written against those names — agent instructions, saved prompts,
 * muscle memory — has to keep working after switching backends, so this package
 * registers both the LCM names and the originals.
 */
import assert from "node:assert/strict";
import test from "node:test";

import * as tool from "../src/tool.js";
import * as command from "../src/command.js";
import { HYBRID_RANK_MODES, RANK_MODES } from "../src/search.js";
import { resolveVectorConfig } from "../src/vectors.js";

/** Minimal ctx that records what got registered. */
function recorder() {
  const tools = [];
  const commands = [];
  return {
    tools,
    commands,
    ctx: {
      effect: (fn) => {
        const dispose = fn();
        return typeof dispose === "function" ? dispose : () => {};
      },
      tools: { register: (definition) => { tools.push(definition.name); return () => {}; } },
      commands: { register: (definition) => { commands.push(definition.name); return () => {}; } }
    }
  };
}

test("tools register both the LCM names and the original ones", () => {
  const { ctx, tools } = recorder();
  tool.apply(ctx, {});
  assert.deepEqual(tools.sort(), ["lcm_expand", "lcm_search", "recall", "search"]);
});

test("legacyNames: false drops the original names", () => {
  const { ctx, tools } = recorder();
  tool.apply(ctx, { legacyNames: false });
  assert.deepEqual(tools.sort(), ["lcm_expand", "lcm_search"]);
});

test("commands register both /lcm-search and /recall", () => {
  const { ctx, commands } = recorder();
  command.apply(ctx, {});
  // /lcm-status joined the surface for G6.1: an operator needs to see what the
  // engine holds after a compaction, and it is a command rather than a tool so it
  // costs no model attention on ordinary requests.
  assert.deepEqual(commands.sort(), ["lcm-search", "lcm-status", "recall"]);
});

test("legacyNames: false drops the original command name", () => {
  const { ctx, commands } = recorder();
  command.apply(ctx, { legacyNames: false });
  assert.deepEqual(commands, ["lcm-search", "lcm-status"]);
});

test("/lcm-search stays lexical and refuses a vector rank instead of ignoring it", () => {
  // The operator's grep: answered inline at a prompt, so it does not pay the
  // semantic arm's cost (~90 ms per candidate text, src/vectors.js). A vector
  // rank here used to be accepted and silently ignored; now it is an error.
  assert.equal(command.resolveConfig({}).rank, "density");
  assert.throws(() => command.resolveConfig({ rank: "hybrid" }), /lexical/);
  assert.throws(() => command.resolveConfig({ rank: "vector" }), /lexical/);
  for (const rank of ["seq", "score", "density"]) assert.equal(command.resolveConfig({ rank }).rank, rank);
});

test("a tool definition can be built under either name", () => {
  const resolved = tool.resolveConfig({});
  assert.equal(tool.defineRecallTool(resolved).name, "lcm_expand");
  assert.equal(tool.defineRecallTool(resolved, "recall").name, "recall");
  assert.equal(tool.defineSearchTool(resolved).name, "lcm_search");
  assert.equal(tool.defineSearchTool(resolved, "search").name, "search");
});

// ── the composition schema ─────────────────────────────────────────────────
//
// The Loader validates a row's `config` through `Config["~standard"].validate`
// BEFORE it restarts the plugin (cordis `resolveConfig`, called from
// `fiber.update`). Both rows used to export no `Config`, so that check was
// skipped: a bad value only reached the plugin's own `resolveConfig` inside
// `apply`, i.e. after the old instance was disposed and after
// `ctx.tools.register` had already run. Measured with the real Loader on
// `maxSearchHits: -3`: the registrations were undone, the fiber landed in
// state 3 (failed), and the live tool list was empty. With a schema the same
// edit throws before the restart, so the old instance keeps serving.
//
// The key lists below are written ONCE and the per-key assertions iterate the
// schema, so a key that one layer knows and the other does not fails here.

/** The keys both rows read. Declared once; every other list is derived from it. */
const LEXICAL_KEYS = ["legacyNames", "maxRecallTokens", "maxSearchHits", "rank"];

/**
 * The `vector*` keys the tool row spreads from `resolveVectorConfig`, derived
 * from that resolver's own output rather than from a second hand-written list:
 * a new vector key fails this suite until the schema learns it, which is the
 * point of the derivation.
 */
const VECTOR_KEYS = Object.keys(resolveVectorConfig({})).map((key) => "vector" + key[0].toUpperCase() + key.slice(1));

/**
 * Values the schema's own rules must reject, derived from the node itself:
 * every numeric key here is an `integer >= 1`, every string key a non-empty
 * string, and `rank` a closed union of modes.
 */
/**
 * Keys whose empty string is a DOCUMENTED legal value, not a defect.
 *
 * `vectorApiKeyEnv` carries the NAME of an environment variable, and "" is its
 * default meaning "send no Authorization header" — the shape every keyless
 * backend (a local LM Studio) expects. Treating "" as a bad value here would
 * assert the opposite of the contract. Every other string key still refuses it.
 */
const EMPTY_STRING_IS_VALID = new Set(["vectorApiKeyEnv"]);

function badValuesFor(node, key) {
  const floor = node.meta.min ?? 1;
  switch (node.type) {
    case "boolean": return [1, "true"];
    case "number": return [floor - 1, floor + 0.5, "5"];
    case "string": return EMPTY_STRING_IS_VALID.has(key) ? [42] : [42, ""];
    case "union": return ["nonsense"];
    default: throw new Error("unhandled schema node type " + node.type);
  }
}

/** A value the schema's own rules must accept, derived the same way. */
function goodValueFor(node) {
  const floor = node.meta.min ?? 1;
  switch (node.type) {
    case "boolean": return true;
    case "number": return floor + 1;
    case "string": return "compat-probe";
    case "union": return node.list[0].value;
    default: throw new Error("unhandled schema node type " + node.type);
  }
}

test("both rows export a Config schema, which is what makes the Loader validate an edit", () => {
  for (const [label, plugin] of [["tool", tool], ["command", command]]) {
    assert.equal(typeof plugin.Config["~standard"].validate, "function", label + " must expose a schemastery Config");
  }
});

test("the tool row declares exactly the keys its resolveConfig consumes", () => {
  assert.deepEqual(Object.keys(tool.Config.dict).sort(), [...LEXICAL_KEYS, ...VECTOR_KEYS].sort());
});

test("the command row declares every key its resolveConfig reads, both command families", () => {
  // This row mounts TWO families now: `commandSet: "search"` (the historical
  // /lcm-search + /lcm-status + recall names) and `commandSet: "embed"`
  // (/lcm-embed). /lcm-embed reads the vector block, so those keys are declared
  // rather than merely tolerated.
  //
  // Declaring them is not cosmetic: schemastery's `validate` keeps an unknown
  // key but `simplify` — whose output a fiber.update re-route writes back —
  // drops it. An undeclared `commandSet` therefore survives until the operator
  // changes a setting, then reverts the embed row to the default `search`
  // family, which re-registers /lcm-search on a row where the search row
  // already owns the name and the command registry aborts.
  assert.deepEqual(
    Object.keys(command.Config.dict).sort(),
    [...LEXICAL_KEYS, "commandSet", ...VECTOR_KEYS].sort()
  );
  // The measured difference between the two schemastery entry points, which is
  // why an undeclared key is a silent time bomb rather than a hard failure.
  const probe = { rank: "density", commandSet: "embed", vectorEnabled: true };
  assert.equal(command.Config(probe).commandSet, "embed", "validate keeps it");
  assert.equal("commandSet" in command.Config.simplify(probe), true, "and simplify keeps it too, now that it is declared");
});

test("rank's enum matches the modes each row accepts, vector ranks included only where they route", () => {
  assert.deepEqual(tool.Config.dict.rank.list.map((node) => node.value), [...RANK_MODES, ...HYBRID_RANK_MODES]);
  assert.deepEqual(command.Config.dict.rank.list.map((node) => node.value), [...RANK_MODES]);
  // The schema half of "/lcm-search is lexical": the two values its resolveConfig
  // refuses must die at composition, not inside apply.
  assert.throws(() => command.Config({ rank: "hybrid" }), /hybrid/);
  assert.throws(() => command.Config({ rank: "vector" }));
  assert.doesNotThrow(() => tool.Config({ rank: "hybrid" }));
  assert.doesNotThrow(() => tool.Config({ rank: "vector" }));
});

test("every tool-row value outside the schema's floor or type is rejected by BOTH layers", () => {
  for (const [key, node] of Object.entries(tool.Config.dict)) {
    for (const bad of badValuesFor(node, key)) {
      const label = key + "=" + JSON.stringify(bad);
      assert.throws(() => tool.Config({ [key]: bad }), undefined, "the composition schema must refuse " + label);
      assert.throws(() => tool.resolveConfig({ [key]: bad }), undefined, "the runtime validator must refuse the same " + label);
    }
  }
});

test("every command-row value outside the schema's floor or type is rejected by BOTH layers", () => {
  for (const [key, node] of Object.entries(command.Config.dict)) {
    for (const bad of badValuesFor(node, key)) {
      const label = key + "=" + JSON.stringify(bad);
      assert.throws(() => command.Config({ [key]: bad }), undefined, "the composition schema must refuse " + label);
      assert.throws(() => command.resolveConfig({ [key]: bad }), undefined, "the runtime validator must refuse the same " + label);
    }
  }
});

test("every declared key is accepted by both layers and survives the write-back", () => {
  for (const [label, plugin] of [["tool", tool], ["command", command]]) {
    const full = Object.fromEntries(Object.entries(plugin.Config.dict).map(([key, node]) => [key, goodValueFor(node)]));
    assert.doesNotThrow(() => plugin.Config(full), label + " schema must accept its own valid values");
    assert.doesNotThrow(() => plugin.resolveConfig(full), label + " resolveConfig must accept the same values");
    // No `.default()` anywhere: a default makes simplify() omit a value equal to
    // it, and simplify's output is what a fiber.update re-route writes back — the
    // same trap src/index.js:276-286 documents for the engine row.
    assert.deepEqual(plugin.Config.simplify(full), full, label + " must not lose a key on write-back");
  }
});

test("an undeclared key is dropped on write-back instead of being persisted forever", () => {
  // The second half of the defect: with no schema, simplify never ran, so a
  // mistyped key survived every settings change and was read by nobody.
  assert.deepEqual(tool.Config.simplify({ legacyNames: false, bogusKey: 42 }), { legacyNames: false });
  assert.deepEqual(command.Config.simplify({ rank: "density", bogusKey: 42 }), { rank: "density" });
});

