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
