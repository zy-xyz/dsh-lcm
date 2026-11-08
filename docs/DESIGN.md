# Design: how `dsh-lcm` compacts a session

This describes the engine as it ships at 0.7.0. The previous version of this file
was a decision memo written before the code existed; its milestones are now either
shipped in a different shape or dropped, and the last section lists where it and
the code disagree.

One invariant holds everything below together: the append-only session log is the
truth and a checkpoint is a view over it. Every mechanism in this package exists
because a run without it produced a specific, measured failure. Each section names
the failure and the place its evidence lives, either in the source or in
`bench/REPORT.md`.

## 1. One compaction is one replacement

A compaction replaces a contiguous positional span of the surface with a single
checkpoint message, inside one durable transaction (`src/region.js:195`). The
transaction asserts the compaction lock is free before opening, brackets
`compaction/start`, `compaction/summary` and `compaction/end`, re-asserts surface
stability after the model call, and refuses to commit a checkpoint that does not
shrink the surface: `framedTokenCount >= prepared.shadowedRouteTokenCount` throws
(`src/region.js:419`).

Two prices are carried because the surface accounts in two of them
(`src/region.js:343`). `shadowedTokenCount` is the heuristic price the token meter
folds into its surface total, and it is what the durable event records.
`shadowedRouteTokenCount` is what the replaced request actually cost, and it is the
number the shrink guarantee is stated in, because the question the gate asks is
whether the replacement request is cheaper than the request it replaces.

There are four ways in. Step pressure and context-overflow recovery go through
`compactIfNeeded`; a proposed model switch goes through `compactPressure` with the
new envelope, because the durable header still describes the old model and the new
window may be smaller; a manual `/compact` goes through `compactNow`
(`src/index.js:590`, `src/index.js:633`, `src/index.js:767`). A model switch that
cannot get the history under the new threshold is a refused switch, reported as
`MODEL_SWITCH_COMPACTION_FAILED` rather than as a context-window error mid-turn.

## 2. The compression unit is a leaf, oldest first

`selectCompactableRange` (`src/region.js:81`) decides what to compact, in this order:
retain a priced recent tail; walk the boundary back until no tool call is split
from its result; try condensation (section 3); cap the span at `leafSpanTokens`;
then refuse a span that is not worth a model call.

The cap is why one compaction produces one bounded leaf instead of summarising
everything compactable at once. I put it there after measuring the alternative.
Switching the whole 147k prefix in one pass produced checkpoints that kept one
section out of six in 5 of 15 questions, because a single response was being
interrupted before the sections were done. Splitting the same haystack at session
boundaries into seven pieces under the 24 000-token leaf size, each with its own
target, produced seven complete six-section checkpoints with `finish=stop` seven
times out of seven, and the piece carrying the gold value did carry it
(`bench/REPORT.md` section 32). The difference was not that more was written; it
was that each call wrote an amount that does not get interrupted.

The span floor is `minTokens > 0` and the comparison is `spanTokens <= 2 * minTokens`
(`src/region.js:169`). Below the summary floor the budget is clamped up to the floor,
so a span barely above it gets a target almost as large as itself: a span of 428
tokens resolves to a 512-token target, the checkpoint cannot be smaller, and the
model call is spent before the shrink gate rejects it. The failure that produced
this guard is in the source as the incident string `span=1 seqs=24-24
shadowedTokens=428 budget=512`. A single large node is not refused on count: one
40 000-token tool result is exactly what compaction is for, and it does shrink.

Manual `/compact` deliberately passes none of these guards
(`src/index.js:777`): floor 0, no leaf cap, no fanin, retain 0. An operator who asks
for a compaction gets whatever the surface allows, including the shape the engine
would have refused on its own.

The cost is honest: a 147k span becomes 7 calls, and the production-scale 436k span
would become about 19, run serially, so wall clock grows with the span even though
each call is smaller (`bench/REPORT.md` section 32).

## 3. Condensation at fanin 4

`deriveDag` (`src/summarize.js:620`) recovers the summary DAG from the log alone. A
node is the `user/message` that immediately follows a `compaction/summary` and whose
source is a compact checkpoint; its children are the `shadowedSeqs` recorded on that
summary; depth is 1 for a leaf that absorbed only raw messages and 1 + max(child
depth) otherwise. Nothing is stored: no side table, no migration, rebuildable after
any restart, which is why `appendPluginRecord` is not used for it.

Depth alone did nothing until selection used it. Without condensation the surface
accumulates a flat row of depth-1 leaves: every checkpoint is independent, nothing
produces a rollup, and the assembled context grows linearly with history instead of
logarithmically. So before taking the oldest bytes again, selection looks at the
leading run of the compactable prefix and, when at least `condensationFanin` nodes sit
at the same depth, selects exactly that many and replaces them with one node one
level up (`src/region.js:105`).

Only a leading run qualifies, for a reason that is not stylistic: a run that mixes
depths would merge a parent with its own children, which is not condensation but
summarising a summary of itself. The boundary is then walked back until it is
balanced, so the merge never splits a step.

Absorbed depth is also what the summarizer is told. `maxAbsorbedDepth` feeds one line
of the instruction, so a span that already contains a depth-2 checkpoint is asked to
fold its content in rather than to add a section for it
(`src/summarize.js:296`, `src/summarize.js:155`).

The gap this closes was recorded as open: `bench/REPORT.md` section 34 scores
LCM-X's step 3 as missing here, and section 32 lists fanin merging among what had not
been measured. The code implements it now; the report carries no measurement of it,
and this document does not claim one.

## 4. The escalation ladder

Three rungs, plus two summariser outcomes that enter at the bottom.

Level 1 is the ordinary call (`src/summarize.js:241`). The target is
`resolveSummaryBudget`: `clamp(shadowed * summaryRatio, summaryFloorTokens,
checkpointCap)`, then capped by `maxTokens` (`src/config.js:359`). The target is
written into the instruction as a target, and the request carries a separate ceiling
of `max(4096, 2 * target)`. That ceiling is deliberate. With no ceiling the provider
applies its own default, which is smaller than it looks: one run was cut mid-word at
7 734 characters with only the anchor section written, and the same prompt with an
explicit 32 768 finished at 8 817 characters with all six sections
(`bench/REPORT.md` section 30). Reasoning is billed against the same ceiling and was
measured at roughly half of it, so a ceiling equal to the target leaves the summary
half written.

Level 2 exists because a target is not a bound. Measured: a 1 517-token span with a
512-token target came back at 2 438 tokens, 4.8 times the target and longer than the
text it replaced, so the shrink gate rejected it and the call was wasted
(`bench/REPORT.md` section 28). The retry changes the prompt or it would sample the
same overrun: half the budget (`max(128, floor(budget / 2))`) and a hard constraint
appended last, where recency lands hardest (`src/index.js:185`). The constraint
states what went wrong with both numbers, says "hard upper bound, not a target",
forbids shortening the anchor list to save room, and requires every narrative section
to keep content. Exactly one retry: a model that overruns twice on a
restated hard bound will not fit on attempt four, and every attempt is a full-price
call.

Level 3 is deterministic truncation with no model call
(`src/index.js:78`). The body is cut at a line boundary to fit `limit` minus the
entry header, the note itself shrinks from a full sentence to
`[truncated; see lcm_search]` to nothing when the budget cannot afford it, and a final
character loop enforces the bound rather than trusting per-line arithmetic. Two
details are load-bearing, both learned the hard way: the header must be reserved,
because the gate compares the assembled entry and a 100-token bound with an
unreserved 30-token header put the entry back over and the escalation stopped
converging; and the anchor section is emitted first precisely so truncation costs the
narrative tail and keeps the pointers (`bench/REPORT.md` section 34).

An empty response and a response cut at the provider cap enter at level 3 instead of
failing (`src/index.js:487`). `SUMMARY_EMPTY` and `MAX_TOKENS` are summariser
outcomes, not transport failures, and the ladder's invariant is to prefer degraded
coverage over failure. The deterministic body is built from the span itself, every
non-empty rendered line prefixed with its `(seq N)`, so it cannot be empty. It is
built to the target and then pushed through the same truncation rung, because the
gate compares against the span and a small span makes the target larger than the
bound. The label lives in the entry header, not in the body, because the body is what
truncation cuts: the header says `DETERMINISTIC fallback, not a model summary` and
survives (`src/index.js:551`). A rate limit, a timeout or an abort is neither outcome
and keeps propagating, so the harness can route or retry instead of quietly accepting
a degraded body.

Measured effect on the failure that motivated it: the subagent run that logged two
`summarization produced no text content` compaction failures now logs one successful
summarize and zero failures (`bench/REPORT.md` section 35).

## 5. The stall hold

A session over its threshold with nothing worth compacting used to be re-evaluated
on every step: measure, resolve model info, select, decline, log, repeat. In a real
session that looked like a hang, because `pressure: measured=14208
threshold=13616` with no compaction and no error is indistinguishable from a broken
engine. The probe that settled it: 17 surface nodes, 14 372 tokens, `retainTokens`
4 472, leaving exactly one 233-token node compactable, which the span floor refuses
because 233 is far below `2 * summaryFloorTokens`. Returning nothing was correct;
re-deciding it every step was not (`bench/REPORT.md` section 35).

So `compactPressure` keeps a per-session hold, `{ tokens, until }`
(`src/index.js:677`). It is armed only when selection returns nothing and only for
automatic work. It is released by any of three real changes: a stored checkpoint, the
session growing by one leaf's worth (`>= stall.tokens + leafSpanTokens`), or the
deadline expiring at `stallCooldownMs`. It is also dropped when pruning alone brings
the measurement under the threshold, since nothing is stalled any more. A manual
request is never held: `requireBelowThreshold` exempts it, because the operator asked
for an answer and "nothing to compact" is that answer.

The growth quantum is a leaf, not an arbitrary delta, and not time alone. A leaf is
the smallest amount of new material that is worth summarising on its own; any growth
at all would make the hold meaningless, and a pure deadline would let material that
should have been compacted wait out the cooldown. It is the same number the selector
uses, not a second figure invented for this gate.

The decline is logged with every number that produced it, including the hold terms
(`src/index.js:696`). That line is the difference between "correctly declined" and
"silently broken", and it was added because I spent time writing a probe to exclude a
bug that the log should have excluded for me.

## 6. The checkpoint's shape

Every checkpoint opens with `RECALL_GUIDE` (`src/compiler.js:293`): the log is
append-only, this is a summary and not the only copy, use `lcm_expand` with a `seq` or
`result` reference, use `lcm_search` for anything omitted. It ends with a direct
instruction to search before answering "I don't know", a count, a date, or anything a
summary might have dropped, and it says why: a bare number does not say what it
counts. That sentence exists because answering from a checkpoint alone scores 0% on
counting questions whose evidence is scattered, while answering with retrieval scores
70%, and the whole difference is whether the model searches
(`bench/REPORT.md` sections 30 and 33).

Then six headings, in a fixed order (`src/summarize.js:40`). The headings are
literal strings and stay in Chinese, because the instruction that demands them is
written in Chinese: the verbatim anchor list first, then 用户事实, 目标与约束, 已完成,
未决问题, 下一步.

The anchor list is first because truncation cuts the tail. When it was last, a
budgeted summary kept the narrative and lost exactly the part that carries fidelity;
the source records 0 of 14 anchors at a 516-token ceiling, against 2 of 14 for the
built-in backend. Putting it first inverts the cost: truncation now spends prose.

The anchor list is a word list, not prose and not sentences: one literal string per
line, pasteable into `lcm_search`, covering paths, commands, URLs, error strings,
ids, function and variable names, key names, numeric thresholds, every name of a
person, place, organisation, product or model, and every number with its unit. It is
bounded at 120 lines, with uniqueness and specificity as the tiebreak. Both rules
come from measurement. Widening the section to carry facts turned it into Chinese
prose sentences, which destroys the property the section exists for, a string that
can be pasted into search and returns the event. Leaving it unbounded let the model
write over 11 000 characters of anchors, and one recorded run produced that section
and nothing else; another run at 13 837 characters did finish all six, so the
failure is variance rather than a fixed rule (`bench/REPORT.md` section 29). The
bound is defensible because the log keeps every string: an exhaustive list
duplicates the log and crowds out the part search cannot recover.

Facts live one section down, as typed rows: `subject.predicate = value | kind`
(`src/summarize.js:97`). The subject is only user, assistant or world; the kind is one
of seven, borrowed from lcm-x's assertion store: `fact`, `number`, `time`, `event`,
`preference`, `status`, `commitment`. A number carries its unit and what it counts.
A preference carries polarity, `+` for liked and `-` for disliked. A countable event
gets one dated row per occurrence plus an explicit status marker, present, cancelled,
rescheduled or planned, so a reschedule cannot inflate a count. Values are copied in
the span's own language and predicates are lowercase English underscores.

The row format is not decoration. On 15 paired failures the gold values were 7
numeric, 6 short prose, 2 long prose and 0 identifiers, meaning the old anchor rule
was filtering out exactly the categories the questions asked about. The decisive
single case: the gold `10` was already present in the anchor list on its own line and
the answering model still returned UNKNOWN, and the same value answered correctly
once it was written as `user.watched_amateur_comedians = 10 | number`. A value without
a predicate and a type is not answerable (`bench/REPORT.md` section 29).

The checkpoint is written in the language of the span, not the language of the
instruction, and quoted values keep their original language. This is measured: with a
Chinese instruction the checkpoint came out in Chinese for an English conversation,
the answering model mirrored it, and three of 15 answers were semantically right but
in the wrong language; a translated `55-inch` scored wrong where the verbatim string
scored right (`bench/REPORT.md` section 30).

Pointers are attributed after the model call, never asked for
(`src/summarize.js:565`). The summarizer input is the verbatim span replayed to reuse
the provider's prefix cache, so seq markers inside the input would break that cache.
Attribution renders each shadowed event exactly as lexical search renders it, so a
pointer found here is a pointer search would have found, and appends `(seq N)` only
when the anchor appears verbatim inside the span. An anchor the span never contained
gets no pointer: this string is not in the log as written, and a guessed pointer
would send `lcm_expand` to the wrong event.

## 7. Retrieval

Two tool-side entries and two commands, and the split is not cosmetic.

`lcm_expand` is the model-callable restore path (`src/tool.js:105`). It takes a typed
reference: `seq` for `(seq N)` and `(seqs A-B)` markers, `result` for the `result N`
pointer on a tool-call one-liner, `checkpoint` for a whole checkpoint by ordinal or
seq. `lcm_search` is the model-callable find path (`src/tool.js:138`): case-insensitive
keyword or regex over the durable log, including content compaction removed from the
surface, returning matching events with their `(seq N)` so a hit can be restored. The
rank mode is lexical by default (`seq`, `score`, `density`); the optional vector and
hybrid modes are inert unless `vectorEnabled` is set, and with it off the output is
byte-identical to lexical. Both tools also register under the previous backend's names
(`recall`, `search`) unless `legacyNames` is disabled.

`/lcm-search` and `/lcm-status` are commands, so a human types them and a model
cannot (`src/command.js:84`, `src/command.js:156`). I made `/lcm-status` a command
rather than a tool on purpose: it answers an operator's question, and a tool would
spend model attention on every request to answer a question nobody asked. Its numbers
are read out of the log rather than counted in memory, so they survive a restart and
describe the session as persisted: surface nodes, checkpoints by depth, compaction
count, shadowed against kept tokens, and tokens saved. The boundary is real and was
measured the hard way: asking a model to type `/lcm-status` produces text, not a
command. `lcm_expand` is verified by seeing it called in a real engine log; the
commands are verified by their registration tests.

Retrieval is where this design earns its keep. The anatomy of one counting question
(`00ca467f`, "how many times did I see a doctor in March") is nine mentions spread
across five sessions, of which two count, and the difference between counting and not
is whether the original sentence was available, because "considering an appointment"
and "had an appointment" are only distinguishable in the original
(`bench/REPORT.md` section 33). No summary can pre-answer a question it cannot see. The
same corpus scores 70% in the retrieval configuration and 0% in both one-shot
configurations, including the built-in backend's
(`bench/REPORT.md` sections 27 and 33). One full trace shows the mechanism: a 1 669-token
checkpoint over a 148 023-token haystack, one `lcm_search` with
`graduate|degree`, three hits, correct answer from `seq 530` (`bench/REPORT.md`
section 25).

## 8. Resolved defaults

Every default here is a decision this document has already argued for, except the
three that are inherited unchanged from `dsh-compaction-basic` so an existing
configuration drops in without noticing (`src/config.js:188`).

| key | default | why |
|---|---|---|
| `thresholdRatio` | 0.8 | inherited from basic, unchanged |
| `headroomTokens` | 65536 | inherited from basic, unchanged |
| `retainRatio` | 0.16 | inherited from basic, unchanged; the verbatim tail stays original text |
| `summaryRatio` | 0.12 | target is 12% of the span, clamped below |
| `summaryFloorTokens` | 512 | a small span still gets a usable target, and this is also the selector's floor |
| `checkpointCap` | 16384 | ceiling on the target, not a request cap |
| `leafSpanTokens` | 24000 | one leaf per compaction, oldest first (section 2) |
| `condensationFanin` | 4 | same-depth run that folds into one node (section 3) |
| `stallCooldownMs` | 60000 | hold deadline for a stalled session (section 5); 0 disables |
| `anchorPointers` | true | local computation over events already in memory, no request |
| `emptySummaryRetries` | 2 | three attempts on the same prompt before the ladder's bottom rung |
| `compactionRetries` | 1 | one extra pressure attempt, then the real diagnosis |
| `maxOverflowRetries` | 1 | one forced reduction per confirmed overflow |

The budget math is basic's, verbatim:

```
messageBudget    = contextWindow - reservedCompletionTokens
pressureBudget   = messageBudget - headroomTokens
thresholdTokens  = floor(min(contextWindow * thresholdRatio, pressureBudget))
retainTokens     = retainTokens ?? floor(messageBudget * retainRatio)
targetTokens     = min(clamp(shadowed * summaryRatio, summaryFloorTokens, checkpointCap), maxTokens)
```

`maxTokens` defaults to `headroomTokens`, which keeps basic's key working: a
configuration that set it still gets that number as what the model is asked to aim
for, instead of silently inheriting the larger cap.

## 9. What this does not claim

The leaf unit fixes single-spot facts and does not fix counting across leaves or
multi-step reasoning: the four questions it fixed in one batch all had a gold value
locatable inside one leaf, and the ones it missed included cross-leaf counts, an
off-by-one, a unit conversion, and two whose gold does not exist in the source text
at all
(`bench/REPORT.md` section 31). The 15-question numbers are a lower bound collected
while the gateway was returning 429 and 504, so they cannot be attributed to the
instruction; the same section records that a run of long-prompt measurement on a
degrading gateway fuses model behaviour with scheduling noise.

No cost claim is made anywhere. Cost was taken out of the metric set on instruction;
fidelity and recoverability are the only lines this package guards
(`bench/REPORT.md` section 19).

The deterministic rung is degraded coverage, not a summary. It is labelled that way in
the entry header because a reader must never mistake it for a model checkpoint.

The one-shot configurations are not this package's comparison point. They score zero
for every backend that withholds retrieval, which makes the 4-versus-1 result on the
same fifteen questions (`bench/REPORT.md` section 31) a statement about the restricted
setup, not about the engine.

## 10. What the earlier memo assumed

The previous `docs/DESIGN.md` was written before the engine existed. Where it and the
code disagree, the code is the design:

| the memo said | the code does |
|---|---|
| TypeScript under `src/engine/`, `src/compiler/`, `src/store/` | plain ESM JavaScript, one module per concern: `index`, `config`, `region`, `summarize`, `compiler`, `recall`, `search`, `tool`, `command`, `vectors` |
| externalise large payloads into pointers (`externalize.ts`) | not implemented; pointers are `(seq N)` references into the log, and the `compaction/summary-error` waterfall is wired for a listener that would offload, with nothing attached |
| SQLite or a separate store as the DAG's truth | the DAG is derived from the log on demand (section 3), no side table |
| a background sweep so the hot path only compiles deterministically | not implemented; the model call is inline and the deterministic rung is the fallback, not a background job |
| condensation budget `max(1000, 0.40 x sum of children)`, `depth <= 3` | condensation reuses the ordinary leaf target from `resolveSummaryBudget`; no depth limit is enforced anywhere, and `maxDepth` is reported, not capped |
| milestone pass criteria (token halving, pairing rate, three follow-up rounds) | superseded by the gate table in `docs/ACCEPTANCE.md` and the fidelity instrument in `bench/REPORT.md` |

The memo's central judgement still holds and is why this file exists in English
rather than as a port: the missing pieces were multi-level condensation, pointer
retrieval, and an escalation path, and all three are now in the code rather than in a
plan.
