/**
 * The load-time gate: take the compaction slot inside agent-preset sessions.
 *
 * The mechanism (proven by the vendored billion-context reference, see
 * ref/billion-context/dsh-compaction-disable.ts): a preset row patched with
 * `inject: [<service>]` waits for that service; the gate entry provides it and,
 * before providing, registers a global `internal/config` middleware that
 * rewrites whatever compaction group it finds. Ours replaces the basic engine
 * instead of only disabling it, and matches on `name` so a profile that renames
 * rows still resolves to dsh-lcm.
 *
 * Run with: node --test test/gate.test.js
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  _resetDshLcmCompactionGateTelemetryForTest,
  apply,
  dshLcmCompactionGateTelemetry,
  inject,
  name,
  rewriteCompactionRows
} from "../gate/index.js";

const BASIC = "@deepseek-ai/dsh-compaction-basic";
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
function fakeCtx() {
  const listeners = [];
  const provided = new Map();
  return {
    ctx: {
      on(event, listener, options) {
        listeners.push({ event, listener, options });
      },
      reflect: { provide(svc, value) {
        provided.set(svc, value);
      } }
    },
    listeners,
    provided
  };
}

test("gate entry declares the expected plugin name and no dependencies", () => {
  assert.equal(name, "lcm-compaction-gate");
  assert.deepEqual(inject, []);
});

test("replaces basic with lcm inside a nested compaction group, keeping command-compact", () => {
  const out = rewriteCompactionRows(presetTree());
  const group = out.find((row) => row.id === "compaction");
  assert.deepEqual(group.config[0], LCM_ROW);
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

test("a host-plane basic row is never touched — only nested groups are rewritten", () => {
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
          config: [{ id: "compaction", name: "cordis:group", group: true, config: [{ id: "compaction-basic", name: BASIC }] }]
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
  const out = middleware.listener.call({ entry: { options: { name: "@deepseek-ai/dsh-agent-preset" } } }, {}, () => resolved);

  assert.deepEqual(out.plugins.find((row) => row.id === "compaction").config[0], LCM_ROW);
  assert.deepEqual(dshLcmCompactionGateTelemetry(), {
    covered: [{ entry: "@deepseek-ai/dsh-agent-preset", rows: 1 }],
    sawFactoryPreset: true
  });

  // An entry that nests no compaction group keeps its resolved config identity.
  const untouched = { plugins: [{ id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash" }] };
  assert.equal(middleware.listener.call({}, {}, () => untouched), untouched);
});

test("the bundle patch gates exactly the four presets on the service the gate provides", async () => {
  const patch = await readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8");
  // Anchored at line start so the prose mention in the header is not counted.
  const gated = patch.match(/^  inject: \[lcmCompactionPolicy\]$/gm) ?? [];
  assert.equal(gated.length, 4);
  for (const id of ["preset-standard", "preset-ptc", "preset-minimal", "preset-cordis"]) {
    assert.match(patch, new RegExp(`- id: ${id}\\n  inject: \\[lcmCompactionPolicy\\]`));
  }
  // The gate row the patch inserts is the entry this module backs.
  assert.match(patch, /- id: lcm-compaction-gate\n      name: dsh-lcm\/gate/);
  // No preset config is restated anywhere: the override snapshot is gone.
  assert.doesNotMatch(patch, /name: '@deepseek-ai\/dsh-agent-preset'/);
  assert.doesNotMatch(patch, /name: '@deepseek-ai\/dsh-compaction-basic'/);
});
