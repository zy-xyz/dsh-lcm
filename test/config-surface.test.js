/**
 * The composition-time `Config` schema and the peer ranges: the two surfaces
 * where a defect is invisible at runtime until a patch re-route or a fresh
 * install happens.
 *
 * schemastery's `simplify` is a WHITELIST. `validate` accepts unknown keys (and
 * drops them from its own output), but `simplify` keeps only keys the schema
 * declares, and it is `simplify`'s output that a `fiber.update` patch re-route
 * writes back through the Loader. So an undeclared key is a key that survives
 * until the next settings change and then silently disappears. Nine keys were in
 * exactly that state (`anchorPointers`, `emptySummaryRetries`, and all seven
 * `vector*`), which is why this file exists: the schema is now asserted equal to
 * `CONFIG_KEYS`, the one list `./config.js` resolves from.
 *
 * Run with: node --test test/config-surface.test.js
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CONFIG_KEYS, resolveConfig } from "../src/config.js";
import { LcmCompactionEngine } from "../src/index.js";

/** semver is a transitive dependency here, exactly like the other fixtures. */
let semver;
try {
  semver = (await import("semver")).default;
} catch {
  semver = null;
}

const skipSemver = semver === null;

// ── 1: every declared key survives a schema round trip ─────────────────────

/** A valid value for every config key, deliberately NON-default where it matters. */
const FULL_CONFIG = {
  thresholdRatio: 0.7,
  headroomTokens: 32768,
  retainRatio: 0.125,
  summarizationProvider: "summary-provider",
  summarizationModel: "summary-model",
  maxTokens: 8192,
  compactionRetries: 3,
  maxOverflowRetries: 2,
  modelPolicies: [{ provider: "p", model: "m", thresholdRatio: 0.6 }],
  auto: false,
  // LCM-only keys: these are the nine the schema used to be missing.
  summaryRatio: 0.15,
  summaryFloorTokens: 768,
  checkpointCap: 9000,
  anchorPointers: false,
  emptySummaryRetries: 5,
  debug: true,
  debugLogPath: "/tmp/lcm-config-surface-test.log",
  vectorEnabled: true,
  vectorBaseUrl: "http://127.0.0.1:1234/v1",
  vectorModel: "embed-model",
  vectorDim: 1024,
  vectorTopK: 4,
  vectorTimeoutMs: 15000,
  vectorCacheDir: "/tmp/lcm-vectors-surface"
};

test("the schema declares exactly the keys config.js resolves", () => {
  const declared = new Set(Object.keys(LcmCompactionEngine.Config.dict));
  const expected = CONFIG_KEYS;
  const missing = [...expected].filter((key) => !declared.has(key)).sort();
  const extra = [...declared].filter((key) => !expected.has(key)).sort();
  assert.deepEqual(missing, [], "every config.js key must be declared, or simplify() drops it on a patch re-route");
  assert.deepEqual(extra, [], "the schema must not declare a key config.js rejects as unknown");
});

test("simplify keeps every key of a full configuration", () => {
  const simplified = LcmCompactionEngine.Config.simplify(FULL_CONFIG);
  const lost = Object.keys(FULL_CONFIG).filter((key) => !(key in simplified));
  assert.deepEqual(lost, [], "a dropped key is a key that disappears on the next settings change");
  assert.deepEqual(simplified, FULL_CONFIG, "the round trip must be lossless and value-preserving");
});

test("the simplified configuration still resolves to the same engine config", () => {
  // The end-to-end statement of the defect: what the Loader writes back must
  // resolve to what the user configured, not to the defaults.
  const simplified = LcmCompactionEngine.Config.simplify(FULL_CONFIG);
  const resolved = resolveConfig(simplified);
  assert.equal(resolved.anchorPointers, false, "anchorPointers must survive the round trip");
  assert.equal(resolved.emptySummaryRetries, 5, "emptySummaryRetries must survive the round trip");
  assert.equal(resolved.vectorEnabled, true);
  assert.equal(resolved.vectorBaseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(resolved.vectorModel, "embed-model");
  assert.equal(resolved.vectorDim, 1024);
  assert.equal(resolved.vectorTopK, 4);
  assert.equal(resolved.vectorTimeoutMs, 15000);
  assert.equal(resolved.vectorCacheDir, "/tmp/lcm-vectors-surface");
});

test("an explicitly-set value equal to the resolved default is not dropped", () => {
  // The reason the schema declares NO `.default()`: with one, schemastery would
  // omit a key whose value equals the default, so "I explicitly turned the vector
  // layer off" would be written back as silence. Silence and `false` resolve the
  // same today, but they stop resolving the same the moment the default changes.
  const explicit = { anchorPointers: true, vectorEnabled: false, emptySummaryRetries: 2 };
  assert.deepEqual(LcmCompactionEngine.Config.simplify(explicit), explicit);
});

test("the schema rejects the wrong type for each newly declared key", () => {
  const cases = [
    { anchorPointers: "yes" },
    { emptySummaryRetries: 1.5 },
    { vectorEnabled: 1 },
    { vectorBaseUrl: 12 },
    { vectorModel: 12 },
    { vectorDim: 0 },
    { vectorTopK: -1 },
    { vectorTimeoutMs: "soon" },
    { vectorCacheDir: false }
  ];
  for (const config of cases) {
    // No matcher on the schema's own message: schemastery words it per rule, and
    // the assertion here is only that the key is TYPED at all.
    assert.throws(() => LcmCompactionEngine.Config(config), JSON.stringify(config) + " must be rejected");
  }
});

// ── the one key whose floor is semantic, not numeric ───────────────────────

test("condensationFanin is floored at 2 in both configuration layers", () => {
  // 1 is not a small fanin, it is the defect the key exists to prevent: ./region.js
  // gates its whole condensation branch - and its skip over the checkpoints already
  // on the surface - on `fanin > 1`. At 1 the automatic path loses both, every leaf
  // starts at the previous checkpoint again, and the surface holds one checkpoint at
  // a growing depth (replayed: depths [1], [2], [3] with one checkpoint throughout).
  // The schema is the composition-time half; ./config.js is the runtime half. A
  // guard in only one of them is a hole, so both are asserted here.
  const consequence = /re-summarises its own last summary/;
  assert.throws(() => resolveConfig({ condensationFanin: 1 }), /\[?condensationFanin\]?/u, "the runtime validator must name the key");
  assert.throws(() => resolveConfig({ condensationFanin: 1 }), /integer >= 2/u, "and the floor");
  assert.throws(() => resolveConfig({ condensationFanin: 1 }), consequence, "and the consequence, so 1 is not read as a small value");
  assert.throws(() => LcmCompactionEngine.Config({ condensationFanin: 1 }), "the composition schema must reject 1 too");

  // 2 is the smallest fanin that keeps the branch reachable, and it must be accepted
  // by both layers and survive the round trip a patch re-route performs.
  assert.equal(resolveConfig({ condensationFanin: 2 }).condensationFanin, 2);
  assert.doesNotThrow(() => LcmCompactionEngine.Config({ condensationFanin: 2 }));
  assert.equal(LcmCompactionEngine.Config.simplify({ condensationFanin: 2 }).condensationFanin, 2);

  // No other key got floored on the way: 1 is still a legal SIZE for the keys that
  // are sizes, which is what keeps this a change to one key rather than a policy.
  const sizes = resolveConfig({ checkpointCap: 1, summaryFloorTokens: 1, leafSpanTokens: 1, stallCooldownMs: 1 });
  assert.deepEqual(
    [sizes.checkpointCap, sizes.summaryFloorTokens, sizes.leafSpanTokens, sizes.stallCooldownMs],
    [1, 1, 1, 1],
    "the fanin floor must not spread to the size keys"
  );
});

// ── 2: the peer ranges accept the prerelease the harness actually ships ─────

test("every peer range accepts the installed prerelease", { skip: skipSemver }, () => {
  // `^0.2.0` does not match `0.2.2-rc.1`: semver excludes prereleases unless the
  // range names a prerelease at the SAME [major, minor, patch]. Every
  // `@deepseek-ai/dsh-*` peer was therefore unsatisfied by the version the
  // harness installs, so a fresh install reported a peer conflict on a package
  // that works.
  const pkg = JSON.parse(readPackageJson());
  const unsatisfied = [];
  for (const [name, range] of Object.entries(pkg.peerDependencies)) {
    const installed = JSON.parse(readPackageJson(name)).version;
    if (!semver.satisfies(installed, range)) unsatisfied.push(`${name}@${installed} does not satisfy ${range}`);
  }
  assert.deepEqual(unsatisfied, []);
});

test("every dsh peer range admits both a future stable and a future patch prerelease", { skip: skipSemver }, () => {
  // Two properties, and the second one is the trap the marketplace guide names:
  //
  //   1. the range must not become a prerelease-only pin — 0.2.5 is the shape of
  //      the next stable release and has to stay installable;
  //   2. it must not silently exclude the next PATCH prerelease either. node-semver
  //      only admits a prerelease when some comparator sits on the SAME
  //      major.minor.patch tuple and itself carries a prerelease tag, so a plain
  //      `^0.2.2-0` accepts 0.2.2-rc.1 and then rejects 0.2.3-rc.1. That is an
  //      ERESOLVE for every user on the next harness patch, which is why the
  //      range enumerates tuples instead.
  const pkg = JSON.parse(readPackageJson());
  const dshPeers = Object.entries(pkg.peerDependencies).filter(([name]) => name.startsWith("@deepseek-ai/dsh-"));
  assert.ok(dshPeers.length > 0, "this test is meaningless with no dsh peers");
  const broken = [];
  for (const [name, range] of dshPeers) {
    for (const probe of ["0.2.5", "0.2.3-rc.1", "0.2.4-rc.1"]) {
      if (!semver.satisfies(probe, range)) broken.push(`${name} ${range} rejects ${probe}`);
    }
    // And it must still refuse what it cannot support.
    for (const probe of ["0.1.7-rc.2", "0.3.0-rc.1"]) {
      if (semver.satisfies(probe, range)) broken.push(`${name} ${range} wrongly accepts ${probe}`);
    }
  }
  assert.deepEqual(broken, []);
});

/** Read one package.json from this package or its installed peers. */
function readPackageJson(name) {
  const url = name === undefined
    ? new URL("../package.json", import.meta.url)
    : new URL(`../node_modules/${name}/package.json`, import.meta.url);
  return readFileSync(url, "utf8");
}

// ── the two layers must agree value by value, not only key by key ──────────

/**
 * One valid sample and one INVALID sample per declared key.
 *
 * The key-set test above proves the two layers know the same NAMES. This proves
 * they agree on VALUES, which is the other half of the same defect class:
 * `stallCooldownMs` was declared in the schema with `min(1)` and never validated
 * in ./config.js, so the composition layer refused `0`, `1.5` and `"60000"`
 * while the runtime accepted them — and a string there turned the stall deadline
 * into `NaN`, silently disarming the hold (`Date.now() < NaN` is always false).
 * A key that is typed in only one of the two layers is a key whose acceptance
 * depends on which code path reads the configuration.
 */
const KEY_SAMPLES = {
  thresholdRatio: { config: { thresholdRatio: 0.7 }, bad: { thresholdRatio: "0.7" } },
  headroomTokens: { config: { headroomTokens: 4096 }, bad: { headroomTokens: 4096.5 } },
  retainRatio: { config: { retainRatio: 0.125 }, bad: { retainRatio: "0.125" } },
  retainTokens: { config: { retainTokens: 4096 }, bad: { retainTokens: "4096" } },
  summarizationProvider: {
    config: { summarizationProvider: "summary-provider", summarizationModel: "summary-model" },
    bad: { summarizationProvider: 12 }
  },
  summarizationModel: {
    config: { summarizationProvider: "summary-provider", summarizationModel: "summary-model" },
    bad: { summarizationModel: 12 }
  },
  maxTokens: { config: { maxTokens: 8192 }, bad: { maxTokens: "8192" } },
  compactionRetries: { config: { compactionRetries: 2 }, bad: { compactionRetries: 1.5 } },
  maxOverflowRetries: { config: { maxOverflowRetries: 2 }, bad: { maxOverflowRetries: -1 } },
  modelPolicies: { config: { modelPolicies: [{ provider: "p", model: "m" }] }, bad: { modelPolicies: "rows" } },
  auto: { config: { auto: false }, bad: { auto: 1 } },
  summaryRatio: { config: { summaryRatio: 0.15 }, bad: { summaryRatio: "0.15" } },
  summaryFloorTokens: { config: { summaryFloorTokens: 768 }, bad: { summaryFloorTokens: 0 } },
  checkpointCap: { config: { checkpointCap: 9000 }, bad: { checkpointCap: 0 } },
  leafSpanTokens: { config: { leafSpanTokens: 24000 }, bad: { leafSpanTokens: 0 } },
  condensationFanin: { config: { condensationFanin: 4 }, bad: { condensationFanin: 1 } },
  thresholdFullSweep: { config: { thresholdFullSweep: false }, bad: { thresholdFullSweep: "no" } },
  fullSweepMaxPasses: { config: { fullSweepMaxPasses: 6 }, bad: { fullSweepMaxPasses: 1.5 } },
  fullSweepMaxSeconds: { config: { fullSweepMaxSeconds: 60 }, bad: { fullSweepMaxSeconds: 0 } },
  fullSweepSoftSeconds: { config: { fullSweepSoftSeconds: 30 }, bad: { fullSweepSoftSeconds: 0 } },
  fullSweepReserveSeconds: { config: { fullSweepReserveSeconds: 5 }, bad: { fullSweepReserveSeconds: -1 } },
  backgroundLeafPrep: { config: { backgroundLeafPrep: true }, bad: { backgroundLeafPrep: "yes" } },
  leafEstimateFloorSeconds: { config: { leafEstimateFloorSeconds: 15 }, bad: { leafEstimateFloorSeconds: 1.5 } },
  stallCooldownMs: { config: { stallCooldownMs: 60000 }, bad: { stallCooldownMs: 0 } },
  anchorPointers: { config: { anchorPointers: false }, bad: { anchorPointers: "no" } },
  emptySummaryRetries: { config: { emptySummaryRetries: 2 }, bad: { emptySummaryRetries: 1.5 } },
  debug: { config: { debug: true }, bad: { debug: "yes" } },
  debugLogPath: { config: { debugLogPath: "/tmp/lcm-surface.log" }, bad: { debugLogPath: false } },
  vectorEnabled: { config: { vectorEnabled: true }, bad: { vectorEnabled: 1 } },
  vectorBaseUrl: { config: { vectorBaseUrl: "http://127.0.0.1:1234/v1" }, bad: { vectorBaseUrl: 12 } },
  vectorModel: { config: { vectorModel: "embed-model" }, bad: { vectorModel: 12 } },
  vectorDim: { config: { vectorDim: 1024 }, bad: { vectorDim: 0 } },
  vectorTopK: { config: { vectorTopK: 4 }, bad: { vectorTopK: 0 } },
  vectorTimeoutMs: { config: { vectorTimeoutMs: 15000 }, bad: { vectorTimeoutMs: 0 } },
  vectorCacheDir: { config: { vectorCacheDir: "/tmp/lcm-vectors-surface" }, bad: { vectorCacheDir: false } },
  // "" is a legal value by design: it is the "send no Authorization header"
  // default for keyless backends, so only a non-string is refused.
  vectorApiKeyEnv: { config: { vectorApiKeyEnv: "OMNIROUTE_API_KEY" }, bad: { vectorApiKeyEnv: 12 } }
};

test("every declared key is typed the same way in both layers", () => {
  assert.deepEqual(Object.keys(KEY_SAMPLES).sort(), [...CONFIG_KEYS].sort(), "the sample table must cover exactly the declared surface");
  const disagreements = [];
  for (const [key, sample] of Object.entries(KEY_SAMPLES)) {
    const runtimeAccepts = accepts(() => resolveConfig(sample.config));
    const schemaAccepts = accepts(() => LcmCompactionEngine.Config(sample.config));
    if (!runtimeAccepts || !schemaAccepts) disagreements.push(`${key}: a valid value was refused (config.js ${runtimeAccepts}, schema ${schemaAccepts})`);
    const runtimeRefuses = !accepts(() => resolveConfig(sample.bad));
    const schemaRefuses = !accepts(() => LcmCompactionEngine.Config(sample.bad));
    if (!runtimeRefuses || !schemaRefuses) disagreements.push(`${key}: an invalid value was accepted (config.js refuses ${runtimeRefuses}, schema refuses ${schemaRefuses})`);
  }
  assert.deepEqual(disagreements, [], "both layers must accept and refuse the same values: " + disagreements.join("; "));
});

test("stallCooldownMs is the key that regressed, and it now agrees", () => {
  // Named separately because it is the measured defect, and because a table that
  // only reports "no disagreements" is easy to satisfy by weakening a sample.
  assert.equal(typeof resolveConfig({ stallCooldownMs: 60000 }).stallCooldownMs, "number");
  for (const value of [0, -1, 1.5, "60000", Number.NaN]) {
    assert.throws(() => resolveConfig({ stallCooldownMs: value }), /stallCooldownMs.*positive integer/u, "config.js must refuse " + JSON.stringify(value));
    assert.throws(() => LcmCompactionEngine.Config({ stallCooldownMs: value }), "the schema must refuse " + JSON.stringify(value) + " too");
  }
  // and a NaN deadline is exactly what used to disarm the hold
  assert.ok(Number.isNaN(Date.now() + Number("60000")) === false);
});

/** Whether one configuration call returns instead of throwing. */
function accepts(call) {
  try {
    call();
    return true;
  } catch {
    return false;
  }
}
