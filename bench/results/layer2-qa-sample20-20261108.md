# LongMemEval_S - Layer 2 judged QA accuracy (dsh-lcm)

Generated 2026-11-08T02:53:20.841Z by `bench/layer2-qa.mjs`.

- **n = 20** questions (of 500 in the split), even stride `--sample 20`. Same questions for every arm.
- **Answerer model: `balanced-lite`** (resolved `n/a`).
- **Judge model: `deepseek-v4-flash-auto`** (resolved `deepseek-v4.1-flash-1017`). Distinct from the answerer.
- Dataset: LongMemEval_S, revision `2ec2a557f339b6c0369619b1ed5793734cc87533`, sha256 `08d8dad4be43ee20`…
- Type mix in this slice: {"single-session-user":3,"multi-session":6,"single-session-preference":1,"temporal-reasoning":5,"knowledge-update":3,"single-session-assistant":2}
- Wall clock: 9316s total, strictly sequential (the gateway returned empty content on 4 of 6 parallel calls, so no arm is parallelised).

## Results

| arm | n (scored) | judge CORRECT | string CORRECT | judge failed | arm errors | mean tokens/question | mean seconds/question |
|---|---|---|---|---|---|---|---|
| full-context | 20 | 15/20 (0.750) | 8/20 (0.400) | 0 | 0 | 109350 | 91.6 |
| basic-oneshot | 19 | 0/19 (0.000) | 1/19 (0.053) | 0 | 1 | 114618 | 87.4 |
| lcm-oneshot | 20 | 0/20 (0.000) | 0/20 (0.000) | 0 | 0 | 121465 | 84.0 |
| lcm-agentic | 20 | 14/20 (0.700) | 11/20 (0.550) | 0 | 0 | 135354 | 54.6 |

Denominator: a question counts only when the arm ran AND the judge returned a verdict. A grader that returned empty or unparseable text after 3 attempts is a **grader failure**, excluded from n and reported in its own column; counting it as WRONG would understate the arm.

Two graders on purpose. The model judge accepts paraphrase; the string grader is exact normalized containment and never calls a model, so it is 100% reproducible and is the floor. Neither is cherry-picked.

## Compression: budget vs what the model actually wrote

| arm | question | haystack est-tokens | budget (max_tokens) | ratio asked in instruction | checkpoint chars | checkpoint est-tokens | finish_reason |
|---|---|---|---|---|---|---|---|
| basic-oneshot | e47becba | 148023 | 16384 | 9 | 4201 | 1261 | stop |
| basic-oneshot | 95bcc1c8 | 150425 | 16384 | 9.2 | 8062 | 2419 | stop |
| basic-oneshot | 76d63226 | 147839 | 16384 | 9 | 1908 | 573 | stop |
| basic-oneshot | 3a704032 | 149538 | 16384 | 9.1 | 3185 | 956 | stop |
| basic-oneshot | 81507db6 | 154158 | 16384 | 9.4 | 3452 | 1036 | stop |
| basic-oneshot | 505af2f5 | 148599 | 16384 | 9.1 | 2808 | 843 | stop |
| basic-oneshot | 6456829e | 149485 | 16384 | 9.1 | 1726 | 518 | stop |
| basic-oneshot | 0ea62687 | 148414 | 16384 | 9.1 | 10576 | 3173 | stop |
| basic-oneshot | efc3f7c2 | 149156 | 16384 | 9.1 | 1798 | 540 | stop |
| basic-oneshot | gpt4_18c2b244 | 155501 | 16384 | 9.5 | 5379 | 1614 | stop |
| basic-oneshot | gpt4_98f46fc6 | 152055 | 16384 | 9.3 | 8154 | 2447 | stop |
| basic-oneshot | 4dfccbf8 | 150891 | 16384 | 9.2 | 6041 | 1813 | stop |
| basic-oneshot | 982b5123 | 152306 | 16384 | 9.3 | 1481 | 445 | stop |
| basic-oneshot | 6613b389 | 150412 | 16384 | 9.2 | 3310 | 993 | stop |
| basic-oneshot | 9ea5eabc | 143760 | 16384 | 8.8 | 4254 | 1277 | stop |
| basic-oneshot | e61a7584 | 150575 | 16384 | 9.2 | 1061 | 319 | stop |
| basic-oneshot | 06db6396 | 151152 | 16384 | 9.2 | 6320 | 1896 | stop |
| basic-oneshot | 7e00a6cb | 147887 | 16384 | 9 | 2682 | 805 | stop |
| basic-oneshot | e3fc4d6e | 151842 | 16384 | 9.3 | 1994 | 599 | stop |
| lcm-oneshot | e47becba | 148023 | 16384 | 9 | 4839 | 1669 | stop |
| lcm-oneshot | 95bcc1c8 | 150425 | 16384 | 9.2 | 19124 | 5994 | stop |
| lcm-oneshot | 76d63226 | 147839 | 16384 | 9 | 3298 | 2081 | stop |
| lcm-oneshot | 3a704032 | 149538 | 16384 | 9.1 | 7424 | 2361 | stop |
| lcm-oneshot | 00ca467f | 151708 | 16384 | 9.3 | 4840 | 1732 | stop |
| lcm-oneshot | 81507db6 | 154158 | 16384 | 9.4 | 3820 | 1152 | stop |
| lcm-oneshot | 505af2f5 | 148599 | 16384 | 9.1 | 4048 | 1905 | stop |
| lcm-oneshot | 6456829e | 149485 | 16384 | 9.1 | 3931 | 1854 | stop |
| lcm-oneshot | 0ea62687 | 148414 | 16384 | 9.1 | 11060 | 3825 | stop |
| lcm-oneshot | efc3f7c2 | 149156 | 16384 | 9.1 | 14335 | 4630 | stop |
| lcm-oneshot | gpt4_18c2b244 | 155501 | 16384 | 9.5 | 14578 | 5669 | stop |
| lcm-oneshot | gpt4_98f46fc6 | 152055 | 16384 | 9.3 | 4910 | 1493 | stop |
| lcm-oneshot | 4dfccbf8 | 150891 | 16384 | 9.2 | 4723 | 2882 | stop |
| lcm-oneshot | 982b5123 | 152306 | 16384 | 9.3 | 14079 | 4546 | stop |
| lcm-oneshot | 6613b389 | 150412 | 16384 | 9.2 | 6732 | 2649 | stop |
| lcm-oneshot | 9ea5eabc | 143760 | 16384 | 8.8 | 16659 | 5179 | stop |
| lcm-oneshot | e61a7584 | 150575 | 16384 | 9.2 | 9749 | 3526 | stop |
| lcm-oneshot | 06db6396 | 151152 | 16384 | 9.2 | 9804 | 2951 | stop |
| lcm-oneshot | 7e00a6cb | 147887 | 16384 | 9 | 14994 | 4504 | stop |
| lcm-oneshot | e3fc4d6e | 151842 | 16384 | 9.3 | 11758 | 3769 | stop |
| lcm-agentic | e47becba | 148023 | 16384 | 9 | 4839 | 1669 | stop |
| lcm-agentic | 95bcc1c8 | 150425 | 16384 | 9.2 | 19124 | 5994 | stop |
| lcm-agentic | 76d63226 | 147839 | 16384 | 9 | 4982 | 1668 | stop |
| lcm-agentic | 3a704032 | 149538 | 16384 | 9.1 | 3921 | 1178 | stop |
| lcm-agentic | 00ca467f | 151708 | 16384 | 9.3 | 4840 | 1732 | stop |
| lcm-agentic | 81507db6 | 154158 | 16384 | 9.4 | 8604 | 2718 | stop |
| lcm-agentic | 505af2f5 | 148599 | 16384 | 9.1 | 4048 | 1905 | stop |
| lcm-agentic | 6456829e | 149485 | 16384 | 9.1 | 3931 | 1854 | stop |
| lcm-agentic | 0ea62687 | 148414 | 16384 | 9.1 | 11060 | 3825 | stop |
| lcm-agentic | efc3f7c2 | 149156 | 16384 | 9.1 | 14335 | 4630 | stop |
| lcm-agentic | gpt4_18c2b244 | 155501 | 16384 | 9.5 | 14578 | 5669 | stop |
| lcm-agentic | gpt4_98f46fc6 | 152055 | 16384 | 9.3 | 4910 | 1493 | stop |
| lcm-agentic | 4dfccbf8 | 150891 | 16384 | 9.2 | 19463 | 5847 | stop |
| lcm-agentic | 982b5123 | 152306 | 16384 | 9.3 | 14079 | 4546 | stop |
| lcm-agentic | 6613b389 | 150412 | 16384 | 9.2 | 6732 | 2649 | stop |
| lcm-agentic | 9ea5eabc | 143760 | 16384 | 8.8 | 16659 | 5179 | stop |
| lcm-agentic | e61a7584 | 150575 | 16384 | 9.2 | 9749 | 3526 | stop |
| lcm-agentic | 06db6396 | 151152 | 16384 | 9.2 | 9804 | 2951 | stop |
| lcm-agentic | 7e00a6cb | 147887 | 16384 | 9 | 14994 | 4504 | stop |
| lcm-agentic | e3fc4d6e | 151842 | 16384 | 9.3 | 4468 | 1732 | stop |

`ratio asked` is haystack/budget, i.e. what the instruction told the model to hit. When the checkpoint is far smaller than the budget, the model self-limited: the budget was available and unused, so the effective ratio is worse than the one requested.

## Context size per arm

| arm | mean haystack est-tokens | mean context est-tokens given to the answerer | mean prompt tokens (API) | truncation |
|---|---|---|---|---|
| full-context | 150186 | 150186 | 107882 | none (cap disabled) |
| basic-oneshot | 150106 | 1238 | 111251 | none (cap disabled) |
| lcm-oneshot | 150186 | 3219 | 115001 | none (cap disabled) |
| lcm-agentic | 150186 | 3263 | 128524 | none (cap disabled) |

## lcm-agentic tool usage

| question | tool calls | sequence |
|---|---|---|
| e47becba | 1 | lcm_search({"pattern":"graduate\|degree"})→719ch |
| 95bcc1c8 | 2 | lcm_search({"pattern":"open mic\|amateur comedian"})→1242ch → lcm_expand({"id":"92","type":"seq"})→355ch |
| 76d63226 | 1 | lcm_search({"pattern":"Samsung TV\|55-inch\|laptop/TV"})→538ch |
| 3a704032 | 4 | lcm_search({"pattern":"plant"})→17576ch → lcm_search({"pattern":"acquir\|bought\|purchase"})→8582ch → lcm_search({"pattern":"month"})→5851ch → lcm_expand({"type":"seq","id":"8,167,175,16,349,405,363,292,407,412,129,13,192,19)→27227ch |
| 00ca467f | 3 | lcm_search({"pattern":"doctor\|appointment\|March"})→6190ch → lcm_search({"pattern":"March 15th"})→412ch → lcm_search({"pattern":"appointment"})→2430ch |
| 81507db6 | 1 | lcm_search({"pattern":"graduation\|ceremony\|commencement\|degree\|diploma\|convocatio)→6096ch |
| 505af2f5 | 3 | lcm_search({"pattern":"coffee\|creamer"})→9021ch → lcm_expand({"type":"seq","id":"80"})→2539ch → lcm_expand({"type":"seq","id":"79"})→220ch |
| 6456829e | 6 | lcm_search({"pattern":"tomato\|cucumber"})→17595ch → lcm_search({"pattern":"initially\|started with\|planted\|seedlings"})→5468ch → lcm_expand({"id":"430-445","type":"seq"})→15818ch → lcm_expand({"id":"395-410","type":"seq"})→16816ch → lcm_search({"pattern":"tomato plants\|plants that\|my garden\|raised bed"})→9778ch → lcm_search({"pattern":"initially\|5 tomato\|3 cucumber\|plants initially"})→1347ch |
| 0ea62687 | 1 | lcm_search({"pattern":"miles per gallon"})→1656ch |
| efc3f7c2 | 1 | lcm_search({"pattern":"Friday\|wake up\|6:30"})→2158ch |
| gpt4_18c2b244 | 2 | lcm_search({"pattern":"ShopRite\|Ibotta\|Walmart"})→10735ch → lcm_expand({"type":"seq","id":"281-287,403-415"})→21936ch |
| gpt4_98f46fc6 | 2 | lcm_search({"pattern":"charity gala"})→1205ch → lcm_search({"pattern":"bake sale"})→3137ch |
| 4dfccbf8 | 2 | lcm_search({"pattern":"Rachel\|Wednesday"})→1584ch → lcm_expand({"type":"seq","id":"403,404,405,406"})→6604ch |
| 982b5123 | 2 | lcm_search({"pattern":"Airbnb"})→3622ch → lcm_expand({"type":"seq","id":"241"})→301ch |
| 6613b389 | 1 | lcm_search({"pattern":"anniversary\|engaged"})→4356ch |
| 9ea5eabc | 2 | lcm_search({"pattern":"family"})→10115ch → lcm_search({"pattern":"family trip to"})→1304ch |
| e61a7584 | 1 | lcm_search({"pattern":"Luna"})→17470ch |
| 06db6396 | 2 | lcm_search({"pattern":"painting class"})→1119ch → lcm_search({"pattern":"completed.*project"})→826ch |
| 7e00a6cb | 1 | lcm_search({"pattern":"Amsterdam\|hostel\|Red Light"})→3712ch |
| e3fc4d6e | 2 | lcm_search({"pattern":"Livermore\|fusion"})→5318ch → lcm_search({"pattern":"Chief Advisor\|Science and Technology"})→1525ch |

## Failed questions

| arm | question_id | type | why |
|---|---|---|---|
| full-context | 3a704032 | multi-session | answered "2 plants." vs gold "3" |
| full-context | 4dfccbf8 | temporal-reasoning | model answered UNKNOWN |
| full-context | 982b5123 | temporal-reasoning | model answered UNKNOWN |
| full-context | 9ea5eabc | knowledge-update | answered "Hawaii" vs gold "Paris" |
| full-context | e61a7584 | knowledge-update | answered "About 6 months." vs gold "9 months" |
| basic-oneshot | e47becba | single-session-user | model answered UNKNOWN |
| basic-oneshot | 95bcc1c8 | single-session-user | model answered UNKNOWN |
| basic-oneshot | 76d63226 | single-session-user | answered "UNKNOWN." vs gold "55-inch" |
| basic-oneshot | 3a704032 | multi-session | model answered UNKNOWN |
| basic-oneshot | 00ca467f | multi-session | arm error: gateway 400: {"error":{"message":"Agent2API/sn-deepseek-v4-1-flash-1017: model — [400]: 上游返回 400: Inappropriate input/output rejected for security reasons (HTTP |
| basic-oneshot | 81507db6 | multi-session | model answered UNKNOWN |
| basic-oneshot | 505af2f5 | single-session-preference | answered "Try coffee creamer with oat milk, cinnamon, cocoa nibs, and hemp seeds." vs gold "The user would prefer responses that suggest variations on their existing almond milk, van" |
| basic-oneshot | 6456829e | multi-session | model answered UNKNOWN |
| basic-oneshot | 0ea62687 | multi-session | answered "No specific past MPG value recorded, just target 30 MPG and current 28 MPG. UNKNOWN." vs gold "2" |
| basic-oneshot | efc3f7c2 | multi-session | model answered UNKNOWN |
| basic-oneshot | gpt4_18c2b244 | temporal-reasoning | model answered UNKNOWN |
| basic-oneshot | gpt4_98f46fc6 | temporal-reasoning | model answered UNKNOWN |
| basic-oneshot | 4dfccbf8 | temporal-reasoning | model answered UNKNOWN |
| basic-oneshot | 982b5123 | temporal-reasoning | model answered UNKNOWN |
| basic-oneshot | 6613b389 | temporal-reasoning | model answered UNKNOWN |
| basic-oneshot | 9ea5eabc | knowledge-update | model answered UNKNOWN |
| basic-oneshot | e61a7584 | knowledge-update | model answered UNKNOWN |
| basic-oneshot | 06db6396 | knowledge-update | model answered UNKNOWN |
| basic-oneshot | 7e00a6cb | single-session-assistant | model answered UNKNOWN |
| basic-oneshot | e3fc4d6e | single-session-assistant | model answered UNKNOWN |
| lcm-oneshot | e47becba | single-session-user | model answered UNKNOWN |
| lcm-oneshot | 95bcc1c8 | single-session-user | model answered UNKNOWN |
| lcm-oneshot | 76d63226 | single-session-user | model answered UNKNOWN |
| lcm-oneshot | 3a704032 | multi-session | model answered UNKNOWN |
| lcm-oneshot | 00ca467f | multi-session | model answered UNKNOWN |
| lcm-oneshot | 81507db6 | multi-session | model answered UNKNOWN |
| lcm-oneshot | 505af2f5 | single-session-preference | model answered UNKNOWN |
| lcm-oneshot | 6456829e | multi-session | model answered UNKNOWN |
| lcm-oneshot | 0ea62687 | multi-session | model answered UNKNOWN |
| lcm-oneshot | efc3f7c2 | multi-session | model answered UNKNOWN |
| lcm-oneshot | gpt4_18c2b244 | temporal-reasoning | model answered UNKNOWN |
| lcm-oneshot | gpt4_98f46fc6 | temporal-reasoning | model answered UNKNOWN |
| lcm-oneshot | 4dfccbf8 | temporal-reasoning | model answered UNKNOWN |
| lcm-oneshot | 982b5123 | temporal-reasoning | model answered UNKNOWN |
| lcm-oneshot | 6613b389 | temporal-reasoning | model answered UNKNOWN |
| lcm-oneshot | 9ea5eabc | knowledge-update | model answered UNKNOWN |
| lcm-oneshot | e61a7584 | knowledge-update | model answered UNKNOWN |
| lcm-oneshot | 06db6396 | knowledge-update | model answered UNKNOWN |
| lcm-oneshot | 7e00a6cb | single-session-assistant | answered "ClinkNOORD" vs gold "International Budget Hostel" |
| lcm-oneshot | e3fc4d6e | single-session-assistant | model answered UNKNOWN |
| lcm-agentic | 3a704032 | multi-session | answered "2 个植物。" vs gold "3" |
| lcm-agentic | 00ca467f | multi-session | answered "You went to 3 doctor's appointments in March." vs gold "2" |
| lcm-agentic | 6456829e | multi-session | answered "[no final answer within 6 steps]" vs gold "8" |
| lcm-agentic | gpt4_18c2b244 | temporal-reasoning | answered "I used a Buy One Get One Free coupon on Luvs diapers at Walmart, I signed up for the rewar…" vs gold "First, I used a Buy One Get One Free coupon on Luvs diapers at Walmart. Then, I redeemed $" |
| lcm-agentic | 4dfccbf8 | temporal-reasoning | answered "此事未載。檢遍全錄，僅有二處言及 Rachel： - 其一，群組成員 Rachel，於 3 月 1 日會後就數據分析部分建議用混合方法（burke et al. 2010）。 - …" vs gold "I started taking ukulele lessons with Rachel." |
| lcm-agentic | 982b5123 | temporal-reasoning | answered "<tool_calls:6124c78e><tool_call:6124c78e>" vs gold "Five months ago" |

## Boundaries (read before quoting any number)

1. Not an official LongMemEval leaderboard number: this harness is a reimplementation, not the electricsheephq/memorybench-benchmark-tool fork METHODOLOGY.md names, and it does not run LongMemEval's per-question-type judge prompts (getJudgePromptForType). It runs one loose, uniform CORRECT/WRONG judge.
2. Judge is not gpt-4o, so the judged numbers are directional until a judge-parity rerun.
3. Dataset is LongMemEval_S, revision 2ec2a557f339b6c0369619b1ed5793734cc87533, head slice of the file (the split is grouped by question_type), not the full 500.
4. The string grader is exact normalized containment. Gold answers are short entities (median 11 chars), so it is the reproducible floor and systematically under-credits paraphrase.
5. Compression is a single-shot call over the whole haystack; the production engine compacts incrementally over a growing window, so this arm is a lower bound on production fidelity.
6. full-context is a ceiling arm, not a product configuration: it feeds the entire haystack uncompressed.
