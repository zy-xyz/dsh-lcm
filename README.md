# dsh-lcm

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

> **Status: passes the fidelity gate; installation is a deliberate step.**
>
> Measured against `dsh-compaction-basic` with type-grouped verbatim recall on two
> corpora, this backend hands the model **3.0–3.5× more of the exact literals**
> (7/14 vs 2/14 on a 4.3k span, 15/24 vs 4/24 on an 8.1k span) and reaches **75%**
> of what the model can still quote from the same text *uncompacted*, where
> `basic` reaches 20%. On LongMemEval_S its lexical search scores sR@5 **0.774**
> against `lcm-x`'s own lexical arm at 0.20, and one full trace shows a 1 669-token
> checkpoint answering a question whose evidence was compressed away, via a single
> `lcm_search`.
>
> Installing it replaces `compaction-basic` for the whole profile, so it stays a
> deliberate choice rather than a default. See [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)
> for the gate table and [bench/REPORT.md](bench/REPORT.md) for every number, including
> the two measurement bugs that reversed earlier conclusions.

## What is measured, and what is not

An audit of the first benchmark round (see [bench/REPORT.md](bench/REPORT.md))
retracted three of its claims. The current state:

| claim | status |
|---|---|
| configuration is a drop-in superset of basic | **verified** — 102 tests, identical defaults and budget math |
| the transaction actually commits | **verified** — `test/region.test.js` replays every append through the harness's own `foldSurface` |
| **a dropped fact stays recoverable** | **verified on production data** — see below |
| **the summary keeps more exact literals** | **verified** — 2 corpora, same instrument: **7/14 vs 2/14**, **15/24 vs 4/24** |
| this summary is *denser* than basic's | not claimed — density is not the goal, fidelity is |
| lcm is cheaper | not claimed — cost is out of scope by instruction |

### The measured difference that is not a prompt trick

On the real 436 194-token production span (`bench/recovery.mjs`):

| | value |
|---|---|
| anchors the production summary actually carried | **3 / 24 (12.5%)** |
| anchors recovered byte-exactly through `lcm_expand` | 21 / 21 |
| **anchors the model can still obtain** | **24 / 24 (100%)** |
| permanently lost | **0** |

At that size **no summary can hold everything** — that is a capacity ceiling, not a
model failure. A summarizer-only checkpoint stops at 12.5% because nothing in it
tells the model the rest exists. This one carries `seq` pointers and a recall guide,
so the rest is one call away.

Precisely stated: *discoverable* recoverability goes from 12.5% to 100%. Basic is not
at zero — `session_search` exists — but its checkpoint never points at it.

The old "denser summary" framing is gone: measured with type-grouped verbatim
recall on two corpora, this backend's summary carries **3.0–3.5× more of the exact
literals** than basic's (7/14 vs 2/14 on a 4.3k span; 15/24 vs 4/24 on an 8.1k
span) and reaches **75%** of what the model can still quote from the *uncompacted*
text, against basic's 20%. That is the claim, and it holds on both corpora.
Installation is still a deliberate step — it disables `compaction-basic`.

The honest structural claim, which needs no benchmark: **the checkpoint is a view
over a log that keeps everything.** A summary that drops a path is recoverable
with `lcm_expand`; a summary that drops it in a summarizer-only backend is gone
from the model's reach.

## What changes

| | `dsh-compaction-basic` | `dsh-compaction-instant` | **`dsh-lcm`** |
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
  name: dsh-lcm
  config:
    # ── identical to dsh-compaction-basic ──
    thresholdRatio: 0.8        # trigger = min(W*ratio, W-O-headroom)
    headroomTokens: 65536
    retainRatio: 0.16          # mutually exclusive with retainTokens
    summarizationProvider: ""  # "" = the routed model
    summarizationModel: ""
    maxTokens: 65536           # target length hint; never sent as a request cap
    compactionRetries: 1
    maxOverflowRetries: 1
    modelPolicies: []
    auto: true
    # ── LCM-only ──
    summaryRatio: 0.12         # summary target = clamp(span*ratio, floor, cap)
    summaryFloorTokens: 512
    checkpointCap: 16384
    anchorPointers: true       # post-hoc (seq N) on each verbatim anchor
    emptySummaryRetries: 2     # retry a response with no text block (a truncated-but-textual one is never retried)
    # ── optional vector recall (off by default) ──
    vectorEnabled: false       # both gates must open: this + rank=vector|hybrid
    vectorBaseUrl: "http://10.126.126.3:1234/v1"
    vectorModel: "text-embedding-qwen3-vl-embedding-8b"
    vectorDim: 4096
    vectorTopK: 8
    vectorTimeoutMs: 20000
    vectorCacheDir: ".lcm-vectors"
```

### Optional semantic search

`lcm_search` is a regex over the durable log — built for "the agent remembers a
string", not for natural-language questions. On LongMemEval_S, feeding the
question text verbatim produced **zero hits on 499 of 500 questions**; that is a
query-shape mismatch, not a bug in the matcher. Two ways out, both opt-in:

- `rank: "vector"` — embedding KNN against any OpenAI-compatible endpoint.
  Cosine, not dot product (the endpoint returns unnormalised vectors, and a
  dot-product ranking measurably inverts the order). Results are cached on disk
  by `sha256(model + truncated text)`.
- `rank: "hybrid"` — RRF (k=60) over lexical and vector, the same fusion
  `lcm-x` uses for its `hybrid_rrf` arm.

With `vectorEnabled: false` — the default — both modes cost nothing: the search
path is byte-identical to the lexical one, asserted by test. An unreachable
backend degrades to lexical and says so in the result text instead of throwing.

Budget math is basic's, verbatim:

```
messageBudget   = contextWindow − reservedCompletionTokens
pressureBudget  = messageBudget − headroomTokens
thresholdTokens = floor(min(contextWindow × thresholdRatio, pressureBudget))
retainTokens    = retainTokens ?? floor(messageBudget × retainRatio)
targetTokens    = clamp(shadowed × summaryRatio, summaryFloorTokens, checkpointCap)
```

The last line is the only new one, and it is a **target**, not a cap: the
summarizer request carries no `maxTokens`, so the provider's own default ceiling
applies and a longer answer is accepted. The transaction is bounded by the shrink
guarantee (framed summary must be smaller than the span it replaces), which is a
post-hoc check no cap can replace.

## Tools

| tool | purpose |
|---|---|
| `lcm_expand` | restore exact original content by `seq` (`"3-7,15"`), `result` (`"3"`) or `checkpoint` (`"1"`) |
| `lcm_search` | keyword/regex search over the whole durable log, including content a checkpoint omitted; optional `vector`/`hybrid` ranking when embeddings are configured |
| `recall` / `search` | **the original backend's names, kept as aliases** — identical behaviour |
| `/lcm-search <pattern>` | the human-side search; appends hits as a durable user message |
| `/recall <pattern>` | **the original command name, kept as an alias** |

Nothing that already pointed at `recall`, `search` or `/recall` breaks when
switching backends. Set `legacyNames: false` on either plugin row to drop the
aliases and register only the LCM names.

## Install

```bash
dsh plugin --profile web add dsh-lcm
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
- **Pointer density beats summary density.** Industry measurements converge on
  the same point (Anthropic's just-in-time context, Letta's filesystem-as-memory,
  memory-bench's agentic grep arm, SUMER's goal-directed search): compression is
  lossy, and what wins is keeping lightweight pointers and fetching on demand.
  That is the architecture here, which is why recoverability is 100% while the
  checkpoint is 3.8k tokens. See [RESEARCH-INDUSTRY.md](RESEARCH-INDUSTRY.md).
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
