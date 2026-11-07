# dsh-compaction-lcm

Lossless Context Management compaction engine for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

A drop-in replacement for `@deepseek-ai/dsh-compaction-basic`: the same
`ctx.compaction` seam, the **same configuration surface with the same defaults**,
the same durable transaction protocol. Only the summarizer changes — the model
writes a structured checkpoint, every shadowed node stays in the append-only
session log, and the checkpoint carries `seq N` pointers so the agent can
restore the exact original tokens with `lcm_expand`.

Built on the [LCM paper](https://papers.voltropy.com/LCM) (Ehrlich & Blackman,
2026-02) and on the durable-protocol work in
[`dsh-compaction-instant`](https://github.com/TsFreddie/dsh-compaction-instant).

## What is measured, and what is not

An audit of the first benchmark round (see [bench/REPORT.md](bench/REPORT.md))
retracted three of its claims. The current state:

| claim | status |
|---|---|
| configuration is a drop-in superset of basic | **verified** — 32 tests, 9/9 basic configs accepted identically |
| a summary written from the enumerated anchor clause retains more verbatim identifiers | **under test** — 3-arm ablation, one span, N=4 |
| the two engines were compared | **never done** — both arms were bare prompt strings, not `compile()` |
| lcm is cheaper | **retracted** — token difference is inside the noise (95% CI −40%…+44%) |

The honest structural claim, which needs no benchmark: **the checkpoint is a view
over a log that keeps everything.** A summary that drops a path is recoverable
with `lcm_expand`; a summary that drops it in a summarizer-only backend is gone
from the model's reach.

## What changes

| | `dsh-compaction-basic` | `dsh-compaction-instant` | **`dsh-compaction-lcm`** |
|---|---|---|---|
| summarizer | LLM | deterministic compiler | **LLM** |
| summary shape | free-form prose | verbatim excerpts | **4 narrative sections + an enumerated anchor list** |
| original text after compaction | log only, no model-side path | `(seq N)` + recall tool | **`(seq N)` + `lcm_expand`** |
| checkpoint self-check | `framed < shadowed` | `framed < shadowed` | `framed < shadowed` |
| summary-DAG depth | 1 | 1 | **derived from the log, unbounded** |

Everything except the summary step is the harness's own transaction, inherited
verbatim: lock assertions, `compaction/start|summary|end` bracketing, surface
stability checks, the shrink guarantee, and the failure vocabulary.

## Configuration

**Every key `dsh-compaction-basic` accepts is accepted here, with the same
meaning and the same default.** An existing basic config drops in unchanged.
Full annotated file: [`config.example.yaml`](config.example.yaml).

```yaml
- id: compaction-lcm
  name: dsh-compaction-lcm
  config:
    # ── identical to dsh-compaction-basic ──
    thresholdRatio: 0.8        # trigger = min(W*ratio, W-O-headroom)
    headroomTokens: 65536
    retainRatio: 0.16          # mutually exclusive with retainTokens
    summarizationProvider: ""  # "" = the routed model
    summarizationModel: ""
    maxTokens: 65536           # defaults to headroomTokens
    compactionRetries: 1
    maxOverflowRetries: 1
    modelPolicies: []
    auto: true
    # ── LCM-only ──
    summaryRatio: 0.12         # summary budget = clamp(span*ratio, floor, cap)
    summaryFloorTokens: 512
    checkpointCap: 16384
```

Budget math is basic's, verbatim:

```
messageBudget   = contextWindow − reservedCompletionTokens
pressureBudget  = messageBudget − headroomTokens
thresholdTokens = floor(min(contextWindow × thresholdRatio, pressureBudget))
retainTokens    = retainTokens ?? floor(messageBudget × retainRatio)
summaryTokens   = clamp(shadowed × summaryRatio, summaryFloorTokens, checkpointCap)
```

The last line is the only new one.

## Tools

| tool | purpose |
|---|---|
| `lcm_expand` | restore exact original content by `seq` (`"3-7,15"`), `result` (`"3"`) or `checkpoint` (`"1"`) |
| `lcm_search` | keyword/regex search over the whole durable log, including content a checkpoint omitted |

`/lcm-search <pattern>` does the same from the human side and appends the hits as
a durable user message, so the next model turn sees them.

## Install

```bash
dsh plugin --profile web add dsh-compaction-lcm
```

The bundle patch disables `compaction-basic` (one `ctx.compaction` per context)
and inserts this engine plus its tools.

## Design notes

- **The log is the truth; the checkpoint is a view.** A checkpoint never
  destroys information the agent can no longer reach — which is what lets this
  backend compress harder than a summarizer-only one.
- **Anchors are an enumeration, not a request.** Asking a model to "keep the
  important strings" while it writes prose retains ~40%; asking it for a flat
  one-per-line list of every identifier retains ~74%. Measured, see
  [bench/REPORT.md](bench/REPORT.md).
- **The DAG is derived, not stored.** `deriveDag()` reconstructs checkpoint
  depth from `compaction/summary` events plus their replacement message. No side
  store, no migration, rebuildable after any restart.
- **Fail closed.** A summary that would not shrink the surface, a truncated
  stream, or an empty response all raise; the transaction writes one
  `compaction/end` with the error and the original history is untouched.

## Limitations

- One compaction is one model call: seconds, not milliseconds.
- `dsh 0.2.2-rc.1` exposes no settings-section installer, so the engine reads the
  composition entry directly; `settings.yaml` overlays do not apply.
- The A/B above is one span. Cost parity is within noise; fidelity gain is the
  claim.
