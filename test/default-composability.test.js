// ── a key whose default must survive its own schema ────────────────────────
// 0.22.1 shipped an engine that never loaded: `fullSweepSoftSeconds` defaulted to
// 0, the composition schema declared `min(1)`, and cordis refused the config at
// composition time. `compaction-lcm` was absent for a whole session while every
// offline test passed — because two tests asserted 0 was INVALID and no test
// asserted the shipped default was valid.
import assert from "node:assert/strict";
import test from "node:test";

import LcmCompactionEngine from "../src/index.js";
import { CONFIG_KEYS, resolveConfig } from "../src/config.js";

test("every shipped default is accepted by BOTH configuration layers", () => {
  // The general guard, not a fix for one key: whatever `resolveConfig({})`
  // produces has to pass the same resolvers a session goes through at composition
  // time, or the plugin cannot load.
  const resolved = resolveConfig({});
  const full = {};
  for (const key of CONFIG_KEYS) full[key] = resolved[key];

  assert.doesNotThrow(
    () => LcmCompactionEngine.Config(full),
    "the composition schema must accept the defaults ./config.js ships"
  );
  assert.doesNotThrow(
    () => resolveConfig(full),
    "and the runtime resolver must accept them too"
  );
});

test("fullSweepSoftSeconds accepts 0, which is what disables the soft stop", () => {
  // The exact value that took the engine down. 0 is not an edge case — it is the
  // default, and the engine branch is `fullSweepSoftSeconds > 0` to disable.
  assert.equal(resolveConfig({ fullSweepSoftSeconds: 0 }).fullSweepSoftSeconds, 0);
  assert.equal(LcmCompactionEngine.Config({ fullSweepSoftSeconds: 0 }).fullSweepSoftSeconds, 0);
});

test("a negative soft target is still refused by both layers", () => {
  assert.throws(() => resolveConfig({ fullSweepSoftSeconds: -1 }), /fullSweepSoftSeconds/u);
  assert.throws(() => LcmCompactionEngine.Config({ fullSweepSoftSeconds: -1 }));
});
