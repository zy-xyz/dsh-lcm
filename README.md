# dsh-compaction-lcm

Lossless Context Management (LCM) compaction engine for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

A drop-in replacement for `@deepseek-ai/dsh-compaction-basic` that keeps the
harness's durable compaction transaction intact but replaces the summarizer with
an **LCM leaf summary**: the model writes a structured summary, every shadowed
node stays in the append-only session log, and the checkpoint carries `seq N`
pointers so the agent can restore the exact original tokens.

Built on the [LCM paper](https://papers.voltropy.com/LCM) (Ehrlich & Blackman,
2026-02) and on the durable-protocol work in
[`dsh-compaction-instant`](https://github.com/TsFreddie/dsh-compaction-instant).

## What this engine actually changes

| | `dsh-compaction-basic` | `dsh-compaction-instant` | **`dsh-compaction-lcm`** |
|---|---|---|---|
| summarizer | LLM | deterministic compiler | **LLM** |
| summary content | free-form prose | verbatim excerpts | **structured sections + verbatim anchors** |
| original text after compaction | log only, no model-side path | `(seq N)` + recall tool | **`(seq N)` + `lcm_expand`** |
| checkpoint self-check | `framed < shadowed` | `framed < shadowed` | `framed < shadowed` |
| DAG depth | 1 | 1 | **derived, unbounded** |

Everything except the summary step is the harness's own transaction, inherited
verbatim: lock assertions, `compaction/start|summary|end` bracketing, surface
stability checks, the shrink guarantee, and the failure vocabulary.

## Configuration

```yaml
- id: compaction-lcm
  name: dsh-compaction-lcm
  config:
    auto: true
    thresholdRatio: 0.5        # pressure trigger as a fraction of contextWindow
    retainTurns: 1             # complete recent turns kept verbatim
    retainTokens: 5120         # absolute retained-region ceiling
    summaryRatio: 0.12         # summary budget = 12% of the shadowed span
    summaryFloorTokens: 512    # never summarize below this
    checkpointCap: 16384       # hard ceiling for one summary
    summarizationProvider: ""  # "" = use the routed model
    summarizationModel: ""
    compactionRetries: 1
    maxOverflowRetries: 1
```

The summary budget is `clamp(shadowed × summaryRatio, summaryFloorTokens, checkpointCap)`,
so the compression ratio is stable across context-window sizes instead of
collapsing to nothing on a large span.

## Tools

| tool | purpose |
|---|---|
| `lcm_expand` | restore exact original content: `type:"seq"` (`"3-7,15"`), `type:"result"` (`"result 3"`), `type:"checkpoint"` (`"1"`) |
| `lcm_search` | keyword/regex search over the whole durable log, including content elided by a checkpoint |

`/lcm-expand <pattern>` does the same search from the human side and appends the
hits as a durable user message, so the next model turn sees them.

## Install

```bash
dsh plugin --profile web add dsh-compaction-lcm
```

The bundle patch disables `compaction-basic` (one `ctx.compaction` per context)
and inserts this engine plus its tools.

## Design notes

- **The log is the truth; the summary is a view.** A checkpoint never destroys
  information the agent can no longer reach. That is the whole point of LCM, and
  it is why this engine may compress far harder than a summarizer-only backend.
- **The DAG is derived, not stored.** `deriveDag()` reconstructs checkpoint
  depth from `compaction/summary` events and their replacement messages. No
  side store, no migration, rebuildable after any restart.
- **Verbatim anchors are the anti-loss clause.** The instruction forces paths,
  commands, URLs, error strings, IDs and numeric thresholds to survive
  unmodified — the single largest source of post-compaction failure.
- **Fail closed.** A summary that would not shrink the surface, a truncated
  stream, or an empty response all raise; the transaction writes one
  `compaction/end` with the error and the original history is untouched.

## Limitations

- One compaction is one model call: expect seconds, not milliseconds. Idle
  sessions can absorb this; the hot path cannot. `compactNow` already runs
  inside `agent.runMaintenance`.
- The summary is only as good as the model. `lcm_expand` is the escape hatch,
  not a substitute for a decent summary.
- `dsh 0.2.2-rc.1` exposes no settings-section installer, so the engine reads
  the composition entry directly; `settings.yaml` overlays do not apply.
