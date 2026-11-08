# Leaf summary shape at one budget - whole span vs session-chunked

Generated 2026-11-08T01:05:31.662Z by `bench/leaf-chunks.mjs`. Model: `balanced-lite`. Same compressor, same total ceiling in both arms; only the shape of the span differs.

- Dataset: LongMemEval_S, revision `2ec2a557f339b6c0369619b1ed5793734cc87533` (278025796 bytes, sha256 `08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894`)
- **n = 3** scored, 5 skipped by pre-flight, even stride `--sample 8`.
- Instruction: `buildInstruction(budget, tokensOfThatPiece, 0)` from `src/summarize.js`, built at run time (no frozen prompt copy).
- Arm A `whole-span`: the entire haystack as one span, budget = `defaultBudget(haystackTokens)`.
- Arm B `leaf-chunks`: haystack cut on session boundaries into pieces of at most 30000 tokens (a trailing piece below 50% of the target is folded into its neighbour), per-piece budget = `floor(total/pieces)` with the remainder to piece 1, summaries concatenated in order.
- Scoring: case-insensitive literal containment of `question.answer` in the summary text. Not a correctness judgement.
- Retries: 1 initial call + 3 retries, 2000ms * 2^(n-1) backoff (>= 15s per attempt when the credential pool is cooling down), on transport errors / 5xx / 429 / empty completion / finish_reason=error.

## Verdict

n=3: whole-span kept gold on 1/3 question(s), session-chunked on 1/3 (gold-carrying piece alone: 0/3). No question lost under chunking a fact the whole-span arm kept, so the direction is consistent on this sample. Cost of arm B: 16 calls / 303s vs 3 calls / 201s for arm A. Restricting to the 2 question(s) whose gold text is distinctive in the haystack (rare enough that containment means something): whole-span kept gold on 0/2, chunked on 0/2 (chunking never loses what the whole span keeps).

## Per question

| question | type | gold session(s) | gold piece(s) | gold text is distinctive? | A calls | A out tok | A share | A gold | B calls | B out tok | B share | B gold | B gold (gold pieces only) | elapsed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| e47becba | single-session-user | 53/54 | 5/5 | yes | 1 | 1949 | 11.9% | false | 5 | 5562 | 34.0% | false | false | 27s |
| 3d86fd0a | single-session-user | 9/57 | 1/5 | yes | 1 | 7366 | 45.0% | false | 5 | 7468 | 45.6% | false | false | 307s |
| gpt4_2f91af09 | multi-session | 9/58 + 43/58 + 57/58 | 1/5 + 5/5 | no (71x) | 1 | 2742 | 16.7% | **true** | 6 | 5648 | 34.5% | **true** | false | 169s |

## Pre-flight arithmetic (the guard against measuring your own truncation)

| question | gold | occurrences in haystack | distinctive (<=20x) | sessions | gold session(s) | sessions contain gold | gold piece(s) | piece tokens | piece budget | haystack tokens | total budget |
|---|---|---|---|---|---|---|---|---|---|---|---|
| e47becba | "Business Administration" | 2 | yes | 54 | 53 | true | 5/5 (merged=true) | 37872 | 3276 | 148023 | 16384 |
| 3d86fd0a | "a coffee shop in the city" | 1 | yes | 57 | 9 | true | 1/5 (merged=true) | 25947 | 3280 | 145374 | 16384 |
| gpt4_2f91af09 | "23" | 71 | no | 58 | 9+43+57 | true | 1+5/5 (merged=true) | 27712 | 3280 | 152158 | 16384 |

## Aggregate

| arm | n | calls | failed pieces | output tok (billed) | of which hidden reasoning | visible summary tok | budget total | mean share of budget | compression ratio | gold kept | gold kept in gold piece | elapsed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A-whole | 3 | 3 | 0 | 12057 | 6003 | 6054 | 49152 | 24.5% | 50.4:1 | 1/3 | - | 201s |
| B-chunks | 3 | 16 | 0 | 18678 | 3214 | 15464 | 49152 | 38.0% | 24.3:1 | 1/3 | 0/3 | 303s |

## Prompt accounting (did the gateway actually send the whole span?)

Median provider/estimate ratio this run: **0.738** (an arm is flagged as input-truncated only below 60% of that median).

| question | arm | calls | prompt tok (provider) | prompt tok (estimated here) | ratio | provider vs run median | cached prompt tok | out tok/s | resolved model(s) |
|---|---|---|---|---|---|---|---|---|---|
| e47becba | A-whole | 1 | 109244 | 148430 | 0.736 | in line | - | 699.6 | agnes-3.0-flash |
| e47becba | B-chunks | 5 | 111143 | 150051 | 0.741 | in line | 67072 | 227.9 | agnes-3.0-flash |
| 3d86fd0a | A-whole | 1 | 107853 | 145780 | 0.740 | in line | 0 | 37.3 | hy3 |
| 3d86fd0a | B-chunks | 5 | 112405 | 147403 | 0.763 | in line | 0 | 68.2 | agnes-3.0-flash, hy3, codestral-latest |
| gpt4_2f91af09 | A-whole | 1 | 110738 | 152564 | 0.726 | in line | - | 12813.1 | agnes-3.0-flash |
| gpt4_2f91af09 | B-chunks | 6 | 112482 | 154190 | 0.730 | in line | 0 | 33.5 | codestral-latest, agnes-3.0-flash |

## Chunk plans

### e47becba (single-session-user)

| piece | sessions | session span (1-based) | tokens | budget | out tok | attempts | finish | carries gold session | gold in piece |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 11 | 1-11 | 26274 | 3280 | 1012 | 1 | stop | no | false |
| 2 | 10 | 12-21 | 29211 | 3276 | 1538 | 1 | stop | no | false |
| 3 | 10 | 22-31 | 27221 | 3276 | 1172 | 1 | stop | no | false |
| 4 | 11 | 32-42 | 27447 | 3276 | 1095 | 1 | stop | no | false |
| 5 | 12 | 43-54 | 37872 | 3276 | 745 | 1 | stop | **yes** | false |

### 3d86fd0a (single-session-user)

| piece | sessions | session span (1-based) | tokens | budget | out tok | attempts | finish | carries gold session | gold in piece |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 11 | 1-11 | 25947 | 3280 | 2400 | 1 | stop | **yes** | false |
| 2 | 10 | 12-21 | 29262 | 3276 | 1286 | 1 | stop | no | false |
| 3 | 13 | 22-34 | 29162 | 3276 | 3276 | 1 | length | no | false |
| 4 | 9 | 35-43 | 25479 | 3276 | 352 | 1 | stop | no | false |
| 5 | 14 | 44-57 | 35524 | 3276 | 154 | 1 | stop | no | false |

### gpt4_2f91af09 (multi-session)

| piece | sessions | session span (1-based) | tokens | budget | out tok | attempts | finish | carries gold session | gold in piece |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 10 | 1-10 | 27712 | 3280 | 489 | 1 | stop | **yes** | false |
| 2 | 10 | 11-20 | 29220 | 3276 | 479 | 1 | stop | no | false |
| 3 | 11 | 21-31 | 25394 | 3276 | 1412 | 1 | stop | no | true |
| 4 | 9 | 32-40 | 26403 | 3276 | 1463 | 2 | stop | no | true |
| 5 | 18 | 41-58 | 43430 | 3276 | 1805 | 1 | stop | no | true |

## Skipped questions (pre-flight)

| question | type | reason |
|---|---|---|
| 9ee3ecd6 | multi-session | gold session(s) ["answer_66c23110_2"] do not contain the gold text |
| gpt4_6dc9b45b | temporal-reasoning | gold text does not occur in the rendered haystack; gold session(s) ["answer_c4df007f_1"] do not contain the gold text |
| 0bb5a684 | temporal-reasoning | gold text does not occur in the rendered haystack; gold session(s) ["answer_e936197f_1","answer_e936197f_2"] do not contain the gold text |
| 71315a70 | knowledge-update | gold session(s) ["answer_c44b9df4_1"] do not contain the gold text |
| 26bdc477 | knowledge-update | gold session(s) ["answer_f762ad8d_1"] do not contain the gold text |

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
