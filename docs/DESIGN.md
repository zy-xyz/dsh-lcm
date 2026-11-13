# Design: how `dsh-lcm` compacts a session

This describes the engine as it ships at 0.8.0. The previous version of this file
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

Manual `/compact` is lcm-x's `compress(force=True)`, and that means LEAF
granularity with the soft target off — not one call over everything.

`force` changes exactly one clock in the reference (`compaction.py:2250`):
`if force or state.force_overflow: state.budget.soft = 0.0`, because the soft
target exists for AUTOMATIC compaction. Leaf selection is untouched, so a manual
pass still walks `_select_oldest_leaf_chunk(candidate_raw, leaf_chunk_tokens)`
with `leaf_chunk_tokens = 24_000`. Only `force_overflow` — a provider-refused
request — takes `leaf.to_compact = candidate_raw`, the whole span in one call.

This engine had that backwards: the manual path passed a leaf cap of 0, so it
sent the entire surface as one summarizer prompt. Measured on the macOS build
session, `seq 30477`: 2 506 nodes / 686 174 tokens in one call, capped at the
120-line anchor budget — 0.05 anchors per node against 2.67 for a leaf, 36x fewer
pointers back into the log, and 95% of the window consumed at 950k with nothing
left for output. The loop now walks leaves under the hard clock, with retain 0
and the floor off: "compact what you can" is the whole meaning of the command,
and the operator asked for it explicitly.

The condensation fanin is the one knob it keeps, and that is not a compromise. The
`fanin > 1` branch is the only place that also skips the checkpoints already on the
surface, so a manual run without it re-summarises its own last summary. Measured on
the real classes: after a first `/compact` and three fresh turns, the second run
selected exactly the previous checkpoint (seqs 23-23) and the surface went from one
depth-1 node to one depth-2 node; a repeat with nothing new at all threw
`ManualCompactionError("summary")` on the shrink gate (`337 >= 337`), spending a
model call to be told the summary could not be smaller than itself. "Do not
re-summarise my own summary" is not a guard an operator would ever waive, so the
manual path keeps the configured fanin. What that buys on the same session: two
compactions leave two depth-1 checkpoints, not one at depth 2.

The cost is honest: a 147k span becomes 7 calls, and the production-scale 436k span
would become about 19, run serially, so wall clock grows with the span even though
each call is smaller (`bench/REPORT.md` section 32). The hard clock
(`fullSweepMaxSeconds`) bounds the pass; whatever is left is picked up by the next
`/compact` or by an automatic sweep.

**A leaf call sends the span and the instruction, and nothing else.** It does not
replay the conversation's own system prompt. `dsh-compaction-basic` replays it,
and that is right for basic, which compacts the whole prefix in ONE call: paid
once, then absorbed by the provider's prefix cache. In a leaf backend the same
decision is paid once per leaf, and on a real 1M-window session the system prompt
is 411 154 characters: one 24 000-token leaf billed 137 304 input tokens of which
136 064 were that replay (99%) and took 90.4 s, while the identical leaf without it
billed 36 184 tokens in 32.0 s for the same six sections. It bought nothing even
when it hit the cache — `cacheRead` was 136 064 of 137 304 and the call still took
90 s, because a cached prefill is cheap in dollars and not in wall time. lcm-x
never sends the host system prompt either: its leaf is its own short contract plus
the transcript, with a bare user message as the fallback path.

## 2b. A threshold crossing is a sweep, not a tick

A crossing condenses until the raw prefix outside the retained tail is drained, not
until the threshold is merely re-cleared. This is lcm-x's
`threshold_full_sweep_enabled` (default True there) and it exists because of a
measured defect: on a real 1M-window session, crossing at 807 187 tokens (80.7%)
released one 24 000-token leaf and landed at 783 136 (78.3%), which is below the
800 000 threshold, so the loop returned. The next crossing released another single
leaf. The session sat welded to the threshold, paying one full model call per 2.4%
of window and never gaining real headroom.

Three bounds replace the threshold test:

| bound | default | why |
|---|---|---|
| `thresholdFullSweep` | `true` | the sweep itself; `false` restores one-leaf-per-crossing |
| `fullSweepMaxPasses` | `12` | lcm-x's constant; 12 × 24 000 is 28.8% of a 1M window |
| `fullSweepMaxSeconds` | `300` | NOT lcm-x's 120. The target is 0.25 × 750 000 = 187 500 and one leaf reclaims ~22 200, so 9 leaves at the measured 19.9 s median is ~180 s. A 120 s ceiling makes `target_reached` unreachable by construction |
| `fullSweepSoftSeconds` | `0` | 0 disables the soft stop, as lcm-x does for `force`. Measured: one 72.9 s leaf against a 60 s soft target ended a sweep after one leaf with a 187 500-token target untouched — a clock shorter than one leaf is the binding constraint, not a backstop |
| `fullSweepTargetShare` | `0.25` | what a sweep aims to reclaim: `threshold × 0.25` (lcm-x `_DEFAULT_SWEEP_TARGET_THRESHOLD_SHARE`). This is the stop condition; the soft clock only bounds a pass that cannot reach it |
| `fullSweepReserveSeconds` | `10` | slice of the hard ceiling kept for the commit and re-measure, lcm-x's `finalize_reserve` (theirs is `clamp(p90, 5, 20)`) |
| `leafEstimateFloorSeconds` | `15` | floor for the measured leaf cost the soft test uses, lcm-x's `_THRESHOLD_FULL_SWEEP_MIN_CALL_SECONDS` |

Exhausting either budget is a **partial** stop, not a failure: the last checkpoint
is returned and the next turn continues. That matches lcm-x, which records
`pass_budget_exhausted` / `time_budget_exhausted` and lets the session carry on.
The manual path (`requireBelowThreshold`, a model switch) keeps the old retry
budget, because "the sweep ran out of passes" is not an answer to "why can this
model not be admitted".

**Two clocks, not one, and the soft one is what stops the sweep.** lcm-x's
`ForegroundBudget` (`escalation.py:130`) splits the same budget into `soft` and
`hard`, and `admit()` applies three tests before a call may START:

```python
usable_left = (t0 + hard - reserve) - now
if not progress and usable_left < 15:      stop   # even the first call
elif estimate > usable_left:               stop   # does not fit the hard clock
elif now + estimate > t0 + soft:           stop   # would cross the soft target
```

`estimate` is the p90 of that route's last eight calls (cold 30 s, floor 15 s);
`reserve` is `clamp(p90(finalize), 5, 20)` — the commit and re-measure that
follow the last leaf. Our three tests are the same three, in the same order:
the hard clock, `now + leafWall > usableDeadline`, then
`now + leafWall > softDeadline`, with `usableDeadline = t0 + hard - reserve`.
The first pass is exempt from the last two, as in the reference: with nothing
measured yet, refusing it would mean never learning the leaf cost.

A single deadline was measured to be insufficient here: a 17 s leaf admitted
with 5 s left still ran, landing 12 s past the ceiling. Measured with a stub
sleeping 1.1 s per leaf under soft 10 s / hard 20 s, the three tests stop the
pass at 9 leaves and 9 916 ms where the hard ceiling alone allowed ~18.

**The idle continuation is what makes lcm-x's 120 s ceiling affordable.**
lcm-x does not compact in the background — its `threading` work is embedding
maintenance and rollup, never `compress()`. What it has instead is a next turn:
a partial sweep is resumed by the next `agent/pre-step`. Here that meant the
next thing the operator typed, so the drain arithmetic (31 leaves, 522 s) could
not be paid in one turn and the ceiling had to be 600 s. `_continueOnIdle`
removes the gap: when the agent reports `idle` — the signal the base engine
already trusts for clearing `overflowRetries` — the same automatic path runs one
more bounded pass. Nothing is mid-turn and no request is in flight, so a
compaction cannot race a live surface edit; one pass per session is enforced by
an in-flight set, and a failure is swallowed into the debug log because there is
no turn to fail. With that in place the clocks are lcm-x's own: **soft 60,
hard 120, reserve 10** (the midpoint of their 5..20), and the drain happens
over a few idle passes instead of one ten-minute block.

Measured: the whole job is still 31 leaves, because the floor is the system
prompt (100 541) plus the retained tail (149 514) = 250 055 and one leaf
reclaims 18 216. What changed is that each pass now stops predictably and the
next one starts on its own.

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
logarithmically. So before taking the oldest bytes again, selection looks for a run
of checkpoints at one depth and, when that run holds at least `condensationFanin`
nodes, merges the WHOLE run into one node one level up (`src/region.js:107`).

A run must sit at ONE depth, for a reason that is not stylistic: a run that mixes
depths would merge a parent with its own children, which is not condensation but
summarising a summary of itself. The end is then walked back until it is balanced,
and the merge is taken only when that cut was already balanced, so it never splits a
step.

One restriction does the limiting, and it is worth naming plainly so this section
does not overclaim. Selecting only the LEADING run — the first version of this rule —
condenses at most ONCE per session: the node it creates is then the leading node, so
the depth-1 siblings behind it can never lead again and the row behind it only grows.
Measured on that 40-round replay: one depth-2 node, then a flat row of depth-1 leaves
(`[2, 1 x 33]`, max depth 2, 34 checkpoints on the surface). Selection therefore takes
the first MAXIMAL same-depth run anywhere in the compactable window instead of only at
its head, which is what lets a second and a third rollup exist. What is still not
implemented: merging more than one run per compaction, and folding a run into an
existing node of the same depth.

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

The vector keys belong to the SEARCH row (`dsh-lcm/tool`), not to the engine row.
The engine declares and resolves them — its schema is a whitelist, so an
undeclared key is dropped when a patch re-route writes the configuration back —
but nothing in the compaction path reads one. Measured consequence of getting this
wrong: `vectorEnabled: true` on the engine row reads as enabled in
`--dump-config` while `lcm_search` stays lexical, because `resolveConfig({})` in
`src/tool.js` resolves an absent config to `{rank: "density", enabled: false}`.
The bundle patch, README, `config.example.yaml` and
`docs/PRODUCTION-INSTALL.md` all carried that mistake and are corrected.

Which events the semantic route ranks is a design decision, not a detail. It
ranks the events the current surface does NOT show — the compacted half — because
ranking the tail buys nothing: those messages are already in the model's context
verbatim. Measured on a 24 013-event session, a "newest N events" window covered
100% of the live tail and 1.6% of the compacted history, i.e. exactly the wrong
half. The window is priced in tokens (`vectorCandidateTokens`, default 100 000)
rather than in events, because cost tracks text length: on the measured endpoint
about 18 ms per text plus 0.23 ms per estimated token, and neither batching
(87–92 ms/text across batch sizes 8–128) nor concurrency (8 parallel POSTs:
205 ms/text, worse than serial) changes it. 100 000 tokens is ~200 compacted
events and ~19 s on a cold cache, then free per text. The shipped search row
carries 30 000, not the default: on a remote endpoint 2.6–5.1 s per 32-text
batch with a 65.6 s tail, a 200-event window was seven batches and the first live
search timed out. The window is a price, not a promise — how much of it one
search actually reaches is decided by the time budget below. The residual limitation is
stated in the result header on every call: older compacted events cannot be
reached by similarity at all, only by a lexical pattern, which is why
`rank: "hybrid"` is the setting that keeps them in the answer. A session that has
never compacted has no candidates and the hybrid result is the lexical one.

`/lcm-search` stays lexical on purpose and now rejects a vector rank instead of
accepting one it would ignore: it is answered inline at a prompt, and a ~20 s
stall is a thing a human feels, while the tool is where a wording mismatch
actually needs help.

### What bounds one search's embedding cost

A per-request timeout is not a bound on a search, and treating it as one was the
defect. The cost of one search is *the number of embedding POSTs it makes* times
the ceiling, and both factors grew without limit: a 60-event window at 32 texts
per POST is two batches, each of which may take `vectorTimeoutMs`; a transient
5xx is retried once, doubling it; a refused batch is bisected, which is
`2*log2(n) + 1` more requests (`n = 32` gives 11). On the shipped endpoint
(mistral-proxy/codestral-embed, 2026-11-09) eight consecutive 32-text batches
measured 2.6/5.1/3.0/65.6/2.6 s with one HTTP 500 mid-run, so the tail is real
and the arithmetic is not hypothetical: 2 batches x 20 000 ms = 40 s per search
before any retry or bisection, and a five-batch window is 100 s. That is the
mechanism behind the observed `timed out after 20000ms; fell back to lexical`,
and why a second search on the same session died the same way.

Three numbers bound one search now, and only the last one is a wall clock:

| bound | value | what it decides |
|---|---|---|
| the window | `vectorCandidateTokens` (30 000 shipped) | which texts a search may ask about at all |
| the per-request ceiling | `vectorTimeoutMs` (30 000 shipped) | how long one POST may take |
| the search budget | `DEFAULT_VECTOR_SEARCH_BUDGET_MS` (30 000), effective `max(30 000, vectorTimeoutMs)` | how long the whole embedding phase may take |

The budget is ONE absolute deadline for the call, created before the first
request. Every POST's timeout is `min(vectorTimeoutMs, deadline - now)`, and the
same deadline is threaded through the bisection descent and the cleaned-variant
retry, so a refusal cannot buy extra wall clock: `bisectionBudgetOf` still caps
the number of probes, and the deadline caps their cost. The budget is
`max(30 000, vectorTimeoutMs)` and not a new configuration key, for two reasons:
a raised per-request ceiling must never be silently shortened (that knob was set
by an operator for a reason), and the number is a safety bound against a stalled
endpoint rather than a performance setting — like `MAX_EMBED_BATCH`, raising it
only makes a stall longer.

Four behaviours follow, and each one is a case the old shape got wrong:

- **Work is one group at a time, newest candidate first.** The query leads
  (without it there is no ranking), then candidates from the newest end of the
  window, because recent-but-compacted is the likelier answer. A budget that runs
  out has then bought the half worth having instead of the oldest half.
- **Each group is written to the cache the moment it returns.** Before this, the
  whole embedding pass was written after the single tolerant call returned, and a
  throw discarded every vector the endpoint had already produced — so on a flaky
  endpoint a cold cache could never warm, and every search paid for the same
  texts and died at the same batch. Now a search that stalls half-way leaves its
  progress on disk and the next search resumes from there.
- **A stall costs the budget, once.** The first POST is capped at what is left;
  when the deadline passes, no further POST is sent. Measured with a
  never-answering endpoint, a 5 000 ms ceiling and a 1 200 ms budget: one request,
  1 217 ms total, instead of one request per batch at the ceiling.
- **Where the budget lands is visible, and why it stopped.** `rankByVector`
  reports `budgetExhausted` alongside `skipped`/`failedSeqs`, and a search that
  has the query plus some groups answers with a partial ranking rather than
  throwing. The dead-route cases still throw and still degrade to lexical: no
  query vector, or no candidate vector at all. `rank: "hybrid"` is the setting
  where a partial vector list is safe, because RRF keeps the lexical hits in the
  answer.

  `skipped` is a COUNT with two causes and `budgetExhausted` is the flag that
  separates them: a text the endpoint refused (the production HTTP 400 on exact
  bytes) leaves the same gap in the ranking as a deadline that cut the window
  short, and only one of the two is the budget. Measured counter-example: three
  candidates, one refused, healthy endpoint, no deadline spent, and the header
  that keys off `skipped` alone prints "embedding budget exhausted (1
  uncovered)". Anything rendering that gap reads `budgetExhausted` for the
  cause and `skipped` only for the size.
  The result HEADER says so too: a truncated call renders "N of M newest
  compacted event(s) ranked, embedding budget exhausted (K uncovered)" instead of
  claiming the whole window, because a window is a price, not a promise.

The backfill route is deliberately different, and does not share this budget.
Its row carries a long per-request ceiling (240 s shipped) so an offline pass can
ride out the endpoint's tail; a search deadline would throw that tolerance away.
Its bounds are instead `--limit` (how many texts one pass may consider), the
per-batch write (a stalled batch loses only that batch), and a circuit breaker:
two consecutive failed batches stop the pass, because a dead endpoint walking a
200-text window at a 240 s ceiling is twenty minutes of a blocked command.
Nothing is lost when it stops: what was embedded is on disk and the next
`--apply` resumes from the cache.

**The scope is the corpus, not the window, and that distinction is the whole
point.** The window (`vectorCandidateTokens`) is what ONE SEARCH may ask about,
priced newest-first; it is what `status` reports, because it answers "is the
route warm for this session". Filling only the window was measured to be a
trap: the window reported itself warm (`candidates 76 / cached 76 / pending 0`)
while the corpus was 4.0% covered (558 of 13 975), and because the window ROLLS,
events that left it were never embedded by any amount of ordinary use. The
reference implementation selects every missing row and treats `--limit` as a
per-pass cap; so does this.

**A capped pass advances.** `--limit` bounds the WORK, not the reach: uncached
texts are collected newest-first and only the first `limit` are attempted, so
`remaining` strictly decreases across passes. The first cut applied the limit to
the corpus before consulting the cache, which selected the same newest N every
time: `round 1 embedded 865 remaining 4179`, `round 2 embedded 0 remaining 4179`
— 4 179 texts unreachable by any number of re-runs.

`/lcm-embed status` answers the question the cache totals cannot: is the semantic
route warm for THIS session. It prints `candidates` (the priced window from the
calling session, via the same `collectVectorItems` the search and the backfill
use), `cached` (how many of those already have a vector on disk) and `pending`
(the rest, i.e. what a `--apply` would send now), plus the search budget so the
operator can see that one search reaches only the part of the window that fits.
It counts through the cache lookup only and issues no provider request, and it
reports zeros rather than guessing when the layer is off or the session exposes
no compacted events.

### Switching embedding models, and filling the cache

Three things make the model swappable rather than merely configurable:

| concern | how it is answered |
|---|---|
| a stale vector must never be read | the on-disk directory is `<cacheDir>/<12 hex of sha256(model)>-<dim>/`, and the per-text key is `sha256(model + "\n" + text)`; two models share neither a directory nor a key, and a wrong-width file is a miss (`bytes.byteLength !== dim * 4`) |
| the stale model must be deletable as one unit | `pruneForeignVectorCaches(cfg)` removes every sibling directory under the root except the current model/width one, and reports `{removed, bytes}`; `vectorCacheStats(cfg)` reports `{dir, model, dim, files, bytes}` for the live one |
| a fresh model must not cost a cold search | `/lcm-embed backfill` fills the whole compacted CORPUS (every hidden content event, no token budget) through the same `collectVectorItems` the search route uses and the same 4 000-character slice, so the keys written are the keys a search reads. `--window` opts into the priced window instead for a cheap warm-up; dry-run by default, `--apply` spends the calls, `--limit` caps one pass's WORK and each pass advances |
| one search's cost must be bounded | `rankByVector` runs the whole embedding phase under one deadline (`DEFAULT_VECTOR_SEARCH_BUDGET_MS`, effective `max(30 000, vectorTimeoutMs)`), and every POST — bisection probes and the cleaned-variant retry included — is capped at `min(vectorTimeoutMs, deadline - now)`; a stalled search cannot become `batches x ceiling`, and the arithmetic is in the section above |
| a search that has to stop must leave progress behind | groups of `MAX_EMBED_BATCH` are embedded and written to the cache one at a time, newest candidate first, so a stall costs the batch in flight and not the ones already paid for: the next search resumes instead of re-embedding, and a `--apply` after a stalled backfill continues from the cache |
| a dead endpoint must not block the operator | the backfill stops after two consecutive failed batches (`BACKFILL_FAILURE_LIMIT`, the lcm-x breaker threshold) and says so, rather than walking a 200-text window at the row's 240 s ceiling |

Why one implementation of the candidate rule and not two: which texts get
embedded is decided by four interacting rules — message-producing types only,
nothing still on the surface, a token-priced window, and the 4 000-character
slice that IS the cache key. A second copy would drift and fill keys no search
ever looks up, which looks like a working backfill and changes nothing.

Measured on a real 1M-window session (`bench`, no longer in the tree): 16 hidden
texts, dry run 0 requests, `--apply` 16 embedded in 2.7 s, second `--apply`
`already cached 16, embedded 0`, and `status` reporting 15 files / 92 160 bytes —
15 because two events with identical bodies share one cache entry.

**The bearer token is addressed, never stored.** `vectorApiKeyEnv` carries the
NAME of a variable; `resolveVectorAuth` reads `process.env[name]` first and then
the dsh credential store (`$DSH_HOME/.credentials.yaml`, top-level `refs:` block)
so a hosted gateway needs no exported variable and the repository never holds a
secret. `""` sends no header at all, which is what a keyless local backend wants.
`/lcm-embed status` prints which source answered — the one line that separates
"the layer is off" from "the layer is on and the gateway is refusing us".
Measured: with no environment variable at all, `source` is `credential-store`,
the header is `Bearer <35 chars>`, and the endpoint answers 200 with 1536 floats.

### How a configuration change reaches the running engine

Every one of the 28 keys is ordinary — none is declared `.volatile()`, and the
engine snapshots its resolved config into a frozen `this.config` in the
constructor, so there is nothing to update in place anyway. What happens on an
edit is therefore decided entirely by the host, and the answer differs by path:

- **Settings UI / `configEditor.edit`** — live, no process restart. The editor
  validates the candidate, writes the profile patch atomically, and reconciles
  through the normal Loader path; the loader then disposes that one row and
  re-runs the plugin with the new config
  (`cordis-plugin-loader/lib/index.js:498-521` → `_patchContext` →
  `fiber.update(config, true)` → `restart()` in `cordis/lib/index.js:752-775`).
- **Hand-editing the profile's `cordis.patch.yml`** — the same re-run *if* the
  `hmr` row is mounted (`dsh-base` mounts it by default and it chokidar-watches
  exactly `profile.patchPath`, `dsh-hmr/lib/index.js:850-872`). Without `hmr`
  nothing watches that file anywhere in this host — there is no `fs.watch`,
  `watchFile` or SIGHUP path in the compaction or profile-boot code — so the
  process must be restarted.
- **A bad value** fails at activation, and the row is left inactive rather than
  silently misconfigured: the schema rejects what it can at composition time, and
  `resolveConfig` throws for the rest. A failed hot update leaves
  `entry.options.config` holding the rejected value while the old instance keeps
  serving, so the next boot retries the same failure — the error is logged and the
  boot continues, which is why the value must be fixed rather than ignored.

One consequence worth stating: because the engine reads all 28 keys once at
construction, `/lcm-status` and the debug log reflect the config of the *running*
instance, not the file on disk.

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
| `thresholdRatio` | 0.75 | lcm-x's `context_threshold`, not basic's 0.8. On a 1M window this moves the trigger from 800 000 to 750 000 — 50 000 tokens of request headroom bought back for compacting slightly earlier |
| `headroomTokens` | 65536 | inherited from basic, unchanged |
| `retainRatio` | 0.05 | between basic's 0.16 and lcm-x's 24 000 tokens. The band arithmetic on a 1M window: 0.16 → tail 149 514 / floor 250 055 / compactable 499 945; **0.05 → 46 723 / 147 264 / 602 736**; 0.026 (lcm-x) → 24 296 / 124 837 / 625 163 |
| `summaryRatio` | 0.20 | with floor == cap == 2 000 it cannot win, which is the point: every leaf target is a flat 2 000 (lcm-x `leaf_target_ratio`) |
| `summaryFloorTokens` | 2000 | lcm-x `leaf_target_min_tokens`; also the selector's span floor doubled, so a span ≤ 4 000 is refused before a call is paid for |
| `checkpointCap` | 2000 | lcm-x `leaf_target_max_tokens`, equal to the floor on purpose — that equality is what makes the target fixed |
| `leafSpanTokens` | 24000 | one leaf per compaction, oldest first (section 2) |
| `condensationFanin` | 4 | same-depth run that folds into one node (section 3) |
| `stallCooldownMs` | 60000 | hold deadline for a stalled session (section 5); 0 disables |
| `anchorPointers` | true | local computation over events already in memory, no request |
| `emptySummaryRetries` | 2 | three attempts on the same prompt before the ladder's bottom rung |
| `backgroundLeafPrep` | false | pre-compute the next leaf while idle; lcm-x's `background_leaf_prep_enabled`, which also ships `False` |
| `compactionRetries` | 1 | one extra pressure attempt, then the real diagnosis |
| `maxOverflowRetries` | 1 | one forced reduction per confirmed overflow |

The FORMULA is basic's, verbatim — the two ratios feeding it are lcm-x's:

```
messageBudget    = contextWindow - reservedCompletionTokens
pressureBudget   = messageBudget - headroomTokens
thresholdTokens  = floor(min(contextWindow * 0.75, pressureBudget))   # was min(..., * 0.8)
retainTokens     = retainTokens ?? floor(messageBudget * 0.05)         # was floor(messageBudget * 0.16)
```

Why those two and not basic's: the macOS build session sat at 97% of an 0.8
threshold across 20 sweeps in two days, because a 60 s soft target only runs 3-4
leaves per crossing while the band it has to drain was the smallest of the three
candidates. 0.75 buys 50 000 tokens of headroom on the request; 0.05 buys back
103 000 tokens of compactable band without going all the way to lcm-x's 24 000,
which this engine's coarser leaf summaries are not tuned for.

The target formula keeps its shape but its three constants now reproduce the
reference exactly:

```
targetTokens = min(clamp(shadowed * 0.20, 2000, 2000), maxTokens)
             = 2000                     for any span, which is lcm-x's
                                        min(2000, max(2000, span * 0.20))
```

Floor equal to cap is what collapses it. A ratio that cannot win reads like a
bug, so the reason is recorded here and in `src/config.js`: the reference fixes
its leaf target at 2 000 by setting `leaf_target_min_tokens` and
`leaf_target_max_tokens` to the same number, and matching the behaviour means
matching the equality rather than approximating it with a ratio.

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
