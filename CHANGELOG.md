# Changelog

## 0.1.0 — 2026-11-07

First working cut. Forked from `dsh-compaction-instant@0.1.4` and converted from a
deterministic compiler into an LLM leaf summarizer.

### Added

- `src/summarize.js` — the LLM leaf summarizer. Structured section skeleton
  (目标与约束 / 已完成 / 关键事实 / 未决问题 / 下一步), an explicit verbatim-anchor
  rule for paths, commands, URLs, error strings, IDs and numeric thresholds, and
  a stated compression target so the model knows how hard to compress.
- `deriveDag()` — checkpoint depth reconstructed from `compaction/summary`
  events and their replacement messages. No side store, rebuildable after any
  restart.
- `maxAbsorbedDepth()` — folds a prior checkpoint's depth into the instruction
  so a multi-level condensation stays coherent.
- `lcm_expand` / `lcm_search` tools and `/lcm-search` command (renamed from
  `recall` / `search` / `/recall`).
- 18 unit tests covering config resolution, budget clamping, instruction
  content, DAG derivation, and the compile hook against a stub LLM.

### Changed

- `compile()` now calls the model instead of the deterministic compiler; it
  emits exactly one `checkpoint` entry.
- Config surface reduced to what an LLM backend actually uses:
  `summaryRatio` / `summaryFloorTokens` / `checkpointCap` replace the compiler's
  per-block budgets (`textTokens`, `toolArgTools`, `hideTools`, `noisePatterns`, …).
- Summary budget is `clamp(shadowed × summaryRatio, floor, cap)` so the ratio is
  stable across context-window sizes instead of collapsing on a large span.
- `compaction/summary` now records `maxTokens`, `usage` and `rawOutput`, so the
  summarization spend is auditable from the log alone.

### Fixed

- `isCheckpointSource` matched the wrong source shape
  (`{kind:"plugin",plugin:"compact"}`). dsh 0.2.2 brands checkpoints as
  `{kind:"compact-checkpoint",compactionId}`; the old predicate silently
  returned false for every real checkpoint.

### Removed

- The VCC region compiler (851 → 326 lines) — unused once the summary comes from
  a model. Only the tokenizer, sanitizer, budget truncation, projection and
  checkpoint framing survive.
- The browser settings card (`src/client.js`). dsh 0.2.2 exposes no
  `installSettingsSection` seam, so the card had nothing to bind to.
- `pickSettingsFields`, `_installSettingsSection`, `_reloadConfig` — dead once
  the settings namespace was dropped.
