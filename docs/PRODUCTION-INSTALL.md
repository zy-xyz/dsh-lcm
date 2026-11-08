# Putting this backend into the `web` profile

Everything below is prepared here; **the restart itself is yours to run** — it
interrupts the live GUI session, and that is not a change to make on someone's
behalf.

## What the profile patch has to contain

`~/.dsh/profiles/web/cordis.patch.yml` gains exactly this (the rest of that file is
yours and stays untouched):

```yaml
- id: compaction-basic
  disabled: true

- insert:
    - id: compaction-lcm
      name: dsh-lcm
- id: tool-lcm-expand
  name: dsh-lcm/tool
- id: command-lcm-search
  name: dsh-lcm/command
```

`compaction-basic` must be disabled in the same layer that mounts this one: two
engines on one context throw (`service "compaction" has been registered`), but
`composeEntries` itself does **not** reject two active rows, so a half-applied patch
fails at boot rather than at review.

## Commands

```bash
# 1. Install the package into the profile.
dsh plugin --profile web add /home/agent/workspaces/lcmx-study/dsh-lcm

# 2. Add the patch entries above to cordis.patch.yml.

# 3. Compose and read the result BEFORE restarting. This exits without booting.
dsh --profile web --dump-config 2>/dev/null \
  | grep -E 'id: compaction-basic|id: compaction-lcm|id: tool-lcm-expand|id: command-lcm-search' -A 1
```

Expected: `compaction-basic` carries `disabled: true`, and the other three are
present. If `compaction-basic` is not disabled, stop — booting would mount two
engines.

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
