# LongMemEval_S - Layer 2 judged QA accuracy (dsh-lcm)

Generated 2026-11-08T00:17:38.569Z by `bench/layer2-qa.mjs`.

- **n = 1** questions (of 500 in the split), head `--limit 1`. Same questions for every arm.
- **Answerer model: `balanced-lite`** (resolved `n/a`).
- **Judge model: `deepseek-v4-flash-auto`** (resolved `deepseek-v4.1-flash-1017`). Distinct from the answerer.
- Dataset: LongMemEval_S, revision `2ec2a557f339b6c0369619b1ed5793734cc87533`, sha256 `08d8dad4be43ee20`…
- Type mix in this slice: {"single-session-user":1}
- Wall clock: 71s total, strictly sequential (the gateway returned empty content on 4 of 6 parallel calls, so no arm is parallelised).

## Results

| arm | n (scored) | judge CORRECT | string CORRECT | judge failed | arm errors | mean tokens/question | mean seconds/question |
|---|---|---|---|---|---|---|---|
| lcm-agentic | 1 | 1/1 (1.000) | 1/1 (1.000) | 0 | 0 | 120672 | 71.3 |

Denominator: a question counts only when the arm ran AND the judge returned a verdict. A grader that returned empty or unparseable text after 3 attempts is a **grader failure**, excluded from n and reported in its own column; counting it as WRONG would understate the arm.

Two graders on purpose. The model judge accepts paraphrase; the string grader is exact normalized containment and never calls a model, so it is 100% reproducible and is the floor. Neither is cherry-picked.

## Compression: budget vs what the model actually wrote

| arm | question | haystack est-tokens | budget (max_tokens) | ratio asked in instruction | checkpoint chars | checkpoint est-tokens | finish_reason |
|---|---|---|---|---|---|---|---|
| lcm-agentic | e47becba | 148023 | 16384 | 9 | 4839 | 1669 | stop |

`ratio asked` is haystack/budget, i.e. what the instruction told the model to hit. When the checkpoint is far smaller than the budget, the model self-limited: the budget was available and unused, so the effective ratio is worse than the one requested.

## Context size per arm

| arm | mean haystack est-tokens | mean context est-tokens given to the answerer | mean prompt tokens (API) | truncation |
|---|---|---|---|---|
| lcm-agentic | 148023 | 1669 | 117160 | none (cap disabled) |

## lcm-agentic tool usage

| question | tool calls | sequence |
|---|---|---|
| e47becba | 1 | lcm_search({"pattern":"graduate\|degree"})→719ch |

## Failed questions

None: every arm answered every question correctly under both graders.

## Boundaries (read before quoting any number)

1. Not an official LongMemEval leaderboard number: this harness is a reimplementation, not the electricsheephq/memorybench-benchmark-tool fork METHODOLOGY.md names, and it does not run LongMemEval's per-question-type judge prompts (getJudgePromptForType). It runs one loose, uniform CORRECT/WRONG judge.
2. Judge is not gpt-4o, so the judged numbers are directional until a judge-parity rerun.
3. Dataset is LongMemEval_S, revision 2ec2a557f339b6c0369619b1ed5793734cc87533, head slice of the file (the split is grouped by question_type), not the full 500.
4. The string grader is exact normalized containment. Gold answers are short entities (median 11 chars), so it is the reproducible floor and systematically under-credits paraphrase.
5. Compression is a single-shot call over the whole haystack; the production engine compacts incrementally over a growing window, so this arm is a lower bound on production fidelity.
6. full-context is a ceiling arm, not a product configuration: it feeds the entire haystack uncompressed.
