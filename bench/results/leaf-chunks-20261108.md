# Leaf summary shape at one budget - whole span vs session-chunked

Generated 2026-11-08T01:04:35.724Z by `bench/leaf-chunks.mjs`. Model: `balanced-lite`. Same compressor, same total ceiling in both arms; only the shape of the span differs.

- Dataset: LongMemEval_S, revision `2ec2a557f339b6c0369619b1ed5793734cc87533` (278025796 bytes, sha256 `08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894`)
- **n = 2** scored, 1 skipped by pre-flight, even stride `--sample 3`.
- Instruction: `buildInstruction(budget, tokensOfThatPiece, 0)` from `src/summarize.js`, built at run time (no frozen prompt copy).
- Arm A `whole-span`: the entire haystack as one span, budget = `defaultBudget(haystackTokens)`.
- Arm B `leaf-chunks`: haystack cut on session boundaries into pieces of at most 30000 tokens (a trailing piece below 50% of the target is folded into its neighbour), per-piece budget = `floor(total/pieces)` with the remainder to piece 1, summaries concatenated in order.
- Scoring: case-insensitive literal containment of `question.answer` in the summary text. Not a correctness judgement.
- Retries: 1 initial call + 3 retries, 2000ms * 2^(n-1) backoff (>= 15s per attempt when the credential pool is cooling down), on transport errors / 5xx / 429 / empty completion / finish_reason=error.

## Verdict

n=2: whole-span kept gold on 1/2 question(s), session-chunked on 1/2 (gold-carrying piece alone: 0/2). No question lost under chunking a fact the whole-span arm kept, so the direction is consistent on this sample. Cost of arm B: 10 calls / 275s vs 2 calls / 173s for arm A. Restricting to the 1 question(s) whose gold text is distinctive in the haystack (rare enough that containment means something): whole-span kept gold on 0/1, chunked on 0/1 (chunking never loses what the whole span keeps).

## Per question

| question | type | gold session(s) | gold piece(s) | gold text is distinctive? | A calls | A out tok | A share | A gold | B calls | B out tok | B share | B gold | B gold (gold pieces only) | elapsed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| e47becba | single-session-user | 53/54 | 5/5 | yes | 1 | 1949 | 11.9% | false | 5 | 5562 | 34.0% | false | false | 27s |
| 4f54b7c9 | multi-session | 26/49 + 47/49 | 3/5 + 5/5 | no (580x) | 1 | 6529 | 39.9% | **true** | 5 | 7439 | 45.4% | **true** | false | 420s |

## Pre-flight arithmetic (the guard against measuring your own truncation)

| question | gold | occurrences in haystack | distinctive (<=20x) | sessions | gold session(s) | sessions contain gold | gold piece(s) | piece tokens | piece budget | haystack tokens | total budget |
|---|---|---|---|---|---|---|---|---|---|---|---|
| e47becba | "Business Administration" | 2 | yes | 54 | 53 | true | 5/5 (merged=true) | 37872 | 3276 | 148023 | 16384 |
| 4f54b7c9 | "5" | 580 | no | 49 | 26+47 | true | 3+5/5 (merged=true) | 29835 | 3276 | 143556 | 16384 |

## Aggregate

| arm | n | calls | failed pieces | output tok (billed) | of which hidden reasoning | visible summary tok | budget total | mean share of budget | compression ratio | gold kept | gold kept in gold piece | elapsed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A-whole | 2 | 2 | 0 | 8478 | 4135 | 4343 | 32768 | 25.9% | 49.0:1 | 1/2 | - | 173s |
| B-chunks | 2 | 10 | 0 | 13001 | 0 | 13001 | 32768 | 39.7% | 23.0:1 | 1/2 | 0/2 | 275s |

## Prompt accounting (did the gateway actually send the whole span?)

Median provider/estimate ratio this run: **0.738** (an arm is flagged as input-truncated only below 60% of that median).

| question | arm | calls | prompt tok (provider) | prompt tok (estimated here) | ratio | provider vs run median | cached prompt tok | out tok/s | resolved model(s) |
|---|---|---|---|---|---|---|---|---|---|
| e47becba | A-whole | 1 | 109244 | 148430 | 0.736 | in line | - | 679.6 | agnes-3.0-flash |
| e47becba | B-chunks | 5 | 111143 | 150051 | 0.741 | in line | 67072 | 228 | agnes-3.0-flash |
| 4f54b7c9 | A-whole | 1 | 104639 | 143962 | 0.727 | in line | 0 | 38.4 | hy3 |
| 4f54b7c9 | B-chunks | 5 | 111755 | 145585 | 0.768 | in line | 20480 | 29.7 | agnes-3.0-flash, codestral-latest |

## Chunk plans

### e47becba (single-session-user)

| piece | sessions | session span (1-based) | tokens | budget | out tok | attempts | finish | carries gold session | gold in piece |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 11 | 1-11 | 26274 | 3280 | 1012 | 1 | stop | no | false |
| 2 | 10 | 12-21 | 29211 | 3276 | 1538 | 1 | stop | no | false |
| 3 | 10 | 22-31 | 27221 | 3276 | 1172 | 1 | stop | no | false |
| 4 | 11 | 32-42 | 27447 | 3276 | 1095 | 1 | stop | no | false |
| 5 | 12 | 43-54 | 37872 | 3276 | 745 | 1 | stop | **yes** | false |

### 4f54b7c9 (multi-session)

| piece | sessions | session span (1-based) | tokens | budget | out tok | attempts | finish | carries gold session | gold in piece |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 13 | 1-13 | 26164 | 3280 | 3280 | 1 | length | no | true |
| 2 | 8 | 14-21 | 27204 | 3276 | 1146 | 1 | stop | no | true |
| 3 | 9 | 22-30 | 29835 | 3276 | 533 | 1 | stop | **yes** | true |
| 4 | 9 | 31-39 | 26804 | 3276 | 1846 | 1 | stop | no | true |
| 5 | 10 | 40-49 | 33550 | 3276 | 634 | 1 | stop | no | false |

## Skipped questions (pre-flight)

| question | type | reason |
|---|---|---|
| gpt4_2c50253f | temporal-reasoning | gold text does not occur in the rendered haystack; gold session(s) ["answer_9af4e346_1","answer_9af4e346_2"] do not contain the gold text |

## Boundaries

1. n is disclosed, not implied: see dataset.scored. LongMemEval_S stores questions grouped by type, so --sample (even stride) is the only partial selection whose per-type mix is meaningful; --limit takes a single-type head.
2. Gold retention is case-insensitive LITERAL containment of the dataset's answer string, not a correctness judgement. A one-token gold (for example the answer 5) occurs hundreds of times in a 147k-token haystack, so containment is near-free for that question and must not be read as fidelity. Per-question goldOccurrences is recorded for exactly this reason.
3. The instrument compresses the haystack as text; it never runs src/summarize.js against a live session. Token counts are countTokens() estimates (word-class + CJK density), the same estimator the other bench harnesses use, not provider-side counts. Provider prompt_tokens/completion_tokens are recorded per call where the gateway returns them.
4. Both arms spend the SAME total budget, but not the same number of prompt tokens: arm B re-sends the instruction once per piece and pays that input cost. The comparison holds the output ceiling constant, not total cost.
5. Arm B budgets floor(total/pieces) per piece with the remainder to the first piece, so a piece's budget is not proportional to its own token count. That is deliberate (it is the shape a caller would use); per-piece tokens and budgets are recorded.
6. A merged trailing piece (below minChunkRatio * chunkTokens) changes the piece count and therefore every per-piece budget; mergedTrailing is recorded per question.
7. Failure policy: a piece that still fails after the configured retries marks the arm's gold result false and reports its error; failed pieces are never silently dropped from the totals.
8. Prompt accounting: every call records the provider's prompt_tokens next to this instrument's own countTokens() estimate of the same prompt. A provider count below 90% of the estimate means the gateway sent less than was built (input truncation); the arm then measures the truncation instead of the compressor, and the Prompt accounting table flags it.
9. The model is requested by the alias balanced-lite, which the gateway routes. The resolved model id reported by the gateway is recorded per call: a rerun that lands on a different backend is a different model, not a repeat. In this environment the same alias resolved to different backends on consecutive calls.
10. Hidden reasoning: the routed backends are reasoning models, and their reasoning_tokens are billed inside completion_tokens against the same max_tokens ceiling. Output tokens therefore overstate how much summary text a call actually wrote; visible summary tokens are reported separately (billed minus reasoning, plus this instrument's countTokens() of the returned text).
11. Retries: attempt 2 and later append a one-line '[retry N]' marker to the prompt, because the gateway replays an identical body from cache and would otherwise hand back the same broken stream forever. A retried call is therefore a marginally different prompt, at most a few tokens longer.
12. Wall-clock is the gateway's own latency. The gateway replays an identical prompt (same body) from cache, in which case elapsed can drop by an order of magnitude; content at temperature 0 is the same either way, but do not read elapsed as generation speed.
