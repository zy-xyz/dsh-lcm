# Putting this backend into the `web` profile

Everything below is prepared here; **the restart itself is yours to run** — it
interrupts the live GUI session, and that is not a change to make on someone's
behalf.

## What the bundle patch contains

Nothing in `~/.dsh/profiles/web/cordis.patch.yml` needs to change. The rows below
ship inside this package (`cordis.patch.yml`) and become a profile layer on
install; `--dump-config` is where you read them.

```yaml
- id: compaction-basic
  disabled: true          # not "config: {auto: false}"

- insert:
    - id: compaction-lcm
      name: dsh-lcm
    - id: tool-lcm-expand
      name: dsh-lcm/tool
    - id: command-lcm-search
      name: dsh-lcm/command
    - id: lcm-compaction-gate
      name: dsh-lcm/gate
```

`disabled: true` is the load-bearing part, and `auto: false` is not a substitute.
Two engines on one context throw (`service "compaction" has been registered`), and
`auto: false` does not prevent that registration — it only skips the automatic
listeners. Measured on a fresh headless profile: with `auto: false` the boot printed
`1 entry did not activate` plus that error and left the profile with NO compaction
engine at all (basic muted by the same config, this engine rejected), while
`--dump-config` showed every row and looked correct. `composeEntries` does not
reject two active rows either, so the failure is at boot, not at review. The web
profile only worked because `@deepseek-ai/dsh-web-app` happens to disable the same
row for its own reasons.

## Commands

```bash
# 1. Install. This is the WHOLE install: pnpm runs in the profile, then the
#    plugin manager registers the package in dsh.profile.bundles because it
#    declares dsh.bundle.patch, and the bundle patch becomes a profile layer.
dsh plugin --profile web add /home/agent/workspaces/lcmx-study/dsh-lcm

# 2. Compose and read the result BEFORE restarting. This exits without booting.
dsh --profile web --dump-config 2>/dev/null \
  | grep -E 'id: compaction-basic|id: compaction-lcm|id: tool-lcm-expand|id: command-lcm-search' -A 1
```

Expected: `compaction-basic` carries `disabled: true`, and the other three are
present. If `compaction-basic` is not disabled, stop — booting would mount two
engines.

**Do not hand-write these rows into the profile patch.** An earlier version of this
document told you to, and following it produces duplicate ids (`compaction-lcm`,
`tool-lcm-expand`, `command-lcm-search` each appear twice in `--dump-config`);
the loader is last-wins by id, so the hand row silently replaces the bundle row and
drops its config — including the whole vector block. The bundle patch is the only
place these rows belong.

### The peer-dependency warning is expected

`pnpm` prints a `[WARN]` that the linked package lists `@deepseek-ai/dsh-*` as
peer dependencies which "will not resolve the peer dependencies from the target
node_modules". That is normal here: dsh supplies those modules at runtime, not from
the profile's own tree. Verified on a scratch profile — `dsh plugin add` links it,
the profile boots, and the engine constructs:

```
[dsh-lcm] engine: constructed rev=lcm-summary-1 debugLog=… summaryRatio=0.12 cap=16384
OK
```

Do not "fix" it by switching to the `file:` protocol, which the warning suggests; a
copied tree stops tracking the working copy.

## After the restart, in order

1. **The engine loaded.** `~/.dsh/logs` or the profile's stdout should not contain
   `compaction-lcm` errors or `did not activate`.
2. **A real compaction lands.** Use the session for a while (or `/compact`), then
   check the newest session log:
   ```bash
   d=$(ls -dt ~/.dsh/sessions/*/*/ | head -1)
   zstd -dc "${d}session.v4.jsonl.zstd" | grep -c 'compaction/'
   ```
   Non-zero means the engine ran. `compaction/end` records carrying `error` mean it
   ran and failed; read the message, it names the cause.
3. **The tools are on the wire.** In a session's `request/header`, the tool list
   should contain `lcm_search` and `lcm_expand`. Without them the checkpoint is
   write-only and the whole retrieval half of the design is dead.
4. **The checkpoint is what it should be.** One `compaction/summary`'s text should
   have the section headings (`逐字锚点`, `用户事实`, …), carry `maxTokens` and no
   `targetTokens`, and show `(seq N)` pointers inside the anchor list.

## Subagents are the next gate, not the same gate

Subagents run **concurrently with the parent**, so they are the first real test of
two compactions against one session log at overlapping times. Check, in this order:

1. A parent turn that spawns a subagent still produces ordered
   `compaction/start → summary → end` records, with no interleaved pair.
2. The subagent's own session compacts independently and its checkpoint's `seq`
   values resolve with `lcm_expand` (they are per-session positions, so a parent's
   `seq` is meaningless in a child).
3. Killing a subagent mid-compaction leaves the parent able to continue: the lock is
   `compaction/start` without `compaction/end`, and `assertNoActiveCompaction`
   refuses a second attempt until it is closed. That is fail-closed by design; what
   to confirm is that it recovers rather than wedging the session forever.

## Rollback

Remove the patch entries and re-enable `compaction-basic`, then restart. The lcm
checkpoints already in a session log stay readable as ordinary user messages —
`source.kind === "compact-checkpoint"` — so nothing becomes unreadable.

## Deployed to the web profile (2026-11-08)

Installed as a bundle, then restarted. What is verified, and what is not.

### Verified

| check | evidence |
|---|---|
| package present in the profile | `node_modules/dsh-lcm -> ../../../../workspaces/lcmx-study/dsh-lcm` |
| composition applies | `--dump-config` shows `lcmCompactionPolicy` 4 times (one per shipped preset), the `lcm-compaction-gate` row, and host `compaction-basic` stood down |
| the load-time hook exists in this dsh | `@deepseek-ai/cordis-plugin-loader/lib/index.js:740` runs `ctx.on("internal/config", (fiber, next) => …)` |
| the preset latch is satisfied | sessions are created and resumed normally (24 recovered, 0 failed); a preset that never receives `lcmCompactionPolicy` cannot compose a session at all |
| the engine is on the wire post-restart | the system prompt written at 15:38 (after the restart) contains `lcm_expand` and `lcm_search` |
| the embedding endpoint works | `POST http://10.126.126.4:20128/v1/embeddings` with `mistral-proxy/codestral-embed` → 200 with a 1536-d vector, and `OMNIROUTE_API_KEY` is present in the process environment (without it the call is a clean 401 and the search degrades to lexical) |

### Not verified

That a real compaction in the web profile goes through this engine rather than the built-in. No compaction has happened since the restart: the session's two records both predate it and both carry the built-in's signature (8 English headings, `maxTokens 65536`).

The threshold is why. `balanced-lite` has a 256 000-token window, so compaction waits for roughly 125 000 tokens of conversation. `/compact` forces it immediately through the same engine, which is the one-command check:

```bash
# in any session: /compact, then
node -e '
const fs=require("fs"),z=require("node:zlib");
const evs=z.zstdDecompressSync(fs.readFileSync(process.argv[1])).toString("utf8")
  .split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}})
  .filter(e=>e&&Number.isSafeInteger(e.seq));
for(const s of evs.filter(e=>e.type==="compaction/summary")){
  const t=(s.data.summary||[]).map(b=>b.text||"").join("");
  console.log(new Date(s.time).toISOString(),"| maxTokens",s.data.maxTokens,
    "| heads",(t.match(/^## .*/gm)||[]).length,"| lcm",/lcm leaf summary/.test(t));
}' <session-dir>/session.v4.jsonl.zstd
```

`maxTokens ≈ 512` with five Chinese headings and `lcm leaf summary` means this engine took the slot. `65536` with eight English headings means the built-in still does.

### Rollback

```bash
cd ~/.dsh/profiles/web
cp cordis.patch.yml.bak.20261108_153535 cordis.patch.yml
cp package.json.bak.20261108_153535 package.json
cd /tmp && dsh plugin --profile web remove dsh-lcm
```

### The vector layer: enabled in the shipped patch

The bundle ships the layer ON, on the **search tool row** (`tool-lcm-expand`):
`rank: hybrid`, `vectorEnabled: true`, the measured endpoint/model/dimension, and
the two cost bounds. The engine's default is still off, which is why the keys must
sit on the tool row — see below.

`vectorEnabled` is a key of the **search tool row**
(`tool-lcm-expand`, name `dsh-lcm/tool`), not of the engine: the engine declares and
resolves the `vector*` keys but the compaction path never reads one, so putting
`vectorEnabled: true` on `compaction-lcm` shows as enabled in `--dump-config` while
`lcm_search` quietly stays lexical. That mistake shipped in an earlier version of
this document. Enabling the layer means, on the tool row:
`rank: hybrid` (both gates must open), `vectorEnabled: true`, `vectorBaseUrl`,
`vectorModel`, `vectorDim`, and — because the first search pays per text — the
`vectorCandidateTokens` budget (default 100 000, ~19 s cold on the measured
endpoint) plus the `vectorCandidateLimit` count ceiling (default 500).

The candidates are the events the current surface does **not** show. Ranking the
live tail would be pure waste: those messages are already in the model's context.
A session that has never compacted therefore has no semantic candidates at all and
the hybrid result is exactly the lexical one.

