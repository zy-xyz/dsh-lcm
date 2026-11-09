/**
 * The load-time gate: take the compaction slot inside agent-preset sessions.
 *
 * The mechanism (proven by the vendored billion-context reference, see
 * ref/billion-context/dsh-compaction-disable.ts): a preset row patched with
 * 'inject: [<service>]' waits for that service; the gate entry provides it and,
 * before providing, registers a global 'internal/config' middleware that
 * rewrites whatever compaction group it finds. Ours replaces the basic engine
 * instead of only disabling it, and matches on 'name' so a profile that renames
 * rows still resolves to dsh-lcm.
 *
 * The latch only covers the ids cordis.patch.yml names. The live web profile
 * also mounts preset-router-spec / preset-router-standard from
 * @dsh-external/dsh-router-*, which carry no inject, so the gate ALSO sweeps the
 * loader once it settles and forces those entries to re-resolve. Both paths are
 * covered below.
 *
 * Run with: node --test test/gate.test.js
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  _resetDshLcmCompactionGateTelemetryForTest,
  _sweepStalledPresetsForTest,
  apply,
  dshLcmCompactionGateTelemetry,
  inject,
  name,
  rewriteCompactionRows
} from "../gate/index.js";

const BASIC = "@deepseek-ai/dsh-compaction-basic";
const PRESET = "@deepseek-ai/dsh-agent-preset";
const LCM_ROW = { id: "compaction-lcm", name: "dsh-lcm" };

/** The shipped preset shape: a plugins tree with one nested compaction group. */
function presetTree() {
  return [
    { id: "persona", name: "@deepseek-ai/dsh-persona" },
    {
      id: "compaction",
      name: "cordis:group",
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: "compaction-basic", name: BASIC, config: { thresholdRatio: 0.8 } },
        { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
        {
          id: "tool-result-pruner",
          name: "@deepseek-ai/dsh-compaction-tool-result-pruner",
          config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
        }
      ]
    },
    { id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash" }
  ];
}

/** A fake host context recording the middleware apply() registers. */
function fakeCtx(loader) {
  const listeners = [];
  const provided = new Map();
  return {
    ctx: {
      on(event, listener, options) {
        listeners.push({ event, listener, options });
      },
      reflect: {
        provide(svc, value) {
          provided.set(svc, value);
        },
        get(svc) {
          return svc === "loader" ? loader : undefined;
        }
      }
    },
    listeners,
    provided
  };
}

/** A fiber as cordis actually passes it: the FIRST argument of the waterfall. */
function fakeFiber(entryName) {
  return { entry: { options: { id: "preset-row", name: entryName } } };
}

/**
 * One Loader entry as the sweep sees it: options carry the authored config,
 * fiber.effectiveConfig carries what the middleware produced at resolve time.
 */
function fakePresetEntry(spec) {
  const calls = [];
  const entry = {
    options: { id: "preset-row", name: spec.entryName ?? PRESET, config: spec.authored },
    fiber: { effectiveConfig: spec.effective },
    calls
  };
  if (spec.withUpdate !== false) {
    entry.update = async (options, create, force) => {
      calls.push({ options, create, force });
      entry.options.config = options.config;
      entry.fiber.effectiveConfig = options.config;
    };
  }
  return entry;
}

function fakeLoader(entries, extra) {
  return { entries: () => entries, ...extra };
}

test("gate entry declares the expected plugin name and no dependencies", () => {
  assert.equal(name, "lcm-compaction-gate");
  assert.deepEqual(inject, []);
});

test("replaces basic with lcm inside a nested compaction group, keeping command-compact", () => {
  const out = rewriteCompactionRows(presetTree());
  const group = out.find((row) => row.id === "compaction");
  // The basic row's tuned config rides along: this engine accepts every basic
  // key with the same meaning, so dropping it would silently retune a preset.
  assert.deepEqual(group.config[0], { ...LCM_ROW, config: { thresholdRatio: 0.8 } });
  // The rest of the group survives untouched, config included.
  assert.deepEqual(group.config[1], { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" });
  assert.deepEqual(group.config[2], {
    id: "tool-result-pruner",
    name: "@deepseek-ai/dsh-compaction-tool-result-pruner",
    config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
  });
  assert.equal(group.config.length, 3);
  // Rows outside the group are untouched.
  assert.deepEqual(out[0], { id: "persona", name: "@deepseek-ai/dsh-persona" });
  assert.deepEqual(out[2], { id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash" });
});

test("matches on name, not on id, so a renamed row still resolves to dsh-lcm", () => {
  const out = rewriteCompactionRows([
    {
      id: "some-group",
      name: "cordis:group",
      group: true,
      config: [{ id: "whatever-the-profile-called-it", name: BASIC }]
    }
  ]);
  assert.deepEqual(out[0].config, [LCM_ROW]);
});

test("a host-plane basic row is never touched - only nested groups are rewritten", () => {
  const rows = [{ id: "compaction-basic", name: BASIC, config: { auto: false } }];
  assert.equal(rewriteCompactionRows(rows), rows);
});

test("a tree with no compaction group comes back as the same array instance", () => {
  const rows = [
    { id: "persona", name: "@deepseek-ai/dsh-persona" },
    { id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash" }
  ];
  assert.equal(rewriteCompactionRows(rows), rows);
});

test("a compaction group nested several groups deep is still reached", () => {
  const rows = [
    {
      id: "outer",
      name: "cordis:group",
      group: true,
      config: [
        {
          id: "inner",
          name: "cordis:group",
          group: true,
          config: [
            { id: "compaction", name: "cordis:group", group: true, config: [{ id: "compaction-basic", name: BASIC }] }
          ]
        }
      ]
    }
  ];
  const out = rewriteCompactionRows(rows);
  assert.deepEqual(out[0].config[0].config[0].config, [LCM_ROW]);
});

test("the rewrite is pure: the input tree is not mutated", () => {
  const rows = presetTree();
  const snapshot = structuredClone(rows);
  rewriteCompactionRows(rows);
  assert.deepEqual(rows, snapshot);
});

// -- defect 2: what the replacement row carries, and never twice -------------

test("the replacement row keeps the basic row's config and disabled flag", () => {
  const out = rewriteCompactionRows([
    {
      id: "compaction",
      name: "cordis:group",
      group: true,
      config: [
        { id: "compaction-basic", name: BASIC, config: { thresholdRatio: 0.7, retainTokens: 5000 }, disabled: true },
        { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" }
      ]
    }
  ]);
  assert.deepEqual(out[0].config, [
    { id: "compaction-lcm", name: "dsh-lcm", config: { thresholdRatio: 0.7, retainTokens: 5000 }, disabled: true },
    { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" }
  ]);
});

test("a basic row with neither config nor disabled still becomes the bare lcm row", () => {
  const out = rewriteCompactionRows([
    { id: "g", name: "cordis:group", group: true, config: [{ id: "compaction-basic", name: BASIC }] }
  ]);
  assert.deepEqual(out[0].config, [LCM_ROW]);
});

test("row-level inject and isolate are not inherited by the replacement row", () => {
  const out = rewriteCompactionRows([
    {
      id: "g",
      name: "cordis:group",
      group: true,
      config: [{ id: "compaction-basic", name: BASIC, inject: ["compaction"], isolate: { compaction: true } }]
    }
  ]);
  assert.deepEqual(out[0].config, [LCM_ROW]);
});

test("a group that already carries compaction-lcm is merged, never given a second row", () => {
  const out = rewriteCompactionRows([
    {
      id: "compaction",
      name: "cordis:group",
      group: true,
      config: [
        { id: "compaction-basic", name: BASIC, config: { thresholdRatio: 0.7, retainTokens: 5000 } },
        { id: "compaction-lcm", name: "dsh-lcm", config: { summaryRatio: 0.2 } },
        { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" }
      ]
    }
  ]);
  const rows = out[0].config;
  assert.equal(rows.filter((row) => row.id === "compaction-lcm").length, 1);
  assert.equal(rows.length, 2);
  // The existing lcm row wins the keys it states; basic-only keys are carried.
  assert.deepEqual(rows[0], {
    id: "compaction-lcm",
    name: "dsh-lcm",
    config: { thresholdRatio: 0.7, retainTokens: 5000, summaryRatio: 0.2 }
  });
  assert.deepEqual(rows[1], { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" });
});

test("an explicit lcm row keeps its own disabled flag over the retired basic row's", () => {
  const out = rewriteCompactionRows([
    {
      id: "g",
      name: "cordis:group",
      group: true,
      config: [
        { id: "compaction-basic", name: BASIC, disabled: true },
        { id: "compaction-lcm", name: "dsh-lcm", disabled: false }
      ]
    }
  ]);
  assert.deepEqual(out[0].config, [{ id: "compaction-lcm", name: "dsh-lcm", disabled: false }]);
});

test("two basic rows in one group collapse into a single lcm row", () => {
  const out = rewriteCompactionRows([
    {
      id: "g",
      name: "cordis:group",
      group: true,
      config: [
        { id: "compaction-basic", name: BASIC, config: { thresholdRatio: 0.6 } },
        { id: "compaction-basic-copy", name: BASIC, config: { retainTokens: 4000 } }
      ]
    }
  ]);
  assert.deepEqual(out[0].config, [{ ...LCM_ROW, config: { thresholdRatio: 0.6 } }]);
});

// -- defect 3: telemetry names the entry ------------------------------------

test("middleware is a no-op when ctx.on is absent, and the gate still provides", () => {
  const provided = new Map();
  apply({ reflect: { provide: (svc, value) => provided.set(svc, value) } });
  assert.equal(provided.has("lcmCompactionPolicy"), true);

  // And with no reflect either: nothing throws, nothing rewrites.
  apply({});
});

test("middleware rewrites the resolved config and records coverage", () => {
  _resetDshLcmCompactionGateTelemetryForTest();
  const { ctx, listeners, provided } = fakeCtx();
  apply(ctx);

  const middleware = listeners.find((l) => l.event === "internal/config");
  assert.equal(middleware?.options?.global, true);
  // The service is published only after the middleware registers.
  assert.equal(provided.has("lcmCompactionPolicy"), true);

  const resolved = { plugins: presetTree() };
  const out = middleware.listener.call({}, fakeFiber(PRESET), () => resolved);

  assert.deepEqual(out.plugins.find((row) => row.id === "compaction").config[0], {
    ...LCM_ROW,
    config: { thresholdRatio: 0.8 }
  });
  assert.deepEqual(dshLcmCompactionGateTelemetry(), {
    covered: [{ entry: PRESET, rows: 1 }],
    sawFactoryPreset: true
  });

  // An entry that nests no compaction group keeps its resolved config identity.
  const untouched = { plugins: [{ id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash" }] };
  assert.equal(middleware.listener.call({}, fakeFiber(PRESET), () => untouched), untouched);
});

test("telemetry reads the entry from the fiber argument, not from this", () => {
  _resetDshLcmCompactionGateTelemetryForTest();
  const { ctx, listeners } = fakeCtx();
  apply(ctx);
  const middleware = listeners.find((l) => l.event === "internal/config");

  // A real waterfall binds 'this' to the dispatch receiver, which is null:
  // Fiber.resolveConfig dispatches with only the event name. this.entry is
  // therefore always absent, and only the first argument names the entry.
  middleware.listener.call(null, fakeFiber("@dsh-external/dsh-router-standard"), () => ({ plugins: presetTree() }));
  middleware.listener.call({}, { entry: { options: { id: "anon" } } }, () => ({ plugins: presetTree() }));
  middleware.listener.call({}, {}, () => ({ plugins: presetTree() }));

  assert.deepEqual(dshLcmCompactionGateTelemetry(), {
    covered: [
      { entry: "@dsh-external/dsh-router-standard", rows: 1 },
      { entry: "anon", rows: 1 },
      { entry: "unnamed-entry", rows: 1 }
    ],
    sawFactoryPreset: false
  });
});

// -- defect 1: the sweep ----------------------------------------------------

test("sweep force-re-resolves a preset that resolved before the middleware was live", async () => {
  _resetDshLcmCompactionGateTelemetryForTest();
  // The entry mounted ahead of the gate: its RESOLVED config still names basic,
  // its authored config is the same shipped tree.
  const entry = fakePresetEntry({ effective: { plugins: presetTree() }, authored: { plugins: presetTree() } });
  const { ctx } = fakeCtx(fakeLoader([entry]));

  await _sweepStalledPresetsForTest(ctx);

  assert.equal(entry.calls.length, 1);
  const call = entry.calls[0];
  // force is what makes the loader re-resolve even when it thinks nothing moved.
  assert.equal(call.force, true);
  assert.equal(call.create, false);
  // The config handed back carries the rewritten rows, so the re-resolve runs
  // the live middleware instead of short-circuiting on a deep-equal no-op.
  assert.deepEqual(call.options.config.plugins.find((row) => row.id === "compaction").config[0], {
    ...LCM_ROW,
    config: { thresholdRatio: 0.8 }
  });
  assert.deepEqual(dshLcmCompactionGateTelemetry(), {
    covered: [{ entry: PRESET, rows: 1 }],
    sawFactoryPreset: true
  });
});

test("sweep settles the loader BEFORE scanning, so a same-batch preset is seen", async () => {
  _resetDshLcmCompactionGateTelemetryForTest();
  // At apply() time a same-batch preset has no resolved config yet; the scan
  // must therefore run after the tree settles, not immediately.
  const entry = fakePresetEntry({ effective: undefined, authored: { plugins: presetTree() } });
  let settled = false;
  const loader = fakeLoader([entry], {
    await: async () => {
      settled = true;
      // Settlement is what produces the resolved config that names basic.
      entry.fiber.effectiveConfig = { plugins: presetTree() };
    }
  });
  const { ctx } = fakeCtx(loader);

  await _sweepStalledPresetsForTest(ctx);

  assert.equal(settled, true);
  assert.equal(entry.calls.length, 1);
  assert.deepEqual(dshLcmCompactionGateTelemetry(), {
    covered: [{ entry: PRESET, rows: 1 }],
    sawFactoryPreset: true
  });
});

test("sweep still works on a loader with no await, using round delays instead", async () => {
  _resetDshLcmCompactionGateTelemetryForTest();
  const entry = fakePresetEntry({ effective: { plugins: presetTree() }, authored: { plugins: presetTree() } });
  const { ctx } = fakeCtx(fakeLoader([entry]));

  await _sweepStalledPresetsForTest(ctx);

  assert.equal(entry.calls.length, 1);
});

test("sweep skips a preset the middleware already rewrote", async () => {
  _resetDshLcmCompactionGateTelemetryForTest();
  const healthy = rewriteCompactionRows(presetTree());
  const entry = fakePresetEntry({ effective: { plugins: healthy }, authored: { plugins: healthy } });
  const { ctx } = fakeCtx(fakeLoader([entry]));

  await _sweepStalledPresetsForTest(ctx);

  assert.equal(entry.calls.length, 0);
  assert.equal(dshLcmCompactionGateTelemetry(), null);
});

test("sweep ignores entries that are not agent presets, and presets still resolving", async () => {
  _resetDshLcmCompactionGateTelemetryForTest();
  const notAPreset = fakePresetEntry({
    effective: { plugins: presetTree() },
    authored: { plugins: presetTree() },
    entryName: "@deepseek-ai/dsh-some-other-plugin"
  });
  const unresolvedCalls = [];
  const unresolved = {
    options: { id: "preset-row", name: PRESET, config: { plugins: presetTree() } },
    update: async () => {
      unresolvedCalls.push(1);
    }
  };
  const { ctx } = fakeCtx(fakeLoader([notAPreset, unresolved]));

  await _sweepStalledPresetsForTest(ctx);

  assert.equal(notAPreset.calls.length, 0);
  assert.equal(unresolvedCalls.length, 0);
  assert.equal(dshLcmCompactionGateTelemetry(), null);
});

test("sweep degrades on a host without the loader, without update, or without reflect", async () => {
  _resetDshLcmCompactionGateTelemetryForTest();
  // No ctx at all.
  await _sweepStalledPresetsForTest(undefined);
  await _sweepStalledPresetsForTest({});
  // reflect present but the loader service was never provided.
  await _sweepStalledPresetsForTest({ reflect: { get: () => undefined } });
  // A loader whose entry cannot be updated: nothing throws, nothing is recorded.
  const entry = fakePresetEntry({
    effective: { plugins: presetTree() },
    authored: { plugins: presetTree() },
    withUpdate: false
  });
  await _sweepStalledPresetsForTest(fakeCtx(fakeLoader([entry])).ctx);
  // apply() must not throw on any of these either: the sweep is fire-and-forget.
  apply({});
  apply({ reflect: { get: () => undefined } });
  apply({ reflect: { get: () => fakeLoader([entry]) }, logger: { warn() {} } });
  assert.equal(dshLcmCompactionGateTelemetry(), null);
});

test("the bundle patch gates exactly the four presets on the service the gate provides", async () => {
  const patch = await readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8");
  // Anchored at line start so the prose mention in the header is not counted.
  const gated = patch.match(/^  inject: \[lcmCompactionPolicy\]$/gm) ?? [];
  assert.equal(gated.length, 4);
  for (const id of ["preset-standard", "preset-ptc", "preset-minimal", "preset-cordis"]) {
    assert.match(patch, new RegExp("- id: " + id + "\n  inject: \\[lcmCompactionPolicy\\]"));
  }
  // The gate row the patch inserts is the entry this module backs.
  assert.match(patch, /- id: lcm-compaction-gate\n      name: dsh-lcm\/gate/);
  // No preset config is restated anywhere: the override snapshot is gone.
  assert.doesNotMatch(patch, /name: '@deepseek-ai\/dsh-agent-preset'/);
  assert.doesNotMatch(patch, /name: '@deepseek-ai\/dsh-compaction-basic'/);
});
