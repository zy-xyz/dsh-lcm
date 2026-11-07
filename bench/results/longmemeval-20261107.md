# LongMemEval_S - Layer 1 retrieval (dsh-lcm, lexical search)

Generated 2026-11-07T16:50:28.913Z by `bench/longmemeval.mjs`. Model: **none** (no answerer, no judge, no embedding provider).

- Dataset: LongMemEval_S, revision `2ec2a557f339b6c0369619b1ed5793734cc87533`
- File: `/home/agent/workspaces/lcmx-study/data/longmemeval_s.json` (278025796 bytes, sha256 `08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894`)
- **n = 500** questions scored (of 500 in the split).
- Entry point: production `searchSession` (`src/search.js`), `maxSearchHits=200`, `maxRecallTokens=1000000`.
- Query: the question text, regex-escaped and matched literally. No keyword picking, no retry.
- Isolation: every question builds a brand-new in-memory session from its own haystack (per-question fresh store).
- Candidate pool: 50 sessions / 492 events per question (median; min-max 39-66 sessions, 396-616 events). `maxSearchHits=200` caps one arm at 200 of ~492 events, so the ranked *session* list is a subset of ~50 sessions - recall@10 is a real filter, recall@50 is nearly the whole haystack.

## Session-level metrics

| arm (rank) | n | sR@5 | sR@10 | sNDCG@10 | sR@1 | MRR | zero-hit rate |
|---|---|---|---|---|---|---|---|
| seq | 500 | 0.002 | 0.002 | 0.001 | 0.002 | 0.002 | 0.998 |
| score | 500 | 0.002 | 0.002 | 0.001 | 0.002 | 0.002 | 0.998 |
| density | 500 | 0.002 | 0.002 | 0.001 | 0.002 | 0.002 | 0.998 |

## Per question_type

| question_type | n | seq sR@5 | score sR@5 | density sR@5 | seq sR@10 | score sR@10 | density sR@10 | seq sNDCG@10 | score sNDCG@10 | density sNDCG@10 |
|---|---|---|---|---|---|---|---|---|---|---|
| multi-session | 133 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| temporal-reasoning | 133 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| knowledge-update | 78 | 0.013 | 0.013 | 0.013 | 0.013 | 0.013 | 0.013 | 0.008 | 0.008 | 0.008 |
| single-session-user | 70 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| single-session-assistant | 56 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| single-session-preference | 30 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |

## Zero-hit questions (verbatim question matched nothing)

| arm | zero-hit | n | share |
|---|---|---|---|
| seq | 499 | 500 | 0.998 |
| score | 499 | 500 | 0.998 |
| density | 499 | 500 | 0.998 |

Misses by construction: the lexical index has no tokenised/OR recall, so a paraphrased question that shares no literal substring with any event retrieves nothing. Recorded as a miss, never retried with narrower keywords.

## Second query policy - OR-of-terms (the policy lcm-x's own fts arm uses)

The METHODOLOGY-mandated query is the question verbatim. It is also the wrong query for a line-oriented regex, and the near-zero table above is what that costs. lcm-x's `fts` arm does not do that either: `build_fts_query` in `benchmarking/longmemeval.py` tokenises the question, drops stopwords, and ORs the barewords into one FTS5 MATCH. The `tokenOr` rows below apply the same policy to this harness (content tokens OR-ed into one case-insensitive regex, stopwords dropped) so the two lexical systems are compared on the same query construction. Both tables are honest; they answer different questions.

| variant (rank) | n | sR@5 | sR@10 | sNDCG@10 | sR@1 | MRR | zero-hit rate |
|---|---|---|---|---|---|---|---|
| seq | 500 | 0.300 | 0.502 | 0.178 | 0.062 | 0.191 | 0.000 |
| score | 500 | 0.774 | 0.874 | 0.602 | 0.470 | 0.604 | 0.000 |
| density | 500 | 0.626 | 0.826 | 0.431 | 0.148 | 0.348 | 0.000 |

## Why the verbatim-query arm is ~0.002 (mechanism, not a bug)

A LongMemEval question is a natural-language sentence (`What degree did I graduate with?`). `searchSession` compiles the pattern and tests it line by line against each event's rendered text. A whole-sentence regex therefore only fires when that exact sentence appears verbatim inside one line of the haystack - which happens on 1 of 500 questions. Every other question returns zero hits at every rank mode, identically, because ordering cannot rescue an empty candidate set.

That is the honest reading of the production tool's contract: `searchSession` is an *anchor* search (a path, an id, an error line, a keyword), and its documented use is 'the agent remembers a string, types it, gets the event back'. It was never a question-answering retriever. Feeding it a full question is the METHODOLOGY-mandated adapter (query = question verbatim, no token picking), so the near-zero result is reported as-is rather than hidden behind a friendlier query policy.

## Reference: lcm-x published retrieval numbers (NOT a like-for-like comparison)

From `../lcm-x/benchmarks/results/longmemeval-v3-500q-fastembed.md` (n=470 scoreable, LongMemEval_S, local FastEmbed `BAAI/bge-small-en-v1.5`, 500q):

| lcm-x arm | sR@5 | sR@10 | sNDCG@10 | route |
|---|---|---|---|---|
| chunk_vectors | 0.96 | 0.98 | 0.924 | embedding KNN over raw conversational chunks |
| summary_vectors | 0.87 | 0.93 | 0.837 | embedding KNN over one summary per session |
| hybrid_rrf3 | 0.77 | 0.97 | 0.714 | RRF over FTS + summary + chunk |
| hybrid_rrf | 0.49 | 0.64 | 0.484 | RRF over FTS + summary |
| fts | 0.20 | 0.36 | 0.204 | **lexical only** (tokenised full-text search) |
| lcm_recall (50q subset) | 0.98 | 1.00 | - | production tool, weighted RRF + priors |

Read the `fts` row as the only structural counterpart: it is the one arm with no embedding model. The gap between it (sR@5 0.20) and this harness's verbatim-query number is a **query-shape** difference, not a retrieval-quality difference: FTS tokenises the question into terms and ORs/ANDs them against an inverted index, while this harness feeds the whole question to a line-oriented regex, which almost never matches a line verbatim. The `tokenOr` table above removes exactly that difference, which is why it - not the verbatim number - is the row to compare against `fts`. Even so the two remain different instruments: FTS5 ranks by BM25 over a tokenised inverted index, this harness ranks by match count or length-normalised match density over lines.

## Boundaries

1. **The measured arms are lexical only.** `searchSession` is a case-insensitive regex over rendered event text plus one of three orderings (`seq` chronological, `score` match-count, `density` length-normalised match density); there is no tokeniser, no inverted index and no chunk store, so a question sharing no literal substring with an event retrieves nothing at any rank mode. The optional semantic route (`searchSessionHybrid`, `src/vectors.js`) exists but was not exercised by this run - pass `--rank vector,hybrid` to score it.
2. **Turn-level is unavailable.** LongMemEval_S labels evidence at session granularity (`answer_session_ids`) only; there are no per-turn evidence labels, so any `(session, turn_index)` recall/NDCG would be invented. No tR@k is reported. `perQuestion.*.eventRank` (rank of the first event inside an evidence session) ships in the JSON as a diagnostic.
3. **n = 500** questions, all with non-empty `answer_session_ids`. Per-type n is in the table above.
4. **Not comparable to lcm-x's published numbers.** lcm-x's retrieval numbers run with an embedding provider (local FastEmbed `BAAI/bge-small-en-v1.5` floor, `voyage-context-3` recommended) and score vector/KNN and RRF-fused arms. Comparing a regex matcher to `chunk_vectors` (sR@5 0.96) measures the absence of an embedding path, not the quality of this one. The defensible counterpart is lcm-x's own lexical arm, `fts`: sR@5 0.20 / sR@10 0.36 / sNDCG@10 0.204.
5. Session-level recall dedupes hits by session id, so a burst of events from one session cannot consume the top-k budget. NDCG@10 uses binary relevance with the full IDCG over all gold sessions of that question.
