// ── live config: the panel's write path ────────────────────────────────────
// The endpoint can change what a running engine decides, so the properties that
// matter are: a rejected value changes NOTHING, an unknown key never reaches a
// row, and a saved value is what a freshly booted process reads.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "lcm-live-test-"));
process.env.DSH_HOME = home;
const live = await import("../src/live.js");

/** A consumer that behaves like a row: validate, stage, commit. */
function consumer(name, surface, initial, rules = {}) {
  const state = { ...initial };
  return {
    state,
    register: () => live.registerLiveConsumer(
      name,
      surface,
      () => live.hotKeysFor(surface),
      (patch, options = {}) => {
        for (const [key, value] of Object.entries(patch)) {
          const rule = rules[key];
          if (rule !== undefined) rule(value);
        }
        const commit = () => { Object.assign(state, patch); };
        if (options.dryRun === true) return commit;
        commit();
        return undefined;
      },
      () => ({ ...state })
    )
  };
}

test("every hot key names a real config key, on exactly one surface", async () => {
  const { CONFIG_KEYS } = await import("../src/config.js");
  const seen = new Set();
  for (const entry of live.HOT_KEYS) {
    assert.equal(seen.has(entry.key), false, entry.key + " is listed twice");
    seen.add(entry.key);
  }
  // The vector surface's keys are not all in CONFIG_KEYS (rank / maxSearchHits live
  // on the tool row), so the check is per surface.
  const compactionKeys = live.HOT_KEYS.filter((entry) => entry.surface === "compaction").map((entry) => entry.key);
  for (const key of compactionKeys) {
    assert.equal(CONFIG_KEYS.has(key), true, key + " must be an engine config key");
  }
});

test("a patch reaches every row on its surface and persists", () => {
  const tool = consumer("tool", "vector", { vectorConcurrency: 4 });
  const command = consumer("command", "vector", { vectorConcurrency: 4 });
  const engine = consumer("engine", "compaction", { thresholdRatio: 0.75 }, {
    thresholdRatio: (value) => { if (!(value > 0 && value < 1)) throw new Error("thresholdRatio must be in (0,1)"); }
  });
  const offs = [tool.register(), command.register(), engine.register()];

  live.applyLive({ vectorConcurrency: 19, thresholdRatio: 0.8 });

  // Both rows on the surface move together: routing to only the first registered
  // row would leave the other serving the old fan-out.
  assert.equal(tool.state.vectorConcurrency, 19);
  assert.equal(command.state.vectorConcurrency, 19);
  assert.equal(engine.state.thresholdRatio, 0.8);

  const stored = JSON.parse(fs.readFileSync(path.join(home, "lcm-live.json"), "utf8"));
  assert.deepEqual(stored.vector, { vectorConcurrency: 19 });
  assert.deepEqual(stored.compaction, { thresholdRatio: 0.8 });
  for (const off of offs) off();
});

test("a refused value changes nothing, not even the rows that accepted", () => {
  // Earlier tests in this file may have saved; this test asserts about a file it
  // did not create, so the state it starts from is "no overrides".
  fs.rmSync(path.join(home, "lcm-live.json"), { force: true });
  const tool = consumer("tool", "vector", { vectorConcurrency: 4 });
  const engine = consumer("engine", "compaction", { thresholdRatio: 0.75 }, {
    thresholdRatio: (value) => { if (!(value > 0 && value < 1)) throw new Error("thresholdRatio must be in (0,1)"); }
  });
  const offs = [tool.register(), engine.register()];
  try { live.applyLive({ vectorConcurrency: 19, thresholdRatio: 2 }); assert.fail("should have thrown"); }
  catch (error) { assert.match(String(error.message), /thresholdRatio/u); }
  // The vector row validated fine, but the write is two-phase: nothing commits.
  assert.equal(tool.state.vectorConcurrency, 4, "the accepting row must not have moved");
  assert.equal(engine.state.thresholdRatio, 0.75);
  assert.equal(fs.existsSync(path.join(home, "lcm-live.json")), false, "nothing is persisted");
  for (const off of offs) off();
});

test("an unknown key is rejected before any row sees it", () => {
  const tool = consumer("tool", "vector", { vectorConcurrency: 4 });
  const off = tool.register();
  assert.throws(() => live.applyLive({ notAKey: 1 }), /not a live-tunable key/u);
  assert.equal(tool.state.vectorConcurrency, 4);
  off();
});

test("the overlay is what a fresh row reads, and clears when emptied", async () => {
  const first = consumer("tool", "vector", { vectorConcurrency: 4 });
  const off = first.register();
  live.applyLive({ vectorConcurrency: 19 });
  off();
  assert.deepEqual(live.overlayFor("vector"), { vectorConcurrency: 19 }, "a restart reads this back");
  // A second boot merges it before resolving, which is the row's own job; here the
  // contract under test is that the file still carries it after the row unloads.
  fs.rmSync(path.join(home, "lcm-live.json"), { force: true });
  assert.deepEqual(live.overlayFor("vector"), {}, "no file means no overrides");
});

test("the record shape survives repeated saves", () => {
  const tool = consumer("tool", "vector", { vectorConcurrency: 4, vectorTopK: 8 });
  const off = tool.register();
  live.applyLive({ vectorConcurrency: 12 });
  live.applyLive({ vectorTopK: 3 });
  const stored = JSON.parse(fs.readFileSync(path.join(home, "lcm-live.json"), "utf8"));
  assert.deepEqual(stored.vector, { vectorConcurrency: 12, vectorTopK: 3 }, "a second save merges, it does not replace the file");
  assert.equal(tool.state.vectorTopK, 3);
  off();
});


test("the endpoint speaks GET/POST and refuses anything else", async () => {
  const { insightRoutes } = await import("../src/insight.js");
  const { resolveConfig } = await import("../src/config.js");
  const tool = consumer("tool", "vector", { vectorConcurrency: 4 });
  const off = tool.register();
  const routes = insightRoutes({ get: () => undefined }, resolveConfig({}));
  const route = routes.find((entry) => entry.path === "/lcm-insight/config");
  assert.notEqual(route, undefined);

  const call = async (method, body) => {
    const handlers = {};
    const req = {
      method,
      url: "/lcm-insight/config",
      socket: { remoteAddress: "127.0.0.1" },
      on(event, handler) { handlers[event] = handler; return this; },
      destroy() {}
    };
    const res = {
      status: 0,
      payload: "",
      writeHead(code) { this.status = code; return this; },
      end(payload) { this.payload = payload ?? ""; return this; }
    };
    const pending = route.handler(req, res);
    if (body !== undefined) {
      handlers.data?.(Buffer.from(body));
      handlers.end?.();
    }
    await pending;
    return { status: res.status, body: res.payload === "" ? null : JSON.parse(res.payload) };
  };

  const read = await call("GET");
  assert.equal(read.status, 200);
  assert.ok(Array.isArray(read.body.keys), "the form's field list comes from the server");
  assert.equal(read.body.values.vectorConcurrency, 4);

  const written = await call("POST", JSON.stringify({ vectorConcurrency: 19 }));
  assert.equal(written.status, 200);
  assert.equal(written.body.values.vectorConcurrency, 19);
  assert.equal(tool.state.vectorConcurrency, 19);

  const refused = await call("POST", JSON.stringify({ nope: 1 }));
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /not a live-tunable key/u);

  const wrongMethod = await call("DELETE");
  assert.equal(wrongMethod.status, 405);

  // A non-loopback caller must not reach a write path even with a valid patch.
  const remote = {
    method: "POST",
    url: "/lcm-insight/config",
    socket: { remoteAddress: "10.0.0.5" },
    on() { return this; },
    destroy() {}
  };
  const res = { status: 0, writeHead(code) { this.status = code; return this; }, end() {} };
  await route.handler(remote, res);
  assert.equal(res.status, 403, "the write path is loopback-only");

  off();
});


test("retention exclusivity survives both a boot and a live patch", async () => {
  const { mergeCompactionConfig } = await import("../src/index.js");
  const { resolveConfig } = await import("../src/config.js");
  // The patch file and the panel can disagree about which retention form is in
  // force. Whichever is later in the merge order wins, and the loser is dropped
  // rather than left for the resolver to reject.
  const fromOverlay = resolveConfig(mergeCompactionConfig({ retainRatio: 0.05 }, { retainTokens: 9000 }));
  assert.equal(fromOverlay.retainRatio, undefined);
  assert.equal(fromOverlay.retainTokens, 9000);

  const fromPatch = resolveConfig(mergeCompactionConfig({ retainTokens: 9000 }, { retainRatio: 0.02 }));
  assert.equal(fromPatch.retainRatio, 0.02);
  assert.equal(fromPatch.retainTokens, undefined);

  const liveWins = resolveConfig(mergeCompactionConfig({ retainRatio: 0.05 }, { retainTokens: 9000 }, { retainRatio: 0.01 }));
  assert.equal(liveWins.retainRatio, 0.01);
  assert.equal(liveWins.retainTokens, undefined);

  const untouched = resolveConfig(mergeCompactionConfig({ retainRatio: 0.05, thresholdRatio: 0.7 }, { thresholdRatio: 0.8 }));
  assert.equal(untouched.retainRatio, 0.05);
  assert.equal(untouched.thresholdRatio, 0.8);
});


test("a vector row's resolved record surfaces under its config key names", async () => {
  const { resolveVectorConfig } = await import("../src/vectors.js");
  // Measured trap: the panel showed every vector* field as unset while the layer
  // was running, because the row reports the RESOLVED record and its field names
  // are renamed (vectorEnabled -> enabled). The form must show real values.
  const raw = {
    vectorEnabled: true, vectorBaseUrl: "http://x/v1", vectorModel: "m", vectorDim: 4,
    vectorConcurrency: 19, vectorTimeoutMs: 1000, vectorTopK: 5,
    vectorCandidateLimit: 10, vectorCandidateTokens: 100, vectorCacheDir: "/tmp/c", vectorApiKeyEnv: "K"
  };
  const resolved = resolveVectorConfig(raw);
  const off = live.registerLiveConsumer("vector-row", "vector", () => live.hotKeysFor("vector"), () => undefined, () => ({ ...resolved }));
  const reported = live.describeLive();
  for (const key of Object.keys(raw)) assert.notEqual(reported[key], undefined, key + " must be reported");
  assert.equal(reported.vectorConcurrency, 19);
  assert.equal(reported.vectorEnabled, true);
  off();
});


test("a JSON-typed key round-trips through the engine's resolver", async () => {
  const { resolveConfig } = await import("../src/config.js");
  let cfg = resolveConfig({ auto: false });
  const off = live.registerLiveConsumer("engine", "compaction", () => live.hotKeysFor("compaction"),
    (patch, options = {}) => {
      const next = resolveConfig({ ...cfg, ...patch });
      const commit = () => { cfg = next; };
      if (options.dryRun === true) return commit;
      commit(); return undefined;
    },
    () => ({ ...cfg }));
  // modelPolicies is a table, so the form edits it as JSON text and the endpoint
  // receives parsed data. The engine's own resolver is what accepts or rejects it.
  const keys = live.describeKeys();
  assert.equal(keys.find((k) => k.key === "modelPolicies").type, "json");
  live.applyLive({ modelPolicies: [{ provider: "p", model: "m", thresholdRatio: 0.6 }] });
  assert.deepEqual(cfg.modelPolicies, [{ provider: "p", model: "m", thresholdRatio: 0.6 }]);
  assert.throws(() => live.applyLive({ modelPolicies: [{ model: "m" }] }), /provider must be a non-empty string/u);
  assert.throws(() => live.applyLive({ modelPolicies: { provider: "p", model: "m" } }), /must be an array/u);
  off();
});

test.after(() => { fs.rmSync(home, { recursive: true, force: true }); });
