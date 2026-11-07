# Changelog

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