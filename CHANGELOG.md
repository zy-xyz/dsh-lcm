# Changelog

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