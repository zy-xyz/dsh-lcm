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
  assert.deepEqual(commands.sort(), ["lcm-search", "recall"]);
});

test("legacyNames: false drops the original command name", () => {
  const { ctx, commands } = recorder();
  command.apply(ctx, { legacyNames: false });
  assert.deepEqual(commands, ["lcm-search"]);
});

test("a tool definition can be built under either name", () => {
  const resolved = tool.resolveConfig({});
  assert.equal(tool.defineRecallTool(resolved).name, "lcm_expand");
  assert.equal(tool.defineRecallTool(resolved, "recall").name, "recall");
  assert.equal(tool.defineSearchTool(resolved).name, "lcm_search");
  assert.equal(tool.defineSearchTool(resolved, "search").name, "search");
});
