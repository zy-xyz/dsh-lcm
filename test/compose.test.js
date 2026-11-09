/**
 * Composition test: prove the bundle patch yields exactly one active
 * `ctx.compaction` engine when layered over a standard profile.
 *
 * This is the closest thing to G0.1 that can run without restarting the
 * harness: `composeEntries` is the same pure function the boot path uses, so a
 * patch that composes correctly here cannot silently mount two engines.
 *
 * Skips outside a dsh profile (where `@deepseek-ai/dsh-app-boot` is absent).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const patchPath = path.join(here, "..", "cordis.patch.yml");

test("the bundle patch leaves exactly one active compaction engine", async (t) => {
  let boot;
  let yaml;
  try {
    boot = await import("@deepseek-ai/dsh-app-boot");
    yaml = await import("yaml");
  } catch {
    t.skip("@deepseek-ai/dsh-app-boot is only resolvable inside a dsh profile");
    return;
  }

  const ourRows = yaml.parse(fs.readFileSync(patchPath, "utf8"));
  const upstream = [
    {
      insert: [
        { id: "agent-loop", name: "@deepseek-ai/dsh-agent-loop" },
        { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic", config: { auto: true } },
        { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" }
      ]
    }
  ];

  const composed = boot.composeEntries([upstream, ourRows]);
  // Match on the row's identity, not on the package name: the engine package is
  // called `dsh-lcm`, so a /compaction/ name test silently selects nothing and
  // the "exactly one engine" assertion passes for the wrong reason (0 !== 1).
  // The gate row (lcm-compaction-gate) provides the service the presets wait
  // on; it is not an engine, so it must not count here.
  const engines = composed.filter(
    (e) => /compaction|lcm/.test(String(e.name ?? "") + " " + String(e.id ?? "")) && !/command|tool|gate/.test(e.id)
  );
  // A row stood down with `auto: false` stays registered but never compacts.
  const active = engines.filter((e) => !e.disabled && e.config?.auto !== false);

  assert.equal(active.length, 1, "exactly one compaction engine may be active");
  assert.equal(active[0].name, "dsh-lcm", "and it is this backend");
  assert.ok(
    engines.some((e) => e.id === "compaction-basic" && e.config?.auto === false),
    "the built-in summarizer is stood down"
  );
  assert.ok(
    composed.some((e) => e.id === "command-compact" && !e.disabled),
    "/compact survives the swap"
  );
  assert.ok(
    composed.some((e) => e.id === "tool-lcm-expand" && !e.disabled),
    "lcm_expand/lcm_search are mounted"
  );
  assert.ok(
    composed.some((e) => e.id === "command-lcm-search" && !e.disabled),
    "/lcm-search is mounted"
  );
});

test("the patch wires the vector keys onto the row that reads them", async (t) => {
  let yaml;
  try {
    yaml = await import("yaml");
  } catch {
    t.skip("yaml is only resolvable inside a dsh profile");
    return;
  }
  const tool = await import("../src/tool.js");
  const { HYBRID_RANK_MODES } = await import("../src/search.js");
  const rows = yaml.parse(fs.readFileSync(patchPath, "utf8"))[0].insert;
  const engineRow = rows.find((row) => row.id === "compaction-lcm");
  const toolRow = rows.find((row) => row.id === "tool-lcm-expand");

  // The engine's schema declares vector* and its config resolves them, but the
  // compaction path never reads one. A key there looks enabled in --dump-config
  // while search stays lexical - the exact defect this asserts against.
  const engineVectorKeys = Object.keys(engineRow.config ?? {}).filter((key) => key.startsWith("vector"));
  assert.deepEqual(engineVectorKeys, [], "the engine row must not carry vector keys it cannot read");

  const config = toolRow.config ?? {};
  assert.equal(config.vectorEnabled, true, "the search tool row is where the layer is switched on");
  assert.ok(HYBRID_RANK_MODES.includes(config.rank), "and rank must name a vector mode, or the layer is inert");
  const resolved = tool.resolveConfig(config);
  assert.equal(resolved.enabled, true, "the tool row resolves to an enabled layer");
  assert.equal(resolved.rank, "hybrid", "hybrid keeps lexical hits the semantic window cannot see");
  assert.equal(resolved.candidateLimit, config.vectorCandidateLimit);
  assert.equal(resolved.candidateTokens, config.vectorCandidateTokens, "the token budget is the primary bound and must be explicit");
  assert.ok(Number.isInteger(resolved.candidateTokens) && resolved.candidateTokens > 0, "the bound is explicit, not a default");

  // /lcm-search is deliberately lexical (src/command.js): it must not carry a
  // rank this bundle never gives it.
  assert.equal(rows.find((row) => row.id === "command-lcm-search").config, undefined);
});
