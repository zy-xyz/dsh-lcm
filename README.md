# dsh-lcm

**English** · [简体中文](README.zh-CN.md)

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
| configuration is a drop-in superset of basic | **verified** — 153 tests, identical defaults and budget math |
| the transaction actually commits | **verified** — `test/region.test.js` replays every append through the harness's own `foldSurface` |
| **a dropped fact stays recoverable** | **verified on production data** — see below |
| **the summary keeps more exact literals** | **verified** — 2 corpora, same instrument: **7/14 vs 2/14**, **15/24 vs 4/24** |
| this summary is *denser* than basic's | not claimed — density is not the goal, fidelity is |
| lcm is cheaper | **no**: the leaf unit costs about **7.95×** the tokens of a single pass, see [the leaf unit](#the-leaf-unit-and-what-it-costs) |

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
| summary shape | free-form prose | verbatim excerpts | **5 narrative sections + an enumerated anchor list** |
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
    thresholdRatio: 0.75       # trigger = min(W*ratio, W-O-headroom); lcm-x's context_threshold
    headroomTokens: 65536
    retainRatio: 0.05          # mutually exclusive with retainTokens; ~47k on a 1M window
    summarizationProvider: ""  # "" = the routed model
    summarizationModel: ""
    maxTokens: 65536           # caps the summary target; the request ceiling is 2 x the target
    compactionRetries: 1
    maxOverflowRetries: 1
    modelPolicies: []
    auto: true
    # ── LCM-only ──
    summaryRatio: 0.12         # summary target = clamp(span*ratio, floor, cap)
    summaryFloorTokens: 512
    checkpointCap: 16384
    leafSpanTokens: 24000      # one compaction summarises at most this much; 48000 halves the call count
    condensationFanin: 4       # same-depth checkpoints merge into one higher node at this fanin
    anchorPointers: true       # post-hoc (seq N) on each verbatim anchor
    emptySummaryRetries: 2     # retry a response with no text block (a truncated-but-textual one is never retried)
    backgroundLeafPrep: false  # pre-compute the next leaf while idle; off, like lcm-x
    temporalRollups: true      # day-level timeline index; ON, like lcm-x
    rollupBuildsPerPass: 2
    rollupMaintenanceBudgetMs: 5000
    assertionExtraction: false # mine (subject, predicate, object) triples; off, like lcm-x
    assertionMaxSourcesPerPass: 4

# The semantic route lives on the SEARCH row, not on the engine. The engine
# declares and resolves the vector keys but the compaction path never reads one,
# so a "vectorEnabled: true" here looks enabled in --dump-config while search
# quietly stays lexical.
- id: tool-lcm-expand
  name: dsh-lcm/tool
  config:
    rank: hybrid               # both gates must open: this + vectorEnabled
    vectorEnabled: false       # off by default; with it false, rank hybrid IS the lexical result
    vectorBaseUrl: "http://10.126.126.4:20128/v1"
    vectorModel: "mistral-proxy/codestral-embed"
    vectorDim: 1536
    # A hosted gateway needs a bearer token; a local LM Studio does not. This is
    # the NAME of the environment variable, never the key: the composition ships
    # in this repository. "" (the default) sends no Authorization header.
    vectorApiKeyEnv: "OMNIROUTE_API_KEY"
    vectorTopK: 8
    vectorCandidateTokens: 100000  # first-search cost is per text; this bounds it
    vectorCandidateLimit: 500      # count ceiling, so tiny events cannot buy the same cost
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

**Which events the semantic route can see.** Only events the current surface does
*not* show — the compacted half. Ranking the tail would be wasted: those messages
are already in the model's context verbatim. Measured on a 24 013-event session,
"newest N events" covered 100% of the live tail and 1.6% of the compacted history,
i.e. the wrong half. The window is priced in **tokens** (`vectorCandidateTokens`),
because cost tracks text length and not event count: on the measured endpoint
~18 ms per text plus ~0.23 ms per token, and neither batching (87–92 ms/text at
batch sizes 8–128) nor concurrency (8 parallel POSTs were *worse*, 205 ms/text)
moves it. 100 000 tokens is ~200 compacted events and ~19 s cold, then free per
text from the disk cache. Older compacted events are reachable by pattern, not by
similarity — `rank: "hybrid"` is what keeps them in the answer, and every result
header states the region it actually covered.

Budget math is basic's, verbatim:

```
messageBudget   = contextWindow − reservedCompletionTokens
pressureBudget  = messageBudget − headroomTokens
thresholdTokens = floor(min(contextWindow × thresholdRatio, pressureBudget))
retainTokens    = retainTokens ?? floor(messageBudget × retainRatio)
targetTokens    = clamp(shadowed × summaryRatio, summaryFloorTokens, checkpointCap)
```

The last line is the only new one, and it is a **target**, not the request
ceiling. The request carries `max(4096, 2 x target)`: a reasoning-first backend
spends part of any ceiling on hidden reasoning, and leaving the ceiling unset was
worse, because the provider then substitutes a smaller default of its own. The
transaction is bounded by the shrink guarantee (framed summary must be smaller
than the span it replaces), which is a post-hoc check no cap can replace.

### The leaf unit, and what it costs

One compaction summarises at most `leafSpanTokens` (24 000) of the compactable
prefix, starting from the oldest node and walking the boundary back to a balanced
tool-pair edge. A 436 194-token history therefore takes 19 leaves, not one pass.

The leaf exists because the single pass fails: on 15 measured questions the
provider cut the response before the sections finished, leaving 1 section on 5 of
them. The same prompt over 24k leaves returned 7/7 with all 6 sections and
`finish: stop` on every one ([bench/REPORT.md](bench/REPORT.md) §32).

What it buys: a summary that is never truncated, complete sections, and a bounded
summariser prompt per call. Same-depth leaves then condense into one higher node
once `condensationFanin` (4) siblings accumulate, so the surface grows
logarithmically instead of as a flat row. A leaf that returns no text, or that the
request ceiling cuts, falls to a deterministic body built from the span itself; a
leaf that comes back over the shrink bound gets one retry at half the budget, then
deterministic truncation. Neither rung calls the model, so the compaction converges
instead of failing.

What it costs: every leaf re-sends the fixed prefix (system prompt plus
instruction). Projected from the measured prefix of 271 301 tokens over the same
436 194-token history:

| | calls | tokens (gross) | vs basic |
|---|---|---|---|
| `dsh-compaction-basic`, one pass | 1 | 712 975 | 1.00× |
| `dsh-lcm`, 19 × 24k leaves | 19 | 5 665 439 | **7.95×** |

Cache hits absorb most of the money but not the token count: with leaves 2..19 at
cache-hit prices the projection is 1 270 361 price-equivalent against basic's
610 217, about **2.08×**. Both figures are projections, not a measured lcm run at
that size.

The knob is `leafSpanTokens`. Raising it to 48 000 halves the leaf count, and
therefore the prefix re-sends, at the cost of each leaf carrying more detail and
being likelier to drop some. 24 000 is the default because it is the size at which
the measured response stopped being truncated.

## Tools

| tool | purpose |
|---|---|
| `lcm_expand` | restore exact original content by `seq` (`"3-7,15"`), `result` (`"3"`) or `checkpoint` (`"1"`) |
| `lcm_search` | keyword/regex search over the whole durable log, including content a checkpoint omitted; optional `vector`/`hybrid` ranking when embeddings are configured |
| `recall` / `search` | **the original backend's names, kept as aliases** — identical behaviour |
| `/lcm-search <pattern>` | the human-side search; appends hits as a durable user message |
| `/lcm-status` | checkpoints, depth, tokens saved |
| `/lcm-embed status` | model, width, cache directory, files, **which source answers the bearer token**, and whether the layer is on |
| `/lcm-embed backfill [--apply] [--limit N] [--window]` | preview (default) or fill the vector cache for the whole compacted corpus — lcm-x's `/lcm embed backfill`. `--limit` caps one pass's work (each pass advances); `--window` fills only the priced search window instead |
| `/recall <pattern>` | **the original command name, kept as an alias** |

Nothing that already pointed at `recall`, `search` or `/recall` breaks when
switching backends. Set `legacyNames: false` on either plugin row to drop the
aliases and register only the LCM names.

## Install

One command, no hand-editing of profile files:

```bash
dsh plugin --profile web add <path-to-this-package-or-its-tarball>
```

From a git URL — the path a marketplace install takes, and the one verified here
(`dsh plugin --profile <p> add github:zy-xyz/dsh-lcm` installed 0.15.0 with the
bundle manifest intact in ~1m51s, building from source):

```bash
dsh plugin --profile web add github:zy-xyz/dsh-lcm
```

Every official package is a peer, not a dependency: the harness already ships
`@deepseek-ai/dsh-compaction`, `dsh-llm`, `dsh-session`, `dsh-token-meter`,
`dsh-tools`, `dsh-util-values`, `cordis` and `schemastery`, and a second copy is
a version-skew bug. They are declared `optional` in `peerDependenciesMeta`, so a
profile that resolves them from the host tree gets no warning noise, and the dsh
ranges enumerate patch tuples with an explicit prerelease tag
(`>=0.2.2-0 <0.3.0-0 || >=0.2.3-0 <0.3.0-0 || …`) because node-semver otherwise
admits a prerelease only on the exact `major.minor.patch` tuple named in the
range — `^0.2.2-0` accepts `0.2.2-rc.1` and silently rejects `0.2.3-rc.1`.

That runs pnpm in the profile, then the plugin manager's own reconciliation
(`reconcileBundleSelection`) registers the package in `dsh.profile.bundles`
because this package declares `dsh.bundle.patch`. From then on the bundle patch is
a layer of the profile: it stands `compaction-basic` down with `disabled: true`
(one `ctx.compaction` per context — `config: {auto: false}` is NOT enough, the row
still registers the service and this engine then fails to take the seam), inserts
this engine plus its tools, and adds the preset-plane latch described in
`cordis.patch.yml`. Restart the process to load it; nothing else needs touching.

Verify without booting:

```bash
dsh --profile web --dump-config | grep -A1 -E 'id: compaction-basic|id: compaction-lcm'
```

Expected: `compaction-basic` carries `disabled: true`, and `compaction-lcm` is
present. Remove it with `dsh plugin --profile web remove dsh-lcm`; the stock
composition returns.

`docs/PRODUCTION-INSTALL.md` carries the rollback commands and what was actually
verified in a live profile.

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
- **Fail closed.** A transport failure, a rate limit or an abort raises; the
  transaction writes one `compaction/end` with the error and the original history
  is untouched. A model-side outcome does not raise: an empty body and an
  over-long one both land on the deterministic rung, because turning "the model
  wrote too much" into "the compaction fails" repeated on every step.

## Limitations

- One compaction is `ceil(span / leafSpanTokens)` model calls, run serially: seconds
  per leaf, and the leaf count grows with the span.
- `dsh 0.2.2-rc.1` exposes no settings-section installer, so the engine reads the
  composition entry directly; `settings.yaml` overlays do not apply.
- The A/B above is one span. Cost is **not** at parity: the leaf unit multiplies
  the token count, see [the leaf unit](#the-leaf-unit-and-what-it-costs). Fidelity
  is the claim; the multiplier is the price.
