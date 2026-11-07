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
  const engines = composed.filter(
    (e) => /compaction|lcm/.test(String(e.name ?? "") + " " + String(e.id ?? "")) && !/command|tool/.test(e.id)
  );
  const active = engines.filter((e) => !e.disabled);

  assert.equal(active.length, 1, "exactly one compaction engine may be active");
  assert.equal(active[0].name, "dsh-lcm", "and it is this backend");
  assert.ok(
    engines.some((e) => e.id === "compaction-basic" && e.disabled === true),
    "the built-in summarizer is disabled"
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
