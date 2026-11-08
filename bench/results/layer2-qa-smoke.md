# LongMemEval_S - Layer 2 judged QA accuracy (dsh-lcm)

Generated 2026-11-07T17:24:52.947Z by `bench/layer2-qa.mjs`.

- **n = 5** questions (of 500 in the split), head `--limit 5`. Same questions for every arm.
- **Answerer model: `balanced-lite`** (resolved `n/a`).
- **Judge model: `deepseek-v4-flash-auto`** (resolved `deepseek-v4.1-flash-1017`). Distinct from the answerer.
- Dataset: LongMemEval_S, revision `2ec2a557f339b6c0369619b1ed5793734cc87533`, sha256 `08d8dad4be43ee20`…
- Type mix in this slice: {"single-session-user":5}
- Wall clock: 2061s total, strictly sequential (the gateway returned empty content on 4 of 6 parallel calls, so no arm is parallelised).

## Results

| arm | n | judge CORRECT | string CORRECT | mean tokens/question | mean seconds/question |
|---|---|---|---|---|---|
| full-context | 5 | 3/5 (0.600) | 5/5 (1.000) | 108943 | 34.9 |
| basic-oneshot | 5 | 0/5 (0.000) | 0/5 (0.000) | 114627 | 107.1 |
| lcm-oneshot | 3 | 0/3 (0.000) | 0/3 (0.000) | 117611 | 77.0 |
| lcm-agentic | 4 | 2/4 (0.500) | 3/4 (0.750) | 134274 | 54.5 |

Two graders on purpose. The model judge accepts paraphrase; the string grader is exact normalized containment and never calls a model, so it is 100% reproducible and is the floor. Neither is cherry-picked.

## Context size per arm

| arm | mean haystack est-tokens | mean context est-tokens given to the answerer | mean prompt tokens (API) | truncation |
|---|---|---|---|---|
| full-context | 150469 | 150469 | 107512 | none (cap disabled) |
| basic-oneshot | 150469 | 1230 | 110886 | none (cap disabled) |
| lcm-oneshot | 150803 | 1648 | 112220 | none (cap disabled) |
| lcm-agentic | 150880 | 2692 | 129096 | none (cap disabled) |

## lcm-agentic tool usage

| question | tool calls | sequence |
|---|---|---|
| e47becba | 1 | lcm_search({"pattern":"degree"})→710ch |
| 118b2229 | 2 | lcm_search({"pattern":"commute\|commuting\|commuted"})→2754ch → lcm_expand({"id":"338-350","type":"seq"})→13563ch |
| 51a45a95 | 5 | lcm_search({"pattern":"creamer\|coupon"})→4425ch → lcm_expand({"id":"440-448","type":"seq"})→7813ch → lcm_search({})→57ch → lcm_search({"pattern":"Target\|Cartwheel\|Sunday"})→12916ch → lcm_expand({"id":"444-446","type":"seq"})→1474ch |
| 1e043500 | 1 | lcm_search({"pattern":"Spotify\|playlist"})→1609ch |

## Failed questions

| arm | question_id | type | why |
|---|---|---|---|
| full-context | 118b2229 | single-session-user | judge output unparseable:  |
| full-context | 51a45a95 | single-session-user | judge output unparseable:  |
| basic-oneshot | e47becba | single-session-user | model answered UNKNOWN |
| basic-oneshot | 118b2229 | single-session-user | model answered UNKNOWN |
| basic-oneshot | 51a45a95 | single-session-user | model answered UNKNOWN |
| basic-oneshot | 58bf7951 | single-session-user | model answered UNKNOWN |
| basic-oneshot | 1e043500 | single-session-user | model answered UNKNOWN |
| lcm-oneshot | e47becba | single-session-user | model answered UNKNOWN |
| lcm-oneshot | 118b2229 | single-session-user | arm error: fetch failed |
| lcm-oneshot | 51a45a95 | single-session-user | model answered UNKNOWN |
| lcm-oneshot | 58bf7951 | single-session-user | arm error: fetch failed |
| lcm-oneshot | 1e043500 | single-session-user | model answered UNKNOWN |
| lcm-agentic | e47becba | single-session-user | judge output unparseable:  |
| lcm-agentic | 51a45a95 | single-session-user | judge output unparseable:  |
| lcm-agentic | 58bf7951 | single-session-user | arm error: fetch failed |

## Boundaries (read before quoting any number)

1. Not an official LongMemEval leaderboard number: this harness is a reimplementation, not the electricsheephq/memorybench-benchmark-tool fork METHODOLOGY.md names, and it does not run LongMemEval's per-question-type judge prompts (getJudgePromptForType). It runs one loose, uniform CORRECT/WRONG judge.
2. Judge is not gpt-4o, so the judged numbers are directional until a judge-parity rerun.
3. Dataset is LongMemEval_S, revision 2ec2a557f339b6c0369619b1ed5793734cc87533, head slice of the file (the split is grouped by question_type), not the full 500.
4. The string grader is exact normalized containment. Gold answers are short entities (median 11 chars), so it is the reproducible floor and systematically under-credits paraphrase.
5. Compression is a single-shot call over the whole haystack; the production engine compacts incrementally over a growing window, so this arm is a lower bound on production fidelity.
6. full-context is a ceiling arm, not a product configuration: it feeds the entire haystack uncompressed.
