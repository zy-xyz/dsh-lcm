// ── the shipped patch is part of the contract ──────────────────────────────
// The audit found this layer completely unguarded: reverting `fullSweepSoftSeconds`
// to 60 in cordis.patch.yml — the exact bug commit fb933f4 fixed — left all 328
// tests green, and so did adding a key the schema would refuse. Both failures are
// SILENT at runtime (the row simply never loads), which is why they need a test.
//
// The patch is parsed with a small reader instead of a YAML library: `js-yaml` is
// not a declared dependency of this package, and a test that only works because a
// transitive install happens to hoist one is not a guarantee. The reader covers the
// one shape this file uses and fails loudly if that shape changes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import LcmCompactionEngine from "../src/index.js";
import { CONFIG_KEYS, resolveConfig } from "../src/config.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PATCH = path.join(ROOT, "cordis.patch.yml");

/**
 * Flatten one `- id: <id>` row into dotted scalar paths.
 *
 * `config:` then `        fullSweepSoftSeconds: 0` becomes
 * `config.fullSweepSoftSeconds -> "0"`. Indentation is the whole grammar this
 * needs: a deeper line belongs to the entry above it, an equal one starts a
 * sibling, a shallower one closes the block. Values stay raw text so the caller
 * decides how to compare them, which is what lets these assertions talk about the
 * patch and the defaults in the same terms.
 *
 * A full YAML library would be wrong here twice over: `js-yaml` is not a declared
 * dependency, and the two rows these tests care about have no YAML features beyond
 * nesting and comments.
 * @param source - the patch file contents.
 * @param id - the Loader row id.
 * @returns `Map<dottedPath, rawValue>`, or null when the row is absent.
 */
function rowScalars(source, id) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => new RegExp("^\\s*-\\s+id:\\s*" + id + "\\s*$", "u").test(line));
  if (start < 0) return null;

  const values = new Map();
  // Stack of { indent, prefix } for the blocks currently open.
  const stack = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    const match = /^(\s+)([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (match === null) {
      // A new list item at or before the row's own indent ends it.
      const bullet = /^(\s*)-\s/u.exec(line);
      if (bullet !== null && bullet[1].length <= 4) break;
      continue;
    }
    const ownIndent = match[1].length;
    if (ownIndent <= 4) break;
    while (stack.length > 0 && stack[stack.length - 1].indent >= ownIndent) stack.pop();
    const prefix = stack.map((entry) => entry.prefix).join("");
    const key = prefix + match[2];
    const value = match[3].trim();
    if (value.length === 0) {
      stack.push({ indent: ownIndent, prefix: key + "." });
      continue;
    }
    values.set(key, value);
  }
  return values;
}

const source = fs.readFileSync(PATCH, "utf8");

test("the engine row exists and pins only keys the schema knows", () => {
  const row = rowScalars(source, "compaction-lcm");
  assert.notEqual(row, null, "cordis.patch.yml must still insert the compaction-lcm row");
  const pinned = [...row.keys()]
    .filter((key) => key.startsWith("config."))
    .map((key) => key.slice("config.".length));
  assert.ok(pinned.length >= 5, "the engine row must still pin its sweep clocks");
  const unknown = pinned.filter((key) => !CONFIG_KEYS.has(key));
  // A key the schema does not know is not a warning: cordis refuses the whole row,
  // the engine never loads, and nothing else in the suite notices.
  assert.deepEqual(unknown, [], "every key the patch pins must exist in ./src/config.js");
});

test("every value the patch pins is accepted by BOTH configuration layers", () => {
  const row = rowScalars(source, "compaction-lcm");
  assert.notEqual(row, null);
  const sample = {};
  for (const [key, raw] of row) {
    if (!key.startsWith("config.")) continue;
    const value = Number(raw);
    sample[key.slice("config.".length)] = Number.isNaN(value) ? raw.replace(/^['"]|['"]$/gu, "") : value;
  }
  assert.doesNotThrow(() => resolveConfig(sample), "the runtime resolver must accept the shipped values");
  assert.doesNotThrow(() => LcmCompactionEngine.Config(sample), "and so must the composition schema");
});

test("the pinned sweep clocks are the ones this release documents", () => {
  // The regression this exists for: fb933f4 left `fullSweepSoftSeconds: 60` here
  // while src/config.js shipped 0, so the default never applied and a 72.9 s leaf
  // ended every sweep after one leaf. Reverting that line must fail.
  const row = rowScalars(source, "compaction-lcm");
  assert.notEqual(row, null);
  const defaults = resolveConfig({});
  const pinned = {
    fullSweepMaxSeconds: Number(row.get("config.fullSweepMaxSeconds")),
    fullSweepSoftSeconds: Number(row.get("config.fullSweepSoftSeconds")),
    fullSweepTargetShare: Number(row.get("config.fullSweepTargetShare")),
    fullSweepReserveSeconds: Number(row.get("config.fullSweepReserveSeconds")),
    leafEstimateFloorSeconds: Number(row.get("config.leafEstimateFloorSeconds"))
  };
  for (const [key, value] of Object.entries(pinned)) {
    assert.equal(value, defaults[key],
      `${key} is pinned to ${value} in the patch but ${defaults[key]} is the shipped default; an explicit patch value wins and the default becomes dead code`);
  }
  // And the pair must still be coherent: the target has to fit the budget.
  const threshold = Math.floor(Math.min(1000000 * defaults.thresholdRatio, 1000000 - defaults.maxTokens - defaults.headroomTokens));
  const target = Math.floor(threshold * pinned.fullSweepTargetShare);
  const leaves = Math.floor((pinned.fullSweepMaxSeconds - pinned.fullSweepReserveSeconds) / 32.3);
  assert.ok(target <= leaves * 21479,
    `the ${target}-token target must fit in the ${leaves} leaves a ${pinned.fullSweepMaxSeconds} s budget admits`);
  assert.equal(pinned.fullSweepSoftSeconds, 0,
    "a soft target shorter than one leaf ends a sweep instead of bounding it; 0 disables it");
});

test("the tool row carries the rank the semantic layer needs", () => {
  const row = rowScalars(source, "tool-lcm-expand");
  assert.notEqual(row, null, "the tool row must be inserted too");
  assert.equal(row.get("config.rank"), "hybrid", "a lexical rank makes the whole vector block inert");
  assert.equal(row.get("config.vectorEnabled"), "true");
});

test("every row the bundle inserts names a package this profile can resolve", () => {
  const ids = [...source.matchAll(/^\s*-\s+id:\s*([A-Za-z0-9-]+)\s*$/gmu)].map((match) => match[1]);
  assert.ok(ids.includes("compaction-lcm"), "the engine row is present");
  assert.ok(ids.includes("lcm-compaction-gate"), "the gate row is present");
  // The gate provides the service the preset rows inject; without it, any preset
  // that latches on `lcmCompactionPolicy` never registers.
  assert.match(source, /inject: \[lcmCompactionPolicy\]/u,
    "the preset rows must still latch on the gate service");
});
