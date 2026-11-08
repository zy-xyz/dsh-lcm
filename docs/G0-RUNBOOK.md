# G0 — running the engine in a real dsh profile

The acceptance gate G0 asks for one real compaction through the real boot path.
It was run on 2026-11-08 in a **throwaway profile**, so the user's own `web`
profile was never touched and nothing was switched permanently.

## Recipe

```bash
# 1. A scratch profile from the headless template (not a copy of web).
dsh --profile lcmhead --from-default-profile headless --dump-config

# 2. Install this package into it.
dsh plugin --profile lcmhead add /path/to/dsh-lcm

# 3. Give it a reachable route and thresholds small enough that a two-step task
#    crosses the trigger. maxTokens defaults to headroomTokens, so keep headroom
#    large or the summary gets truncated at the cap instead of completing.
cat > ~/.dsh/profiles/lcmhead/cordis.patch.yml <<'YAML'
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      omniroute:
        apiKeyEnv: OMNIROUTE_API_KEY
        api: openai-completions
        baseURL: http://10.126.126.4:20128/v1
        models:
          - id: balanced-lite
            contextWindow: 256000
            maxTokens: 65536
- id: agent-default-model
  config:
    provider: omniroute
    model: balanced-lite
- id: compaction-lcm
  config:
    thresholdRatio: 0.001
    headroomTokens: 8000
    retainRatio: 0.0002
    summaryRatio: 0.3
    checkpointCap: 4096
    auto: true
    debug: true
    debugLogPath: /tmp/lcm-g0-debug.log
YAML

# 4. Run a task that takes two tool steps.
OMNIROUTE_API_KEY=... dsh --profile lcmhead \
  "Use bash to run: echo one. Then use bash to run: echo two. Then say done."
```

## What to look for

`/tmp/lcm-g0-debug.log` should contain a `summarize done tokens=... ratio=...`
line, and the session log under `~/.dsh/sessions/--tmp--/session-*/` should
contain the bracketed triple plus a replacement node:

```
compaction/start    seq 22
compaction/summary  seq 23   (the checkpoint, anchors carry (seq N))
compaction/end      seq 25
user/message        seq 24   surfaceOp {"op":"replace","startSeq":8,"endSeq":11}
```

## Why this file exists

The first attempt at G0 found that **the plugin had never compacted in a real
session**: a real `Session` exposes `log` and `snapshotEvents()`, not `events`,
and six read sites assumed `events`. Every test used a fixture with `events`, so
84 green tests proved nothing about the real path. The failure was swallowed by
the intentional "continuing the turn" catch, so it was silent.

Reproduce the check without a browser: if `lcm-g0-debug.log` shows
`step compaction failed: Cannot read properties of undefined`, the session
event accessor has regressed.
