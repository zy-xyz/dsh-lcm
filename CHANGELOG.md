# Changelog

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
