# Changelog

## 0.9.0 — 2026-11-09 — a threshold crossing now sweeps, and a leaf no longer pays for the system prompt

Two defects found on a real 1M-window production session (`session-65bd8898`,
"用 agent 团队在 FNOS 上构建 macOS kShim 双系统"). Both are the kind that look like
"compaction ran and did nothing".

### Fixed — a crossing released ONE leaf and stopped

Measured: crossing at 807 187 tokens (80.7%) released a single 24 000-token leaf,
landed at 783 136 (78.3%) — below the 800 000 threshold — and returned. The next
crossing released another single leaf. The session stayed welded to the threshold,
paying one full model call per 2.4% of window, and the UI kept reading 78%.

That is not lcm-x's design. lcm-x has `threshold_full_sweep_enabled` (default
True): a crossing raises the leaf-pass budget to 12 and runs until the raw backlog
outside the fresh tail is drained (`compaction.py:2313`, `2623-2626`), bounded by
`_THRESHOLD_FULL_SWEEP_MAX_PASSES = 12` and
`_THRESHOLD_FULL_SWEEP_MAX_SECONDS = 120`.

Three new keys, all matching lcm-x's constants:

| key | default | meaning |
|---|---|---|
| `thresholdFullSweep` | `true` | a crossing sweeps; `false` restores the tick |
| `fullSweepMaxPasses` | `12` | leaves one sweep may release |
| `fullSweepMaxSeconds` | `120` | wall-clock budget for one sweep |

Exhausting either budget is a partial stop that returns the last checkpoint and
lets the next turn continue — lcm-x's `pass_budget_exhausted` /
`time_budget_exhausted` — not an error. The manual path keeps the old retry
budget: a model switch that cannot reach the threshold must say so.

### Fixed — every leaf replayed the conversation's 411 154-character system prompt

`summarizeLeaf` prepended the conversation's own system prompt to every leaf
request, copying `dsh-compaction-basic` (which replays it because basic compacts
the whole prefix in ONE call, so it is paid once). In a leaf backend the same
decision is paid once per leaf, and on this session it was 99% of the request:

| leaf request | input tokens | cacheRead | wall clock | output |
|---|---:|---:|---:|---|
| with the system prompt (before) | 137 304 | 136 064 | 90.4 s | 7 376 chars, 6 sections |
| without it (after) | 36 184 | 0 | 32.0 s | 7 158 chars, 6 sections |

3.8x cheaper and 2.8x faster for the same output. The cache did not save the wall
clock: `cacheRead` was 136 064 of 137 304 and the call still took 90 s, because a
cached prefill is cheap in dollars and not in time. Twelve leaves at 90 s is 18
minutes; at 32 s it is 6.4, which is what makes a sweep usable.

lcm-x never sends the host system prompt: its leaf request is its own short
contract plus the transcript as user data, with a bare `[{role:"user", ...}]` as
the fallback path. The instruction already carries the contract, so the span and
the instruction are now the whole request.

Tests: 228 → 235. `test/threshold-sweep.test.js` pins the sweep, its two budgets,
the partial stop, the disabled fallback, and the manual path;
`test/summarizer-parity.test.js` now asserts the system prompt is absent rather
than present.

## 0.8.0 — 2026-11-09 — five defects found by auditing against the LCM paper

An audit of the deployed engine against the paper's invariants and against real
production logs turned up five defects. Every one has a reproduction in the
message that introduced it and a test that fails without the fix.

### Fixed — condensation fired exactly once per session

Selection merged only the LEADING same-depth run. Once one depth-2 node existed it
WAS the leading run, so the depth-1 siblings behind it could never lead again and
condensation became unreachable: measured on a 40-round replay, round 7 merged to
`[2]` and rounds 8-40 appended one depth-1 leaf each until the surface read
`[2, 1 x 33]` — max depth 2, 34 checkpoints on the surface, 49 surface nodes, and
the assembled context growing linearly, which is the exact failure the fanin
exists to prevent.

Selection now takes the first MAXIMAL same-depth run anywhere in the compactable
window. Two corrections matter and both are stated in `src/region.js`: the WHOLE
run must be merged (stopping at `fanin` nodes would leave same-depth siblings to
the right of a depth `d+1` node, an inversion the merge itself creates), and
"maximal" must hold on the whole surface (a run cut by the retained tail cannot be
merged without parking a rollup in front of a leaf it never absorbed). Same replay
after the fix: max depth 3 reached at round 23, 6 checkpoints on the surface,
21 surface nodes (peak 28), positional depths non-increasing at every round.

### Fixed — `/compact` re-summarised its own last summary

`compactNow` passed three arguments, so `fanin = 0` and the `fanin > 1` branch —
which is the ONLY place that skips checkpoints already on the surface — never ran.
Every manual compaction therefore started its leaf at the previous checkpoint:
measured, the second `/compact` selected exactly `seqs 23-23` and the surface went
from one depth-1 node to one depth-2 node; a repeat with nothing new threw
`ManualCompactionError("summary")` on the shrink gate (`337 >= 337`), spending a
model call to be told the summary could not be smaller than itself. The manual
path now passes the configured fanin and nothing else — floor, leaf cap and
retention stay off — and the repeat case returns `null` cleanly.

### Fixed — `condensationFanin: 1` silently disabled condensation

Both the schema and the runtime validator accepted 1, and 1 makes the guard
`fanin > 1` false: the automatic path lost condensation and the checkpoint skip
together. Floored at 2 in both layers, with an error that names the consequence.

### Fixed — the semantic layer was enabled on a row that never reads it

`vectorEnabled: true` and its siblings sat on the `compaction-lcm` row. The engine
declares and resolves them but the compaction path never reads one, while the row
that DOES read them (`tool-lcm-expand`) had no config at all:
`resolveConfig({})` resolves to `{rank: "density", enabled: false}`, so the layer
was off in production while `--dump-config` showed it on. Moved to the tool row
with `rank: hybrid`, and `/lcm-search` now rejects a vector rank instead of
accepting one it would ignore.

### Fixed — the semantic candidate window pointed at the wrong half

The first bound took the newest N events. Measured on a 24 013-event session that
covered 100% of the live tail — the messages already in the model's context
verbatim — and 1.6% of the compacted history, which is the only region a
retrieval tool exists to reach. Candidates are now the events the current surface
does not show, priced in tokens (`vectorCandidateTokens`, default 100 000) rather
than in event count, because cost tracks text length: ~18 ms per text plus
~0.23 ms per token on the measured endpoint, and neither batching (87-92 ms/text
across batch sizes 8-128) nor concurrency (8 parallel POSTs: 205 ms/text, worse
than serial) changes it. Every result header states the region actually covered.

### Fixed — `/lcm-status` reported the target as if it were the result

"kept" summed `maxTokens`, which is the summary TARGET the instruction asked for.
On the production checkpoint that published `371 625 -> 16 384 kept (22.68:1)`
where the produced body is 6 183 tokens (`60.10:1`). Now measured from the
event's own summary blocks with the same estimator the engine states its budgets
in.

### Fixed — the 120-line anchor bound was prose, not code

The instruction asks for at most 120 anchor lines; nothing counted them and the
model wrote 262 (38% of the whole checkpoint), including lines holding nothing but
a backtick and lines that copied the instruction's OWN headings into the word
list — strings that, pasted into `lcm_search`, match the checkpoint that contains
them. The post-hoc attribution pass now drops non-content anchors and enforces the
bound deterministically: unverified lines go before verified ones, most-repeated
before unique, later-listed before earlier. Replaying the production checkpoint
through the fixed pass: 262 lines to 120, every kept line carrying a pointer, six
sections intact.

## 0.7.0 — 2026-11-08 — compact in leaves, not in one ever-deeper checkpoint

### Changed — the compression unit

Borrowed from lcm-x, which condenses in leaf chunks of `leaf_chunk_tokens`
(24 000) with a ~2 000-token target each and keeps every leaf, assembling several
of them per request.

One pass over the whole compactable prefix meant the surface never held more than
one checkpoint: `deriveDag` had depth without breadth, and a 400k-token span was
summarised in a single call whose response the provider truncated before the
sections were finished. Measured on 147k tokens: one pass produced 1 section on 5
of 15 questions with the response cut mid-word; 7 leaves of 20-23k each produced
all six sections 7 times out of 7, each finishing `stop`.

`selectCompactableRange` takes an optional `maxSpanTokens`; the automatic paths
pass `leafSpanTokens` (default 24 000). The leaf starts at the OLDEST node, matching
lcm-x's oldest-leaf-first order, and the end walks back until the boundary is
balanced so a replacement never splits a tool-call/result pair. `0` keeps the
historical whole-prefix selection byte for byte, which manual `/compact` relies on.

### Measured effect on answers

Same four questions from the paired failures, same instruction, same model; only
the compression unit changed:

| question | gold | one span | 7 leaves |
|---|---|---|---|
| `e47becba` | `Business Administration` | UNKNOWN | **correct** |
| `95bcc1c8` | `10` | UNKNOWN | **`10 amateur comedians`** |
| `76d63226` | `55-inch` | UNKNOWN | **`55-inch 4K smart TV`** |
| `0ea62687` | `2` | UNKNOWN | matched, but the answer opens with `Unknown` |

Costs: ⌈span/24k⌉ model calls instead of one (147k is 7; a production 436k span
would be ~19), checkpoint text 31-37k characters instead of at most 13.8k, and the
calls are serial. Still 147k → ~12k tokens, the ratio lcm-x targets per leaf.

### Corrected — an earlier conclusion of mine

The leaf-chunks experiment that "proved" chunking useless gave every chunk a share
of ONE total budget and concatenated the results, so each piece was starved and the
whole was still bounded by one output ceiling. The variable was never "split or
not"; it was "does each piece own a complete target".

### Fixed — smaller, all found on real runs

- A ceiling the model never reaches: with no `maxTokens` the provider applies its
  own smaller default and truncates silently. Now `max(4096, 2x target)`, because
  reasoning is billed against the same number and measured at roughly half of it.
- The checkpoint follows the SPAN's language, not the instruction's. A Chinese
  instruction produced Chinese checkpoints for English conversations, and the
  answering model mirrored it: `三场` for 3, `六月` for June.
- Facts are typed rows (`subject.predicate = value | kind`) instead of prose. The
  vocabulary is lcm-x's assertion kinds: a count needs its unit and what it counts,
  an ordering needs the events kept apart, a preference needs its polarity.
- The anchor list stays a flat word list. Widening it to hold facts turned it into
  Chinese prose and destroyed the one property it exists for: a string you can
  paste into `lcm_search`.
- An unreachable threshold is a diagnosis, not a failure: when the trigger sits
  below the non-compactable baseline the engine used to throw on every step.

## 0.6.0 — 2026-11-08 — fitted to dsh 0.2.2-rc.1, and one poison found by fitting it
### Fixed — contract defects found by auditing against the installed dsh

Eleven, each with a test that was reverted once to confirm it fails. The one that
mattered most poisoned the harness rather than the summariser:

- **`shadowedTokenCount` carried the ROUTE price** while `dsh-token-meter` uses it
  as a shadow price and subtracts it from heuristic surface totals. Surface
  pressure was therefore permanently under-counted and the compaction threshold
  could never fire. Now split into `shadowedTokenCount` (heuristic) and
  `shadowedRouteTokenCount` (route); the shrink gate compares against the route.
- `compaction/summary` wrote `targetTokens`, which the released event validator
  rejects. The contract name is `maxTokens`; it keeps that name and now carries
  the instruction's target length.
- A summarisation failure threw the provider's frozen plain object, so the
  `instanceof LlmError` check in `dsh-compaction-image-offload` never matched.
- The `compaction/summary-error` waterfall was missing entirely, so the same
  image-offload recovery listener could never fire.
- Peer ranges `^0.2.0` do not accept `0.2.2-rc.1` (prereleases); now `^0.2.2-0`.
- `Config.simplify` silently dropped nine keys the schema never declared, so a
  `fiber.update` round-trip lost `anchorPointers`, `emptySummaryRetries` and all
  seven vector settings.
- `toolHistory` was missing from the summariser request, defeating prefix reuse.
- The `agent/request` model-switch compaction path did not exist; listener count
  is now 5, matching basic.
- Per-model `summarizationProvider`/`Model` were accepted and ignored.
- A non-system `surface[0]` was treated as a system head, so that message appeared
  twice in the summariser input.

### Fixed — the plugin had never compacted in a real session

A real `Session` exposes `log` and `snapshotEvents()`, **not** `events`. Six read
sites assumed the latter and got `undefined`, so the first thing every automatic
compaction did was throw `Cannot read properties of undefined`. The failure is
swallowed by design (`continuing the turn`), so nothing surfaced, and 100 green
tests could not catch it because every fixture had `events`.

Found by booting a profile, not by a test. `sessionEvents()` now resolves
`events -> snapshotEvents() -> log -> []`, and the swallowed failure is written to
the debug log.

### Changed — no completion cap on the summary

`ctx.llm.stream` receives no `maxTokens`; the provider's own default applies.
Reasoning-first backends bill hidden reasoning against the same ceiling, so a
summary-sized cap was spent entirely on thinking and the response finished
`max-tokens` with zero text - a compression that fails for a reason the caller
cannot fix. The instruction still names a target length, because a model told
nothing writes a 400-token stub.

Three failures the cap had been masking, all fixed: the instruction never forbade
tool calls (the request forwards the conversation's tools, so a tool call is a
legal completion, and the model took it three times in a row); a summary longer
than its own span got one retry with the bound restated as a hard rule; and the
min-span guard now requires twice the floor, since at 1.79:1 an ordinary overshoot
trips the shrink gate after paying for the call.

### Changed — a value is not a fact

Across the 15 paired Layer 2 failures (full context answered, the checkpoint did
not), the golds were 7 numeric/time, 6 short prose facts, 2 long prose and **zero
identifiers** - exactly the one category the anchor list collected. Widening the
list is necessary but not sufficient: two failures carried their gold in the anchor
list already and still answered UNKNOWN, because a bare value among 250 does not
say what it counts. The skeleton gains a 用户事实 section for facts as sentences
that carry their value.

### Fixed — an unreachable threshold is not a failure

With the trigger below the non-compactable baseline (system prompt, tool
definitions, retained tail) the engine compacted everything compactable, stayed
above, and threw on every step afterwards. It now distinguishes 'could not get
below' from 'nothing left to compact' and logs a diagnosis in the second case.

### Measured (Layer 2, n=20, LongMemEval_S, judge and answerer disclosed)

| arm | judge | string |
|---|---|---|
| `full-context` (ceiling) | 15/20 = 75% | 8/20 = 40% |
| `basic-oneshot` | 0/19 = 0% | 1/19 = 5% |
| `lcm-oneshot` | 0/20 = 0% | 0/20 = 0% |
| **`lcm-agentic`** | **14/20 = 70%** | **11/20 = 55%** |

Compress-only scores zero for both backends, so the summary axis ties at the
floor. Retrieval takes this package to 70% of a ceiling that is itself only 75%.

## 0.5.1 — 2026-11-08 — the anchor rule stops sacrificing the narrative
### Fixed

- **`ANCHOR_RULE` told the model to cut the four narrative sections before the
  anchor list.** On 20 real questions it complied: one checkpoint was 99.7%
  anchor list with the other four sections **entirely absent**, another 91.3%.
  Those four sections are how a resuming agent knows where it is. The rule now
  requires all four to have content and asks for de-duplication when the anchor
  list grows. Same question, same target: anchors 6.9% → 36.7%, 目标与约束
  6.3% → 20.2%, five sections present, output 866 → 2 620 tokens.

### Added

- `describeError()` in `src/debug.js`. Non-Error throws from the provider and the
  harness rendered as `step compaction failed: [object Object]` in a real run,
  which names nothing an operator can act on. It extracts a message, reason,
  code, name or type, then falls back to JSON.
- The min-span guard now requires **twice** the summary floor. At 1.79:1 an
  ordinary overshoot (span 918, target 512, summary 932) tripped the shrink
  guarantee after paying for the call. Two-to-one leaves room for a normal
  summary.

### Measured (Layer 2, n=20, LongMemEval_S)

| arm | judge | string |
|---|---|---|
| `full-context` (ceiling) | 15/20 = 75% | 8/20 = 40% |
| `basic-oneshot` | 0/19 = 0% | 1/19 = 5% |
| `lcm-oneshot` | 0/20 = 0% | 0/20 = 0% |
| **`lcm-agentic`** | **14/20 = 70%** | **11/20 = 55%** |

Compress-only scores zero for **both** backends, so the summary axis is a tie at
the floor. Retrieval takes this package to 70% — 93% of a ceiling that is itself
75% because the model answers wrong from full context on 4 of 20. `basic` has no
equivalent: its checkpoint carries no `seq` pointers and it ships no recall tool.

Three caveats recorded with the numbers: the oneshot zero is a budget-allocation
defect (now fixed), the agentic string score is depressed by answer-language
drift, and the judge is more lenient on long answers.

## 0.5.0 — 2026-11-08 — the summary request carries no completion cap

### Changed

- **`summarizeLeaf` no longer sends `maxTokens`.** A summary-sized completion
  budget is spent entirely on hidden reasoning by reasoning-first backends, so
  the response finished `max-tokens` with ZERO text and the whole compaction
  failed — measured three times, on three backends. Output length is also not
  predictable enough to cap usefully: the anchor list alone varies by an order of
  magnitude across spans, so every fixed number was either a truncation or dead
  weight. The provider's own default ceiling now applies.
- **The budget in the instruction became a target.** `buildInstruction` still
  names the number ("Aim for roughly N tokens (about R:1) — that is a target, not
  a hard limit"), because a model told the size writes the right size; it is just
  no longer enforced at the wire.
- **`checkpointCap` is no longer a request cap** — it bounds the TARGET only.
  An oversize summary is accepted: the transaction is bounded by the shrink
  guarantee (`framed < shadowed`), which truncation would actively work against
  by cutting the tail of the anchor list.
- Provenance field `maxTokens` → `targetTokens` on the compile result and on
  the durable `compaction/summary` record; `summarizeLeaf` also reports
  `finish`.

### Removed

- **`BUDGET_ESCALATIONS` and the `budget-escalated` path.** Doubling a ceiling
  that is no longer sent has no meaning; a `max-tokens` finish WITHOUT text now
  falls through to `emptySummaryRetries`, which is the correct handling because
  there is no budget left to escalate. `test/budget-escalation.test.js` is
  replaced by `test/no-token-cap.test.js`.

### Kept (deliberately)

- `error`/`aborted` finishes throw immediately.
- A `max-tokens` finish that DID produce text is still deterministic truncation
  and still throws on the first attempt.
- Empty text (no text block at all) is still retried on the same prompt+route.
- The shrink guarantee is untouched: it is the only hard gate on the transaction.

## 0.3.0 — 2026-11-07

Renamed to **`dsh-lcm`**, and the verdict is now backed by the only fidelity
instrument that survived audit. Cost is out of scope by instruction.

### Changed

- Package/dir/repo name `dsh-compaction-lcm` → **`dsh-lcm`**. Row ids unchanged
  (`compaction-lcm`, `tool-lcm-expand`, `command-lcm-search`), so an existing
  profile patch keeps matching.
- `test/compose.test.js` selected the engine row by matching `/compaction/`
  against the package name. After the rename that matched **nothing**, and the
  "exactly one engine is active" assertion passed with `0 !== 1` semantics
  inverted — it was asserting a zero-length list had length one. Now it matches
  the row's `name + id`.

### Measured

Type-grouped verbatim recall (`bench/qa-recall.mjs`), output ceiling 8 000 so
every arm reaches `stop` naturally:

| corpus | span | basic | lcm | ceiling |
|---|---|---|---|---|
| `s` | 4 302 tok | 2/14 = 14.3% | **7/14 = 50.0%** | not measured |
| `c2` | 8 065 tok | 4/24 = 16.7% | **15/24 = 62.5%** | **20/24 = 83.3%** |

lcm reaches **75%** of the model's own reuse ceiling on the same text; basic
reaches 20%.

### Fixed

- `src/summarize.js` said "最后一节「逐字锚点」…先压前面几节" while the skeleton
  had already moved the anchor list to the **first** section. The instruction
  contradicted itself; only the wording was wrong, but it told the model to
  sacrifice exactly the section that carries fidelity.
- A "narration sections ≤ 20 lines" cap was added, measured, and **reverted**:
  it dropped corpus `s` from 7/14 to 3/14 anchors because the model read the cap
  as a cap on the whole reply. `test/lcm.test.js` now asserts the cap's absence.

### Recorded instrument facts (do not re-learn these)

- The same prompt re-run returns **byte-identical** output (gateway cache).
  Three reps of one arm are N=1, not N=3.
- Anchor hits are **not monotonic in the output ceiling**: the `c2` full-span arm
  scored 10/24 at 1 500, 4/24 at 3 000, 20/24 at 8 000. Only same-ceiling
  comparisons and `stop`-naturally absolutes mean anything.
- `lcm` degenerated into a repeated-phrase loop twice at the 8 000 ceiling
  (`finish_reason=error`). Re-running the same arm gave a clean sample with the
  same hit count, so a single call is never a result.

## 0.2.9 — 2026-11-07

Benchmarks no longer go through the agent's MCP transport, and the "equal budget"
claim is now honest about which routes enforce it.

### Added

- `bench/llm.mjs`: direct OpenAI-compatible client with a caller-owned deadline
  (the MCP path capped calls at ~60s, which is why the anchor-enumeration arm had
  zero data) and credentials from the environment or `~/.dsh/.credentials.yaml`.
- `bench/ab-one.mjs`: one arm-rep runner, ability to run **uncapped** (`none`).

### Measured

`max_tokens` is enforced per **route**, not per transport — same request, cap 40:
`best`(glm-5.3) 40, `balanced-lite`(agnes-3.0-flash) 40,
`deepseek-v4-flash-auto` **654**.

Uncapped comparison on corpus s (14 anchors):

| arm | hits | mean | tokens | anchors/1k |
|---|---|---|---|---|
| basic | 5,5,5,5,5 | 5.0 | 2700 | 1.85 |
| lcm | 5,5,5,5 | 5.0 | **2182** | **2.29** |

Same fidelity, ~19% fewer output tokens. With a hard 516-token generation cap:
basic 2.5 vs lcm 3.5 — higher fidelity at the same cost.

Neither direction is worse than the built-in backend. Numbers are on
`balanced-lite` and must not be compared across the `deepseek` tables.

## 0.2.8 — 2026-11-07

The retrieval ranking conclusion was inverted by an instrument bug. Corrected, and
the default flipped.

### Fixed

- **`bench/retrieval.mjs` recorded `index + 2` as the rank** (`rank = hitIndex + 1`
  then `+1` again on write), so recall@1 was structurally 0 for every mode and
  hid the entire advantage of the length-normalised ranking. The same file's
  "NDCG" was a constant copy of recall@10.
- `rank` is now written once, NDCG is a real `1/log2(rank+1)`, and the false claim
  that "the top hit is always outside the span" is gone (it was an artifact).

### Changed

- **Default result order is now `density`**, which wins on the metric that matches
  the actual use — "get me any copy of this fact":

  | log | order | recall@1 | recall@5 | MRR | NDCG@10 |
  |---|---|---|---|---|---|
  | d45c83f5 (21) | seq | 0.381 | 0.952 | 0.581 | 0.673 |
  | | **density** | **0.714** | 0.952 | **0.793** | **0.832** |
  | session-65bd (22) | seq | 0.682 | 0.955 | 0.802 | 0.851 |
  | | **density** | **0.727** | 0.955 | **0.840** | **0.880** |

  `seq` and `score` stay available through the `rank` key.

### Notes

- Under the `gold=first` label density is *worse* (recall@1 0.143 vs 0.381): it
  prefers short events that are entirely about the term over the first passing
  mention. Real callers want any copy, so the default optimises `any`; both sets
  of numbers stay in the report.
- The lesson recorded in bench/REPORT.md §14: one wrong counting rule is enough to
  make the best ordering look like the worst.

## 0.2.7 — 2026-11-07

At equal budget this package was **worse** than the built-in backend. Fixed.

### Fixed

- **The anchor list was the last section, so truncation destroyed it.** A summary
  is routinely cut to fit a budget, and truncation cuts the tail: with the
  anchors last, a budgeted summary kept the narrative and lost exactly the part
  that carries fidelity. Measured at a 516-token ceiling: **0/14 anchors**
  (the built-in backend kept 2/14). Evidence: the truncated text ended at
  `## 逐字锚点\n- /vol3/1000/work/`.
  `SUMMARY_SKELETON` now puts `逐字锚点` first, and the instruction says to cut
  prose, never the list.

### Measured (equal budget, N=4 per arm, temperature 0)

| arm | hits | mean | budgeted tokens |
|---|---|---|---|
| basic | 2, 2, 3, 2 | 16.1% | 494 |
| **lcm** | 3, 4, 4, 2 | **23.2%** | 509 |

Non-inferior at equal cost, and consistently ahead on 3 of 4 runs. Not enough to
claim "better"; enough to hold the "not worse" line.

### Added

- `bench/equal-budget.mjs`: pure scoring (token count, budget truncation,
  anchor scoring) plus a `--score` CLI that re-scores saved text without calling
  a model, so the numbers stay checkable offline.

## 0.2.6 — 2026-11-07

Retrieval quality measured on production data — and a relevance ranking that lost.

### Added

- `bench/retrieval.mjs`: the hard half of recoverability. §7 of the report shows a
  known seq comes back byte-exactly; this shows whether the agent can *find* that
  seq from a string it remembers. Labels are the anchors a real production
  summary dropped; metrics are recall@5/10 and MRR; no model is called.
- `searchSession(..., { rank })` with three orders: `seq` (default), `score`
  (match count), `density` (length-normalised). Exposed as the `rank` key on the
  tool and command rows.
- `test/search-rank.test.js` pins each ordering so a future change cannot
  silently flip the default.

### Measured (21 anchors from a real 436k-token compaction)

| order | recall@5 | recall@10 | MRR |
|---|---|---|---|
| **seq (default)** | **0.905** | **0.952** | 0.335 |
| score | 0.762 | 0.810 | 0.332 |
| density | 0.857 | 0.952 | **0.414** |

A second log (22 anchors): recall@5 0.955, recall@10 1.000.

**The relevance ranking lost.** Raw match count favours long log dumps, not the
answer; length-normalised density improves MRR but still trails on recall@5. The
default stays chronological, and the report records the negative result rather
than shipping a worse order that looked smarter.

### Notes

- recall@1 is 0 under every order: the top hit is always an event outside the
  compacted span (the checkpoint itself contains the string), so @1 is not a
  usable discriminator here. Look at @5 and MRR.
- 54 tests.

## 0.2.5 — 2026-11-07

The original backend's names are kept, not replaced.

### Added

- **`recall` and `search` tools, and `/recall`, are registered alongside
  `lcm_expand` / `lcm_search` / `/lcm-search`.** `dsh-compaction-instant` shipped
  those three names; anything already written against them — agent
  instructions, saved prompts, habit — keeps working after a backend switch.
  Covered by `test/compat.test.js` (5 tests).
- `legacyNames` (default `true`) on the tool and command rows; set it to
  `false` to register only the LCM names.
- `defineRecallTool` / `defineSearchTool` / `defineRecallCommand` take an
  optional name argument, so a deployment can register any alias without
  forking the module.

## 0.2.4 — 2026-11-07

Two more instances of the same off-by-one, and dead code removal.

### Fixed

- **`deriveDag` read `session.events[summary.seq + 1]`**, so on every persisted log
  (header record first, no `seq`) it looked one event past the replacement and
  found nothing: the summary DAG reported zero checkpoints for real sessions.
  Now resolved through `resolveEventAt`. Regression test added.
- Removed an unused `seqToShadowed` map left over from an earlier revision.

### Removed

- `compiler.js`: `excerptToolResult` and `tailTokens` — the last survivors of the
  VCC region compiler, dead since it was replaced by LLM summarization
  (851 → 275 lines across this series).

### Verified

- 44 tests, including three header-shift regressions (recall, search, deriveDag).

## 0.2.3 — 2026-11-07

The engine-level measurement the prompt A/B could not provide, plus a bug it found.

### Measured

`bench/recovery.mjs` runs the shipped `src/recall.js` against a real production
log and answers the only question that distinguishes this backend from a
summarizer-only one:

| | value |
|---|---|
| span | 787 nodes / 436 194 tokens |
| anchors the production summary carried | 3 / 24 (**12.5%**) |
| anchors recovered byte-exactly via recall | 21 / 21 |
| **anchors still obtainable by the model** | **24 / 24 (100%)** |
| permanently lost | 0 |

At 436k tokens no summary can hold everything; a summarizer-only checkpoint stops
at whatever it wrote. This one carries `seq` pointers and a recall guide, so the
remainder is one call away.

### Fixed

- **`session.events[seq]` was off by one on every persisted log.** A session file
  begins with a header record that has no `seq`, so `recall` and `search`
  reported `[seq N: not found in this session]` for real events. New
  `src/events.js` resolves by the event's own `seq`, preferring the session's
  `eventAt` accessor, and both modules now use it.

### Added

- `test/recovery.test.js` — header-shift regression, accessor preference,
  byte-exact projection, and a production-log recovery test with a
  **vacuous-pass guard**: if recall falls back to a raw JSON dump every
  substring matches trivially, so the test requires the real projection.
- 43 tests.
- `bench/REPORT.md` §7 records the measurement and its honest boundary: basic is
  not at zero (dsh ships `session_search`), but its checkpoint never points at it.

## 0.2.2 — 2026-11-07

Two **fatal** bugs found by a test-coverage audit. The engine had never
successfully compacted anything.

### Fixed

- **The positional replacement shape was wrong.** `commitCompactionBody` emitted
  `{op, start, end}`; the harness requires exactly `{op, startSeq, endSeq}`
  (`dsh-session/surface` `isReplaceOp`: three own keys, both non-negative safe
  integers). Every commit therefore threw *after* `compaction/start` and
  `compaction/summary` had landed, stranding an orphan summary, leaving the
  surface unable to shrink, and burning the pressure retry budget until
  "still above threshold". Inherited verbatim from `dsh-compaction-instant`,
  which targets an older harness.
- **`compactNow` referenced an out-of-scope `spec`,** so `/compact` threw
  `ReferenceError` and the catch-all rewrote it as
  `ManualCompactionError("busy")` — manual compaction was 100% broken while
  looking like lock contention. Now follows basic: `retainTokens = 0`.
- `compile()` now returns `maxTokens`, so `compaction/summary` records the
  generation ceiling instead of silently omitting it.

### Added

- `test/region.test.js` — the first tests of the durable transaction. The
  fixture replays every append through the harness's own `foldSurface`, so an
  invalid `surfaceOp` fails in CI instead of in production. Covers: commit
  shape and surface shrinkage, summary→replacement adjacency, start/end
  bracketing, the shrink guard (throws, closes its marker, records a string
  error), compile-failure lock release with no orphan summary, tool-pair-safe
  cuts, system-head exclusion, and a full `compactNow` round trip.
- 38 tests total.

## 0.2.1 — 2026-11-07

Round 2: independent audit fixes and a retracted benchmark.

### Fixed (configuration parity — found by an independent line-by-line audit)

- **D1** `static Config` did not declare `headroomTokens` or `maxTokens`, so both
  were invisible to settings and one strict-loader release away from being
  rejected as unknown keys.
- **D2** `resolveCompactSpec` defaulted the routed output reservation to 0 and
  the caller never passed it. Basic reserves `header.config.maxTokens ??
  adapterDefault`, so the threshold fired up to `O` tokens late and the
  retained tail was computed from the whole window instead of the message
  budget. Now reproduced exactly (verified against three audit-derived points:
  W=128000/O=8192 → 54272/19169, W=200000/O=8192 → 126272/30689,
  W=1000000/O=16384 → 800000/157378).
- **D3** an explicit `maxTokens` no longer caps the summary. Basic treats it as
  the summarizer's output ceiling; this backend derived the budget from
  `summaryRatio` alone, so a config that set `maxTokens: 4096` to bound spend
  silently inherited the larger `checkpointCap`. The budget is now
  `min(scaled, maxTokens)`.

### Changed (benchmark credibility)

- `bench/anchors.mjs`: anchors are de-nested (only maximal survive), balanced
  across types (≤35% each), and deduplicated by fact. The v1 set was **100%
  file paths** and gameable — nine literals scored 24/24.
- `bench/REPORT.md` v2 retracts six v1 claims: the six-type anchor coverage,
  the "random sampling", the cost-parity figure (95% CI −40%…+44%, p≈0.90), the
  "0.98× fewer" sign, the claim that an engine was compared at all, and the
  assumption that `max_tokens` was honoured.
- README no longer claims a measured win. It states what is verified (config
  drop-in), what is under test (the anchor clause, 3-arm ablation), and what was
  never done (comparing the two engines).

### Verified

- 32 tests, including three audit-derived budget points and a static-Config key
  declaration check.
- `test/compose.test.js`: the bundle patch composes to exactly one active
  engine.

## 0.2.0 — 2026-11-07

Full configuration parity with `@deepseek-ai/dsh-compaction-basic`, plus a
measured fidelity win over it.

### Added

- `src/config.js` — the complete basic parameter surface with identical
  defaults and basic's exact budget math, as its own module:

  | key | default | meaning |
  |---|---|---|
  | `thresholdRatio` | 0.8 | pressure fraction |
  | `headroomTokens` | 65536 | reserved completion capacity |
  | `retainRatio` | 0.16 | verbatim tail fraction (mutually exclusive with `retainTokens`) |
  | `retainTokens` | — | absolute tail budget |
  | `summarizationProvider` / `summarizationModel` | "" | override the summarizer route |
  | `maxTokens` | = headroomTokens | summary output ceiling |
  | `compactionRetries` / `maxOverflowRetries` | 1 / 1 | retry policy |
  | `modelPolicies` | [] | exact provider/model overrides |
  | `auto` | true | automatic compaction |

  Plus LCM-only `summaryRatio` (0.12), `summaryFloorTokens` (512),
  `checkpointCap` (16384), `debug`, `debugLogPath`.
- `config.example.yaml` — annotated full surface.
- `bench/` — real-span extractor, A/B report, raw results.
- `test/compose.test.js` — proves the bundle patch composes to exactly one
  active engine (basic disabled, `/compact` preserved, tools mounted).
- 29 tests total, incl. a differential parity matrix over
  W∈{32K,128K,200K,1M} × O∈{0,8K,64K}.

### Changed

- **Anchors are now an enumerated section, not a prose request.** Measured on a
  real 9 075-token production span (N=5, temperature 0): verbatim anchor
  retention went 40% → **74.2%**, against basic's 51.7%, at 1.02× the token
  cost. See `bench/REPORT.md`.
- `region.selectCompactableRange` replaced with basic's exact rule
  (system-head exclusion, tail-by-tokens, tool-pair balance) so switching
  backends compacts the same span for the same tokens.
- Retention is expressed as basic's `retainRatio`/`retainTokens` pair; the
  instant-only `retainTurns` concept is gone.
- `engineDebug` now appends to the configured `debugLogPath` instead of only
  writing to stderr.

### Removed

- Dead turn-selection helpers, the VCC region compiler (851 → 326 lines), the
  browser settings card, and the settings-section scaffolding.

## 0.1.0 — 2026-11-07

First working cut: LLM leaf summarization over the durable dsh compaction
protocol, `lcm_expand` / `lcm_search`, log-derived summary DAG.