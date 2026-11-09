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

test("a stable 0.2.x release is still inside every dsh peer range", { skip: skipSemver }, () => {
  // The widened range must not become a prerelease-only pin: 0.2.5 is the shape
  // of the next stable release and has to stay installable.
  const pkg = JSON.parse(readPackageJson());
  const broken = Object.entries(pkg.peerDependencies)
    .filter(([, range]) => range.startsWith("^0.2."))
    .filter(([, range]) => !semver.satisfies("0.2.5", range))
    .map(([name, range]) => `${name} ${range}`);
  assert.deepEqual(broken, []);
});

/** Read one package.json from this package or its installed peers. */
function readPackageJson(name) {
  const url = name === undefined
    ? new URL("../package.json", import.meta.url)
    : new URL(`../node_modules/${name}/package.json`, import.meta.url);
  return readFileSync(url, "utf8");
}
