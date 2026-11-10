# Changelog

## 0.15.1 — 2026-11-10 — conform to the awesome-dsh-plugin submission rules

Read `awesome-dsh-plugin/contributing.md` and checked dsh-lcm against every rule
it states. Four were not met; three are fixed here.

### Fixed — `@deepseek-ai/schemastery` was a dependency

The guide requires official `@deepseek-ai/*` packages to be
`peerDependencies`, because the harness already ships them and a second copy is a
version-skew bug waiting to happen. `schemastery` was the only one left in
`dependencies`; it is now a peer alongside the other seven, and `dependencies` is
empty. Verified it still resolves at runtime from the linked plugin to the
host's copy (`…/dsh/node_modules/@deepseek-ai/schemastery`).

### Fixed — the peer ranges silently excluded the next patch prerelease

This is the trap the guide calls out, and we were in it. node-semver admits a
prerelease only when some comparator sits on the SAME `major.minor.patch` tuple
and itself carries a prerelease tag, so `^0.2.2-0` accepted `0.2.2-rc.1` and then
rejected `0.2.3-rc.1` — an ERESOLVE for everyone on the next harness patch.

The ranges now enumerate tuples with an explicit prerelease tag on each:

```
>=0.2.2-0 <0.3.0-0 || >=0.2.3-0 <0.3.0-0 || >=0.2.4-0 <0.3.0-0 || >=0.2.5-0 <0.3.0-0
```

Verified: accepts the installed `0.2.2-rc.1`, the future `0.2.3-rc.1` /
`0.2.4-rc.1` / `0.2.5-rc.1` and the stable `0.2.5`, while still refusing
`0.1.7-rc.2` and `0.3.0-rc.1`. The test that guarded this previously only checked
the installed version and a stable, which is why the gap survived; it now probes
both future shapes and both refusals per peer.

### Added — `peerDependenciesMeta`, all `optional: true`

The established pattern among listed plugins, and it matters here: the harness
provides these through its own tree, so a profile that resolves them differently
should get a warning rather than a blocked install. Eight entries, one per peer.

### Added — the marketplace entry itself

`awesome-entry.yml` — the one file a submission is. Validated against the list's
own reader: category `session`, both locales present, single-line descriptions,
the English one quoted because it contains `: `, and the filename derived the way
their `slugFor()` derives it (`zy-xyz__dsh-lcm.yml`).

### Still open

- **The `dsh-plugin` GitHub topic** was missing and is now set on the repository.
- **No npm publish and no Release tarball.** The guide makes a `tarball` required
  only when the repo cannot be installed from source, and this one can: verified
  `dsh plugin --profile <p> add github:zy-xyz/dsh-lcm` installs 0.15.0 with the
  bundle manifest intact. A Release tarball would still cut the 1m51s
  build-from-source install.
- **Four stray scripts at the repo root** (`acon-after.mjs`, `acon-final.mjs`,
  `basic15.mjs`, `leaf-answer2.mjs`) are committed and referenced by nothing. A
  reviewer reads the repository, so they are noise.

Tests: 289, unchanged in count; the peer-range test gained the assertions above.
## 0.15.0 — 2026-11-10 — an idle continuation, so the clocks can be lcm-x's own

The soft target left a real gap: a sweep stops with the session still over
threshold, and the only thing that resumed it was the next `agent/pre-step` —
i.e. the operator typing something. lcm-x has no such gap, but not because it
compacts in the background: its `threading` work is embedding maintenance and
rollup, never `compress()`. What it has is a next turn.

### Added — `_continueOnIdle`

When the agent reports `idle` — the signal the base engine already trusts for
clearing `overflowRetries` — one more bounded pass runs through the SAME
automatic path, so every guard still applies: threshold, retained tail, span
floor, and its own two clocks. Nothing is mid-turn and no request is in flight,
so a compaction cannot race a live surface edit. An in-flight set keeps it to one
pass per session (a second would only re-measure the same surface and lose the
race), and a failure is swallowed into the debug log because there is no turn to
fail.

### Changed — the clocks go back to lcm-x's numbers

| key | 0.14.0 | 0.15.0 |
|---|---|---|
| `fullSweepMaxSeconds` | `600` | `120` |
| `fullSweepSoftSeconds` | `300` | `60` |
| `fullSweepReserveSeconds` | — | `10` |

600 was the workaround for having no continuation: the drain is 31 leaves at
17.3 s = 522 s, so one turn had to fit it. With the idle pass the same 522 s is
paid over a few turns of idle instead of one ten-minute block, and the ceiling
can be lcm-x's 120.

### Added — the third admission test, and the finalize reserve

`admit()` in the reference applies three tests before a call may START, and we
only had two of them:

```
usable_left = (t0 + hard - reserve) - now
if not progress and usable_left < 15:      stop   # even the first call
elif estimate > usable_left:               stop   # does not fit the hard clock
elif now + estimate > t0 + soft:           stop   # would cross the soft target
```

The missing one is the middle: `now + leafWall > usableDeadline`. Without it a
leaf could be admitted 5 s before the ceiling and run 17 s past it — the exact
failure the reserve exists to prevent. `usableDeadline` is now
`t0 + hard - reserve` with `fullSweepReserveSeconds` defaulting to 10, the
midpoint of lcm-x's `clamp(p90(finalize), 5, 20)`.

### Measured

| probe | result |
|---|---|
| three tests, soft 3 s / hard 6 s / reserve 1 s, 0.7 s per leaf | 3 leaves, 2 107 ms — stops on the soft target |
| reserve 2 s of a 4 s ceiling, 0.5 s per leaf | ≤ 4 leaves, inside 4 000 ms |
| idle hook, twice in a row | second call ignored (in-flight stays 1) |
| idle hook, full pass | 12 leaves, guard released afterwards |
| idle hook under threshold | 0 leaves, guard released, no throw |

Tests: 286 → 289.
## 0.14.0 — 2026-11-10 — the sweep gets a soft target, and the ceiling is sized by arithmetic

Reported symptom: "past 80% it barely compacts anything". The cause was
arithmetic, not a defect: one leaf spans 24 000 tokens and its checkpoint lands
at ~5 784, so a leaf reclaims 18 216. The floor is the system prompt (100 541)
plus the retained tail (149 514) = 250 055, so draining from the 800 000
threshold needs `(800 000 - 250 055) / 18 216 = 31` leaves. At the measured
17.3 s per leaf that is **522 s**, and the ceiling was **120 s** — about six
leaves. Every sweep therefore landed back at ~70% of the window, which is
indistinguishable from "it did nothing".

### Changed — the hard ceiling is 600 s, derived rather than picked

`fullSweepMaxSeconds: 120 → 600`. That is the 522 s drain plus one leaf of
slack. lcm-x's 120 is not comparable: it is their HARD ceiling with a 60 s soft
target, and their sweep continues on the next turn because a background pass
schedules one. Nothing does that here, so one turn has to reach the floor.

### Added — the soft target, and the estimate that makes it meaningful

lcm-x's `ForegroundBudget` has two clocks: `hard` bounds a call already running
(no budget can interrupt it) and `soft` decides when a call may no longer
START. Without the soft layer our deadline was a pure wall clock, so a 17 s leaf
admitted with 5 s left still ran and landed 12 s past the ceiling.

| key | default | meaning |
|---|---|---|
| `fullSweepMaxSeconds` | `600` | hard ceiling for the whole sweep |
| `fullSweepSoftSeconds` | `300` | stop STARTING leaves here; half the ceiling, the same ratio as lcm-x's 60 of 120 |
| `leafEstimateFloorSeconds` | `15` | floor for the measured leaf cost, lcm-x's `_THRESHOLD_FULL_SWEEP_MIN_CALL_SECONDS` |

The loop measures each leaf's wall and refuses to start another when
`now + leafWall > softDeadline`. The first pass is exempt: with nothing measured
yet, refusing it would mean never learning the leaf cost. The floor stops one
fast condensation pass from claiming its successor will also be fast.

Measured with a stub that sleeps 1.1 s per leaf, soft 10 s and hard 20 s:
**9 leaves, 9 916 ms**, stopping on the soft target. The hard ceiling alone
would have allowed ~18 leaves and 20 s.

Tests: 286, unchanged in count — the two new keys joined the config-surface
sample table and the sweep default test, which now states the arithmetic.
## 0.13.0 — 2026-11-10 — the backfill fills the CORPUS, and a capped pass advances

Two defects, both found by running the backfill against real sessions rather than
by reading code. The first is why the embedding layer looked "fully updated"
while it was not.

### Fixed — `backfill` only ever filled the search WINDOW

`embedCandidates` called `collectVectorItems` with the priced window
(`vectorCandidateTokens`, 30 000 shipped), so a backfill could only ever fill
the newest ~76 events of a session. The window then reported itself warm
(`candidates 76 / cached 76 / pending 0`) while the corpus was 4.0% covered:

```
会话              隐藏事件   已缓存   缺
1165f0e1-3c3       5180      167   5013
d7951a68-b17       4228       88   4140
TOTAL  13975  |  558  |  13417  |  4.0%
```

And the window ROLLS: events that leave it were never embedded at all, so no
amount of ordinary use would ever fill them.

The reference implementation's `/lcm embed backfill` selects every missing row
in the store and uses `--limit` only as a per-pass cap. `backfill` now does the
same: `scope: "corpus"` by default (every compacted content event, no token
budget), with `--window` opting back into the priced window for a cheap warm-up.
Both scopes still go through `collectVectorItems` and the same 4 000-character
slice, so the keys written are the keys a search reads.

### Fixed — a capped pass could never reach past the newest N

`--limit` was applied to the CORPUS before the cache was consulted, so every
pass selected the same newest N, found them all cached, embedded 0 and reported
the same `remaining` forever. Measured on a 5179-text session with `--limit 1000`:

```
round 1 | corpus 5179 | embedded 865 | remaining 4179
round 2 | corpus 5179 | embedded    0 | remaining 4179   <- stuck
```

4179 texts were unreachable by any number of re-runs. The limit now bounds the
WORK: uncached texts are collected newest-first and only the first `limit` are
attempted, so each pass advances and `remaining` strictly decreases.

### Added — the report says what the scope and the remainder are

`{ corpus, remaining, scope }` join the report, and the text prints
`corpus: N hidden text(s)` (the whole selection) next to `scanned: M` (what this
pass walked), plus a `remaining:` line that names the next step. Printing only
the second made a capped pass look like it had covered everything.

### Changed — the shipped source defaults name the endpoint that answers

`DEFAULT_VECTOR_BASE_URL` / `DEFAULT_VECTOR_MODEL` / `DEFAULT_VECTOR_DIM` still
named a LAN LM Studio serving a 4096-d model, which no longer answers. They now
name the OmniRoute endpoint the bundle rows already use (`codestral-embed`,
1536). A default pointing at a dead host is worse than one pointing at a host
that answers 401, because the 401 names the problem. The layer stays opt-in, so
no existing setup changes.

Tests: 285 → 286, including one that runs three capped passes and asserts all
eight texts are reached exactly once.
## 0.12.1 — 2026-11-10 — a third-party surface must not break the semantic route

Found while filling the live cache, not by reading code: the backfill probe died
on one session with

```
session event "user/message" sourceEventSeqs must densely contain non-negative safe integers
```

The event was not ours. `seq 2707` in `session-b7c19116` carries
`source.kind: "dsh-rewind"` and `sourceEventSeqs: [[2684,2686],2690,2693]` —
nested ranges where the harness fold requires dense non-negative integers — and
the session had zero compactions. A lexical search on it answered normally; a
HYBRID search threw, because `visibleSeqs` reads `session.surface` and the fold
rejects that event. One plugin was breaking a route it never meant to touch, and
the failure mode was a thrown exception rather than a degradation.

`visibleSeqs` now treats an unreadable surface as UNKNOWN (returns null) instead
of propagating. That is the conservative direction: every event then counts as
unread, so the candidate window widens — more cost, no coverage lost — instead
of throwing or silently narrowing to nothing. Verified on the same session:
hybrid now answers with 20 hits and the ordinary backend-degradation notice.

Pinned by `[degradation] a surface the harness fold refuses does not throw the
semantic route`, whose fixture throws from `session.surface` exactly as the real
fold does.

### Live cache filled

Every session under the workspaces root, priced with the shipped embed-row
window: 25 sessions touched, 373 candidates scanned, 294 already cached, 79
embedded, 0 failed. The live cache now holds 315 vectors / 2.8 MB, and
`/lcm-embed status` on the main session reports `candidates 76 / cached 76 /
pending 0`.

Tests: 284 → 285.
## 0.12.0 — 2026-11-10 — a search gets one deadline, and the window is a price

The first live search after switching to `mistral-proxy/codestral-embed` degraded
with `timed out after 20000ms; fell back to lexical`, and every retry died the
same way. Two defects, one design and one code, plus a coverage gap.

### Design — a per-request timeout is not a bound on a search

The cost of one search is *the number of embedding POSTs it makes* times the
ceiling, and both factors grew without limit: a 60-event window at 32 texts per
POST is two batches, a transient 5xx doubles it, and a refused batch is bisected
into `2*log2(n)+1` more requests (11 at n=32). On the shipped endpoint the tail
is real (2.6/5.1/3.0/65.6/2.6 s over eight batches, one HTTP 500), so two
batches at a 20 s ceiling is 40 s per search and a five-batch window is 100 s.
Nothing in the code bounded the SEARCH; only the POST.

Now one search runs its whole embedding phase under ONE absolute deadline
(`DEFAULT_VECTOR_SEARCH_BUDGET_MS = 30 000`, effective
`max(30 000, vectorTimeoutMs)` so a raised per-request ceiling is never silently
shortened). Every POST is capped at `min(vectorTimeoutMs, deadline - now)`, and
that deadline is threaded through the bisection descent and the cleaned-variant
retry, so a refusal cannot buy extra wall clock. A request whose budget is gone
fails with `budget: true` — never retried, never mistaken for a poison verdict.

Measured with a stub that answers every batch after 400 ms, 100 candidates and a
900 ms budget: 913 ms total, 3 requests, 8 ranked, 37 uncovered,
`budgetExhausted: true` — and 64 vectors left on disk.

### Bug — a partially successful search persisted nothing

`rankByVector` wrote the cache only AFTER the single `embedTextsTolerant` call
returned, so a timeout discarded every vector already produced: on a flaky
endpoint a cold cache could NEVER warm, and every search re-paid for the same
texts and died at the same batch. The unit of progress (the batch) was not the
unit of persistence — the same shape as the backfill bug fixed in 0.11.1.

Work now proceeds one `MAX_EMBED_BATCH` group at a time, query first then
candidates newest-first (a budget that runs out has bought the likelier half),
and each group is written the moment it returns. Measured on the same stub: a
second search issues 2 requests instead of 3, resuming from what the first left
behind. A search that has the query plus some groups answers with a partial
ranking; only a dead route (no query vector) still throws and degrades.

### Fixed — the result header claimed coverage it did not have

The header rendered "N newest compacted event(s)" with N = the WINDOW, so a
budget-truncated call claimed more coverage than it reached. It now renders
"N of M newest compacted event(s) ranked, embedding budget exhausted (K
uncovered)" from `ranked.skipped`. A window is a price, not a promise.

### Added — `/lcm-embed status` reports the candidate window

The cache totals could not answer "is the semantic route warm for THIS session".
It now prints `candidates` (the priced window from the calling session, via the
same `collectVectorItems`), `cached`, `pending` (what one `--apply` would embed
now) and the search budget. Read-only: cache lookups only, zero provider
requests, zeros instead of guesses when the layer is off or nothing is compacted.
Measured on the live session: `candidates 76 / cached 76 / pending 0`.

### Changed — the two rows now price the same window

`command-lcm-embed` dropped from `vectorCandidateTokens: 100000` to `30000` to
match the search row: status prices from the embed row, so a different number
there would report a pending count the search never asks for, and a backfill
would warm texts no search reads.

### Coverage — the vector layer now has a matrix, not anecdotes

Five new files, 37 tests, every one a named assertion against a local stub:
cache (corrupt widths, concurrent writers, per-model isolation, prune on a
populated and a missing root), backend (5xx once vs twice, 429 not retried,
non-JSON, wrong dimension, wrong count, empty input, a 400 bisecting to 12
requests instead of 32, the cleaned variant exactly once), auth (three sources
and the no-header default), search route (layer off byte-identical to lexical,
candidate window excludes the visible tail and log plumbing, token budget edges),
/lcm-embed (dry-run zero requests, second `--apply` a pure hit, `--limit`, ten
malformed arguments) and degradation (six backend failure modes plus a dead port,
each returning lexical + one notice and never throwing; abort honoured and not
retried).

Tests: 247 → 284.
## 0.11.1 — 2026-11-09 — the remote endpoint is slow, so the layer is tuned for it

First live search after switching to `mistral-proxy/codestral-embed` degraded to
lexical: `vector backend unreachable: … timed out after 20000ms`. The auth path
worked (a 401 would have said so) and the model was right; the SHAPE of the layer
was tuned for the backend it replaced.

Measured on the shipped endpoint, eight consecutive 32-text batches:

```
32 x 4000 chars -> 200 2641ms
32 x 4000 chars -> 200 5126ms
32 x 1000 chars -> 200 3011ms
32 x 1000 chars -> 200 65555ms   <- the tail
32 x 4000 chars -> 200 2570ms
```

A local LM Studio answered in ~30 ms/text; this endpoint answers in 2.6-5.1 s per
batch with a 65.6 s tail, and a longer run produced one HTTP 500. Three changes
follow from that.

### Fixed — one HTTP 500 aborted a whole backfill pass

`requestBatch` now retries once on a transient failure (5xx or transport) after
250 ms, and never retries a timeout: the wall clock was already spent, and a
second 20 s wait inside a live search is worse than degrading to lexical. A
payload verdict (400/413/422) is still never retried — that belongs to the
bisection path. Pinned by a stub server that fails the first request and by one
that refuses every payload, with the assertion that no identical body is sent
twice.

### Fixed — a backfill wrote nothing until every batch returned

`embedBackfill` embedded the whole pending set in one call and only then wrote
the vectors, so a stall or a 5xx discarded every batch before it: measured, one
65 s stall plus one 500 lost a 76-event pass entirely. It now embeds one
`MAX_EMBED_BATCH` (32) at a time and writes as each returns, so paid work
survives and a re-run resumes from the cache. A batch the endpoint refuses
outright is counted in `failed` instead of vanishing.

### Changed — the candidate window and the timeout are sized for a slow endpoint

| key | before | after |
|---|---|---|
| `vectorCandidateTokens` (search row) | `100000` (~200 events, ~7 batches) | `30000` (~60 events, 2 batches) |
| `vectorTimeoutMs` (search row) | default `20000` | `30000` |
| `vectorTimeoutMs` (backfill row) | default `20000` | `240000` |

The search row has to answer interactively, so it keeps a short leash and
degrades; the backfill row is offline work and waits out the tail. Once the cache
is warm the window costs nothing, which is what `/lcm-embed backfill` is for.

Measured after warming three sessions into the live cache root: 100 vectors /
874 KB written, 76 events for one session in 43.6 s and 24 for another in 2.5 s,
`failed 0`.

Tests: 246 → 247.
## 0.11.0 — 2026-11-09 — the embedding model is swappable, and the cache can be filled

Three gaps stood between "the vector layer is configured" and "the vector layer
works on an existing log". The reference implementation (lcm-x) answers all three
with `/lcm embed backfill` plus a `vector_profiles` table keyed by model identity;
this closes them the same way.

### Added — `/lcm-embed status` and `/lcm-embed backfill [--apply] [--limit N]`

`backfill` walks the same candidate set the search route embeds and writes the
same cache keys, dry-run by default (lcm-x semantics: the count is a preview
until the operator types `--apply`). `--limit` keeps the newest N, default 200.
`status` reports model, width, cache directory, files, bytes, the auth source,
and whether the layer is on at all.

The candidate rule is NOT duplicated: `collectVectorItems` is now exported from
`src/search.js` and the command calls it. Which texts get embedded is decided by
four interacting rules — message-producing types only, nothing still on the
surface, a token-priced window, and the 4 000-character slice that is the cache
key — and a second copy would drift into filling keys no search ever reads.

Measured on a real 1M-window session against the live endpoint: 16 hidden texts,
dry run 0 requests, `--apply` 16 embedded / 0 failed in 2.7 s, second `--apply`
`already cached 16, embedded 0`, `status` 15 files / 92 160 bytes (15 because two
events with identical bodies share one entry).

### Added — the bearer token can come from the dsh credential store

`resolveVectorAuth(cfg)` reads `process.env[vectorApiKeyEnv]` first, then
`$DSH_HOME/.credentials.yaml` (or `$HOME/.dsh/`) top-level `refs:` block, and
returns `{ header, source }` with `source ∈ env | credential-store | none`. The
secret appears only in the header — never logged, never returned. This is what
makes a hosted gateway work with no exported variable and no secret in the
repository; `""` still sends no header, so keyless backends are unchanged.

Verified against the real store with the environment variable deleted: source
`credential-store`, `Bearer <35 chars>`, endpoint 200 with 1536 floats.

### Changed — the on-disk cache is per model

Directory moved from `<cacheDir>/` to `<cacheDir>/<12 hex of sha256(model)>-<dim>/`.
Per-text key unchanged. A stale model is now one deletable unit instead of
indistinguishable live bytes: `vectorCacheStats(cfg)` reports what the current
model holds and `pruneForeignVectorCaches(cfg)` removes every other sibling.
No migration — entries written under the old flat layout are simply never read
again (706 of them sit in this repository's `bench/.lcm-vectors`; delete by hand
if wanted, `prune` only removes sibling directories).

### Fixed — the embed row would have silently reverted to the search family

`commandSet` and the vector block were first left undeclared in the command row's
`Config`, on the belief that schemastery re-merges unknown keys. It does not:
`validate` keeps them, `simplify` — whose output a `fiber.update` re-route writes
back — drops them, measured. An undeclared `commandSet` therefore survived until
the operator changed any setting, then reverted the embed row to the default
`search` family and re-registered `/lcm-search` where the search row already owns
it, which the command registry aborts on. Both the key and the vector block are
now declared, and `test/compat.test.js` pins the row to the full set.

Tests: 236 → 246.


## 0.10.0 — 2026-11-09 — the semantic route can authenticate, and points at OmniRoute's codestral-embed

### Added — `vectorApiKeyEnv`

The vector layer sent no `Authorization` header, which was correct for its only
measured backend (a local LM Studio) and is a 401 against any hosted gateway.
The new key carries the **name** of an environment variable; the value is read
from the process environment when a request is built, so an operator can rotate
the secret without a rebuild, and the composition — which ships in this
repository — never contains it. `""` (the default) sends no header at all, so
keyless backends are unchanged byte for byte.

Measured on `http://10.126.126.4:20128/v1`: with `OMNIROUTE_API_KEY` set the
embedding call returns 1536 floats (unit norm, no NaN) in ~1.2 s for three texts;
named-but-unset returns `HTTP 401 {"error":{"code":"AUTH_002"...}}`, which the
per-item degradation already turns into a lexical fallback with a notice.

### Changed — the shipped default is OmniRoute's codestral-embed

| key | before | after |
|---|---|---|
| `vectorBaseUrl` | `http://10.126.126.3:1234/v1` (LM Studio) | `http://10.126.126.4:20128/v1` (OmniRoute) |
| `vectorModel` | `text-embedding-qwen3-vl-embedding-8b` | `mistral-proxy/codestral-embed` |
| `vectorDim` | `4096` | `1536` |
| `vectorApiKeyEnv` | — | `OMNIROUTE_API_KEY` |

Probed before switching: 1536 dimensions, batch 32 accepted, CJK accepted, a 6k
char text accepted, empty string refused with HTTP 400 (skipped per-item by the
existing degradation), and five consecutive calls on the undated name answered
200 in 1.1-10.5 s. The dimension change needs no cache migration: the on-disk key
is `sha256(model + "\n" + text)`, so entries from the 4096-d model are never read.

Tests: 235 → 236. `test/vectors.test.js` now records `authorization` on its stub
server and asserts the three states (unset variable, set variable, not configured)
on the wire; `test/compat.test.js` learned that `vectorApiKeyEnv`'s empty string
is a documented legal value rather than a bad one.

## 0.9.0 — 2026-11-09 — a threshold crossing now sweeps, and a leaf no longer pays for the system prompt

Two defects found on a real 1M-window production session (`session-65bd8898`,
"用 agent 团队在 FNOS 上构建 macOS kShim 双系统"). Both are the kind that look like
"compaction ran and did nothing".

### Fixed — a crossing released ONE leaf and stopped

Measured: crossing at 807 187 tokens (80.7%) released a single 24 000-token leaf,
landed at 783 136 (78.3%) — below the 800 000 threshold — and returned. The next
crossing released another single leaf. The session stayed welded to the threshold,
paying one full model call per 2.4% of window, and the UI kept reading 78%.

That is not lcm-x's design. lcm-x has `threshold_full_sweep_enabled` (default
True): a crossing raises the leaf-pass budget to 12 and runs until the raw backlog
outside the fresh tail is drained (`compaction.py:2313`, `2623-2626`), bounded by
`_THRESHOLD_FULL_SWEEP_MAX_PASSES = 12` and
`_THRESHOLD_FULL_SWEEP_MAX_SECONDS = 120`.

Three new keys, all matching lcm-x's constants:

| key | default | meaning |
|---|---|---|
| `thresholdFullSweep` | `true` | a crossing sweeps; `false` restores the tick |
| `fullSweepMaxPasses` | `12` | leaves one sweep may release |
| `fullSweepMaxSeconds` | `120` | wall-clock budget for one sweep |

Exhausting either budget is a partial stop that returns the last checkpoint and
lets the next turn continue — lcm-x's `pass_budget_exhausted` /
`time_budget_exhausted` — not an error. The manual path keeps the old retry
budget: a model switch that cannot reach the threshold must say so.

### Fixed — every leaf replayed the conversation's 411 154-character system prompt

`summarizeLeaf` prepended the conversation's own system prompt to every leaf
request, copying `dsh-compaction-basic` (which replays it because basic compacts
the whole prefix in ONE call, so it is paid once). In a leaf backend the same
decision is paid once per leaf, and on this session it was 99% of the request:

| leaf request | input tokens | cacheRead | wall clock | output |
|---|---:|---:|---:|---|
| with the system prompt (before) | 137 304 | 136 064 | 90.4 s | 7 376 chars, 6 sections |
| without it (after) | 36 184 | 0 | 32.0 s | 7 158 chars, 6 sections |

3.8x cheaper and 2.8x faster for the same output. The cache did not save the wall
clock: `cacheRead` was 136 064 of 137 304 and the call still took 90 s, because a
cached prefill is cheap in dollars and not in time. Twelve leaves at 90 s is 18
minutes; at 32 s it is 6.4, which is what makes a sweep usable.

lcm-x never sends the host system prompt: its leaf request is its own short
contract plus the transcript as user data, with a bare `[{role:"user", ...}]` as
the fallback path. The instruction already carries the contract, so the span and
the instruction are now the whole request.

Tests: 228 → 235. `test/threshold-sweep.test.js` pins the sweep, its two budgets,
the partial stop, the disabled fallback, and the manual path;
`test/summarizer-parity.test.js` now asserts the system prompt is absent rather
than present.

## 0.8.0 — 2026-11-09 — five defects found by auditing against the LCM paper

An audit of the deployed engine against the paper's invariants and against real
production logs turned up five defects. Every one has a reproduction in the
message that introduced it and a test that fails without the fix.

### Fixed — condensation fired exactly once per session

Selection merged only the LEADING same-depth run. Once one depth-2 node existed it
WAS the leading run, so the depth-1 siblings behind it could never lead again and
condensation became unreachable: measured on a 40-round replay, round 7 merged to
`[2]` and rounds 8-40 appended one depth-1 leaf each until the surface read
`[2, 1 x 33]` — max depth 2, 34 checkpoints on the surface, 49 surface nodes, and
the assembled context growing linearly, which is the exact failure the fanin
exists to prevent.

Selection now takes the first MAXIMAL same-depth run anywhere in the compactable
window. Two corrections matter and both are stated in `src/region.js`: the WHOLE
run must be merged (stopping at `fanin` nodes would leave same-depth siblings to
the right of a depth `d+1` node, an inversion the merge itself creates), and
"maximal" must hold on the whole surface (a run cut by the retained tail cannot be
merged without parking a rollup in front of a leaf it never absorbed). Same replay
after the fix: max depth 3 reached at round 23, 6 checkpoints on the surface,
21 surface nodes (peak 28), positional depths non-increasing at every round.

### Fixed — `/compact` re-summarised its own last summary

`compactNow` passed three arguments, so `fanin = 0` and the `fanin > 1` branch —
which is the ONLY place that skips checkpoints already on the surface — never ran.
Every manual compaction therefore started its leaf at the previous checkpoint:
measured, the second `/compact` selected exactly `seqs 23-23` and the surface went
from one depth-1 node to one depth-2 node; a repeat with nothing new threw
`ManualCompactionError("summary")` on the shrink gate (`337 >= 337`), spending a
model call to be told the summary could not be smaller than itself. The manual
path now passes the configured fanin and nothing else — floor, leaf cap and
retention stay off — and the repeat case returns `null` cleanly.

### Fixed — `condensationFanin: 1` silently disabled condensation

Both the schema and the runtime validator accepted 1, and 1 makes the guard
`fanin > 1` false: the automatic path lost condensation and the checkpoint skip
together. Floored at 2 in both layers, with an error that names the consequence.

### Fixed — the semantic layer was enabled on a row that never reads it

`vectorEnabled: true` and its siblings sat on the `compaction-lcm` row. The engine
declares and resolves them but the compaction path never reads one, while the row
that DOES read them (`tool-lcm-expand`) had no config at all:
`resolveConfig({})` resolves to `{rank: "density", enabled: false}`, so the layer
was off in production while `--dump-config` showed it on. Moved to the tool row
with `rank: hybrid`, and `/lcm-search` now rejects a vector rank instead of
accepting one it would ignore.

### Fixed — the semantic candidate window pointed at the wrong half

The first bound took the newest N events. Measured on a 24 013-event session that
covered 100% of the live tail — the messages already in the model's context
verbatim — and 1.6% of the compacted history, which is the only region a
retrieval tool exists to reach. Candidates are now the events the current surface
does not show, priced in tokens (`vectorCandidateTokens`, default 100 000) rather
than in event count, because cost tracks text length: ~18 ms per text plus
~0.23 ms per token on the measured endpoint, and neither batching (87-92 ms/text
across batch sizes 8-128) nor concurrency (8 parallel POSTs: 205 ms/text, worse
than serial) changes it. Every result header states the region actually covered.

### Fixed — `/lcm-status` reported the target as if it were the result

"kept" summed `maxTokens`, which is the summary TARGET the instruction asked for.
On the production checkpoint that published `371 625 -> 16 384 kept (22.68:1)`
where the produced body is 6 183 tokens (`60.10:1`). Now measured from the
event's own summary blocks with the same estimator the engine states its budgets
in.

### Fixed — the 120-line anchor bound was prose, not code

The instruction asks for at most 120 anchor lines; nothing counted them and the
model wrote 262 (38% of the whole checkpoint), including lines holding nothing but
a backtick and lines that copied the instruction's OWN headings into the word
list — strings that, pasted into `lcm_search`, match the checkpoint that contains
them. The post-hoc attribution pass now drops non-content anchors and enforces the
bound deterministically: unverified lines go before verified ones, most-repeated
before unique, later-listed before earlier. Replaying the production checkpoint
through the fixed pass: 262 lines to 120, every kept line carrying a pointer, six
sections intact.

## 0.7.0 — 2026-11-08 — compact in leaves, not in one ever-deeper checkpoint

### Changed — the compression unit

Borrowed from lcm-x, which condenses in leaf chunks of `leaf_chunk_tokens`
(24 000) with a ~2 000-token target each and keeps every leaf, assembling several
of them per request.

One pass over the whole compactable prefix meant the surface never held more than
one checkpoint: `deriveDag` had depth without breadth, and a 400k-token span was
summarised in a single call whose response the provider truncated before the
sections were finished. Measured on 147k tokens: one pass produced 1 section on 5
of 15 questions with the response cut mid-word; 7 leaves of 20-23k each produced
all six sections 7 times out of 7, each finishing `stop`.

`selectCompactableRange` takes an optional `maxSpanTokens`; the automatic paths
pass `leafSpanTokens` (default 24 000). The leaf starts at the OLDEST node, matching
lcm-x's oldest-leaf-first order, and the end walks back until the boundary is
balanced so a replacement never splits a tool-call/result pair. `0` keeps the
historical whole-prefix selection byte for byte, which manual `/compact` relies on.

### Measured effect on answers

Same four questions from the paired failures, same instruction, same model; only
the compression unit changed:

| question | gold | one span | 7 leaves |
|---|---|---|---|
| `e47becba` | `Business Administration` | UNKNOWN | **correct** |
| `95bcc1c8` | `10` | UNKNOWN | **`10 amateur comedians`** |
| `76d63226` | `55-inch` | UNKNOWN | **`55-inch 4K smart TV`** |
| `0ea62687` | `2` | UNKNOWN | matched, but the answer opens with `Unknown` |

Costs: ⌈span/24k⌉ model calls instead of one (147k is 7; a production 436k span
would be ~19), checkpoint text 31-37k characters instead of at most 13.8k, and the
calls are serial. Still 147k → ~12k tokens, the ratio lcm-x targets per leaf.

### Corrected — an earlier conclusion of mine

The leaf-chunks experiment that "proved" chunking useless gave every chunk a share
of ONE total budget and concatenated the results, so each piece was starved and the
whole was still bounded by one output ceiling. The variable was never "split or
not"; it was "does each piece own a complete target".

### Fixed — smaller, all found on real runs

- A ceiling the model never reaches: with no `maxTokens` the provider applies its
  own smaller default and truncates silently. Now `max(4096, 2x target)`, because
  reasoning is billed against the same number and measured at roughly half of it.
- The checkpoint follows the SPAN's language, not the instruction's. A Chinese
  instruction produced Chinese checkpoints for English conversations, and the
  answering model mirrored it: `三场` for 3, `六月` for June.
- Facts are typed rows (`subject.predicate = value | kind`) instead of prose. The
  vocabulary is lcm-x's assertion kinds: a count needs its unit and what it counts,
  an ordering needs the events kept apart, a preference needs its polarity.
- The anchor list stays a flat word list. Widening it to hold facts turned it into
  Chinese prose and destroyed the one property it exists for: a string you can
  paste into `lcm_search`.
- An unreachable threshold is a diagnosis, not a failure: when the trigger sits
  below the non-compactable baseline the engine used to throw on every step.

## 0.6.0 — 2026-11-08 — fitted to dsh 0.2.2-rc.1, and one poison found by fitting it
### Fixed — contract defects found by auditing against the installed dsh

Eleven, each with a test that was reverted once to confirm it fails. The one that
mattered most poisoned the harness rather than the summariser:

- **`shadowedTokenCount` carried the ROUTE price** while `dsh-token-meter` uses it
  as a shadow price and subtracts it from heuristic surface totals. Surface
  pressure was therefore permanently under-counted and the compaction threshold
  could never fire. Now split into `shadowedTokenCount` (heuristic) and
  `shadowedRouteTokenCount` (route); the shrink gate compares against the route.
- `compaction/summary` wrote `targetTokens`, which the released event validator
  rejects. The contract name is `maxTokens`; it keeps that name and now carries
  the instruction's target length.
- A summarisation failure threw the provider's frozen plain object, so the
  `instanceof LlmError` check in `dsh-compaction-image-offload` never matched.
- The `compaction/summary-error` waterfall was missing entirely, so the same
  image-offload recovery listener could never fire.
- Peer ranges `^0.2.0` do not accept `0.2.2-rc.1` (prereleases); now `^0.2.2-0`.
- `Config.simplify` silently dropped nine keys the schema never declared, so a
  `fiber.update` round-trip lost `anchorPointers`, `emptySummaryRetries` and all
  seven vector settings.
- `toolHistory` was missing from the summariser request, defeating prefix reuse.
- The `agent/request` model-switch compaction path did not exist; listener count
  is now 5, matching basic.
- Per-model `summarizationProvider`/`Model` were accepted and ignored.
- A non-system `surface[0]` was treated as a system head, so that message appeared
  twice in the summariser input.

### Fixed — the plugin had never compacted in a real session

A real `Session` exposes `log` and `snapshotEvents()`, **not** `events`. Six read
sites assumed the latter and got `undefined`, so the first thing every automatic
compaction did was throw `Cannot read properties of undefined`. The failure is
swallowed by design (`continuing the turn`), so nothing surfaced, and 100 green
tests could not catch it because every fixture had `events`.

Found by booting a profile, not by a test. `sessionEvents()` now resolves
`events -> snapshotEvents() -> log -> []`, and the swallowed failure is written to
the debug log.

### Changed — no completion cap on the summary

`ctx.llm.stream` receives no `maxTokens`; the provider's own default applies.
Reasoning-first backends bill hidden reasoning against the same ceiling, so a
summary-sized cap was spent entirely on thinking and the response finished
`max-tokens` with zero text - a compression that fails for a reason the caller
cannot fix. The instruction still names a target length, because a model told
nothing writes a 400-token stub.

Three failures the cap had been masking, all fixed: the instruction never forbade
tool calls (the request forwards the conversation's tools, so a tool call is a
legal completion, and the model took it three times in a row); a summary longer
than its own span got one retry with the bound restated as a hard rule; and the
min-span guard now requires twice the floor, since at 1.79:1 an ordinary overshoot
trips the shrink gate after paying for the call.

### Changed — a value is not a fact

Across the 15 paired Layer 2 failures (full context answered, the checkpoint did
not), the golds were 7 numeric/time, 6 short prose facts, 2 long prose and **zero
identifiers** - exactly the one category the anchor list collected. Widening the
list is necessary but not sufficient: two failures carried their gold in the anchor
list already and still answered UNKNOWN, because a bare value among 250 does not
say what it counts. The skeleton gains a 用户事实 section for facts as sentences
that carry their value.

### Fixed — an unreachable threshold is not a failure

With the trigger below the non-compactable baseline (system prompt, tool
definitions, retained tail) the engine compacted everything compactable, stayed
above, and threw on every step afterwards. It now distinguishes 'could not get
below' from 'nothing left to compact' and logs a diagnosis in the second case.

### Measured (Layer 2, n=20, LongMemEval_S, judge and answerer disclosed)

| arm | judge | string |
|---|---|---|
| `full-context` (ceiling) | 15/20 = 75% | 8/20 = 40% |
| `basic-oneshot` | 0/19 = 0% | 1/19 = 5% |
| `lcm-oneshot` | 0/20 = 0% | 0/20 = 0% |
| **`lcm-agentic`** | **14/20 = 70%** | **11/20 = 55%** |

Compress-only scores zero for both backends, so the summary axis ties at the
floor. Retrieval takes this package to 70% of a ceiling that is itself only 75%.

## 0.5.1 — 2026-11-08 — the anchor rule stops sacrificing the narrative
### Fixed

- **`ANCHOR_RULE` told the model to cut the four narrative sections before the
  anchor list.** On 20 real questions it complied: one checkpoint was 99.7%
  anchor list with the other four sections **entirely absent**, another 91.3%.
  Those four sections are how a resuming agent knows where it is. The rule now
  requires all four to have content and asks for de-duplication when the anchor
  list grows. Same question, same target: anchors 6.9% → 36.7%, 目标与约束
  6.3% → 20.2%, five sections present, output 866 → 2 620 tokens.

### Added

- `describeError()` in `src/debug.js`. Non-Error throws from the provider and the
  harness rendered as `step compaction failed: [object Object]` in a real run,
  which names nothing an operator can act on. It extracts a message, reason,
  code, name or type, then falls back to JSON.
- The min-span guard now requires **twice** the summary floor. At 1.79:1 an
  ordinary overshoot (span 918, target 512, summary 932) tripped the shrink
  guarantee after paying for the call. Two-to-one leaves room for a normal
  summary.

### Measured (Layer 2, n=20, LongMemEval_S)

| arm | judge | string |
|---|---|---|
| `full-context` (ceiling) | 15/20 = 75% | 8/20 = 40% |
| `basic-oneshot` | 0/19 = 0% | 1/19 = 5% |
| `lcm-oneshot` | 0/20 = 0% | 0/20 = 0% |
| **`lcm-agentic`** | **14/20 = 70%** | **11/20 = 55%** |

Compress-only scores zero for **both** backends, so the summary axis is a tie at
the floor. Retrieval takes this package to 70% — 93% of a ceiling that is itself
75% because the model answers wrong from full context on 4 of 20. `basic` has no
equivalent: its checkpoint carries no `seq` pointers and it ships no recall tool.

Three caveats recorded with the numbers: the oneshot zero is a budget-allocation
defect (now fixed), the agentic string score is depressed by answer-language
drift, and the judge is more lenient on long answers.

## 0.5.0 — 2026-11-08 — the summary request carries no completion cap

### Changed

- **`summarizeLeaf` no longer sends `maxTokens`.** A summary-sized completion
  budget is spent entirely on hidden reasoning by reasoning-first backends, so
  the response finished `max-tokens` with ZERO text and the whole compaction
  failed — measured three times, on three backends. Output length is also not
  predictable enough to cap usefully: the anchor list alone varies by an order of
  magnitude across spans, so every fixed number was either a truncation or dead
  weight. The provider's own default ceiling now applies.
- **The budget in the instruction became a target.** `buildInstruction` still
  names the number ("Aim for roughly N tokens (about R:1) — that is a target, not
  a hard limit"), because a model told the size writes the right size; it is just
  no longer enforced at the wire.
- **`checkpointCap` is no longer a request cap** — it bounds the TARGET only.
  An oversize summary is accepted: the transaction is bounded by the shrink
  guarantee (`framed < shadowed`), which truncation would actively work against
  by cutting the tail of the anchor list.
- Provenance field `maxTokens` → `targetTokens` on the compile result and on
  the durable `compaction/summary` record; `summarizeLeaf` also reports
  `finish`.

### Removed

- **`BUDGET_ESCALATIONS` and the `budget-escalated` path.** Doubling a ceiling
  that is no longer sent has no meaning; a `max-tokens` finish WITHOUT text now
  falls through to `emptySummaryRetries`, which is the correct handling because
  there is no budget left to escalate. `test/budget-escalation.test.js` is
  replaced by `test/no-token-cap.test.js`.

### Kept (deliberately)

- `error`/`aborted` finishes throw immediately.
- A `max-tokens` finish that DID produce text is still deterministic truncation
  and still throws on the first attempt.
- Empty text (no text block at all) is still retried on the same prompt+route.
- The shrink guarantee is untouched: it is the only hard gate on the transaction.

## 0.3.0 — 2026-11-07

Renamed to **`dsh-lcm`**, and the verdict is now backed by the only fidelity
instrument that survived audit. Cost is out of scope by instruction.

### Changed

- Package/dir/repo name `dsh-compaction-lcm` → **`dsh-lcm`**. Row ids unchanged
  (`compaction-lcm`, `tool-lcm-expand`, `command-lcm-search`), so an existing
  profile patch keeps matching.
- `test/compose.test.js` selected the engine row by matching `/compaction/`
  against the package name. After the rename that matched **nothing**, and the
  "exactly one engine is active" assertion passed with `0 !== 1` semantics
  inverted — it was asserting a zero-length list had length one. Now it matches
  the row's `name + id`.

### Measured

Type-grouped verbatim recall (`bench/qa-recall.mjs`), output ceiling 8 000 so
every arm reaches `stop` naturally:

| corpus | span | basic | lcm | ceiling |
|---|---|---|---|---|
| `s` | 4 302 tok | 2/14 = 14.3% | **7/14 = 50.0%** | not measured |
| `c2` | 8 065 tok | 4/24 = 16.7% | **15/24 = 62.5%** | **20/24 = 83.3%** |

lcm reaches **75%** of the model's own reuse ceiling on the same text; basic
reaches 20%.

### Fixed

- `src/summarize.js` said "最后一节「逐字锚点」…先压前面几节" while the skeleton
  had already moved the anchor list to the **first** section. The instruction
  contradicted itself; only the wording was wrong, but it told the model to
  sacrifice exactly the section that carries fidelity.
- A "narration sections ≤ 20 lines" cap was added, measured, and **reverted**:
  it dropped corpus `s` from 7/14 to 3/14 anchors because the model read the cap
  as a cap on the whole reply. `test/lcm.test.js` now asserts the cap's absence.

### Recorded instrument facts (do not re-learn these)

- The same prompt re-run returns **byte-identical** output (gateway cache).
  Three reps of one arm are N=1, not N=3.
- Anchor hits are **not monotonic in the output ceiling**: the `c2` full-span arm
  scored 10/24 at 1 500, 4/24 at 3 000, 20/24 at 8 000. Only same-ceiling
  comparisons and `stop`-naturally absolutes mean anything.
- `lcm` degenerated into a repeated-phrase loop twice at the 8 000 ceiling
  (`finish_reason=error`). Re-running the same arm gave a clean sample with the
  same hit count, so a single call is never a result.

## 0.2.9 — 2026-11-07

Benchmarks no longer go through the agent's MCP transport, and the "equal budget"
claim is now honest about which routes enforce it.

### Added

- `bench/llm.mjs`: direct OpenAI-compatible client with a caller-owned deadline
  (the MCP path capped calls at ~60s, which is why the anchor-enumeration arm had
  zero data) and credentials from the environment or `~/.dsh/.credentials.yaml`.
- `bench/ab-one.mjs`: one arm-rep runner, ability to run **uncapped** (`none`).

### Measured

`max_tokens` is enforced per **route**, not per transport — same request, cap 40:
`best`(glm-5.3) 40, `balanced-lite`(agnes-3.0-flash) 40,
`deepseek-v4-flash-auto` **654**.

Uncapped comparison on corpus s (14 anchors):

| arm | hits | mean | tokens | anchors/1k |
|---|---|---|---|---|
| basic | 5,5,5,5,5 | 5.0 | 2700 | 1.85 |
| lcm | 5,5,5,5 | 5.0 | **2182** | **2.29** |

Same fidelity, ~19% fewer output tokens. With a hard 516-token generation cap:
basic 2.5 vs lcm 3.5 — higher fidelity at the same cost.

Neither direction is worse than the built-in backend. Numbers are on
`balanced-lite` and must not be compared across the `deepseek` tables.

## 0.2.8 — 2026-11-07

The retrieval ranking conclusion was inverted by an instrument bug. Corrected, and
the default flipped.

### Fixed

- **`bench/retrieval.mjs` recorded `index + 2` as the rank** (`rank = hitIndex + 1`
  then `+1` again on write), so recall@1 was structurally 0 for every mode and
  hid the entire advantage of the length-normalised ranking. The same file's
  "NDCG" was a constant copy of recall@10.
- `rank` is now written once, NDCG is a real `1/log2(rank+1)`, and the false claim
  that "the top hit is always outside the span" is gone (it was an artifact).

### Changed

- **Default result order is now `density`**, which wins on the metric that matches
  the actual use — "get me any copy of this fact":

  | log | order | recall@1 | recall@5 | MRR | NDCG@10 |
  |---|---|---|---|---|---|
  | d45c83f5 (21) | seq | 0.381 | 0.952 | 0.581 | 0.673 |
  | | **density** | **0.714** | 0.952 | **0.793** | **0.832** |
  | session-65bd (22) | seq | 0.682 | 0.955 | 0.802 | 0.851 |
  | | **density** | **0.727** | 0.955 | **0.840** | **0.880** |

  `seq` and `score` stay available through the `rank` key.

### Notes

- Under the `gold=first` label density is *worse* (recall@1 0.143 vs 0.381): it
  prefers short events that are entirely about the term over the first passing
  mention. Real callers want any copy, so the default optimises `any`; both sets
  of numbers stay in the report.
- The lesson recorded in bench/REPORT.md §14: one wrong counting rule is enough to
  make the best ordering look like the worst.

## 0.2.7 — 2026-11-07

At equal budget this package was **worse** than the built-in backend. Fixed.

### Fixed

- **The anchor list was the last section, so truncation destroyed it.** A summary
  is routinely cut to fit a budget, and truncation cuts the tail: with the
  anchors last, a budgeted summary kept the narrative and lost exactly the part
  that carries fidelity. Measured at a 516-token ceiling: **0/14 anchors**
  (the built-in backend kept 2/14). Evidence: the truncated text ended at
  `## 逐字锚点\n- /vol3/1000/work/`.
  `SUMMARY_SKELETON` now puts `逐字锚点` first, and the instruction says to cut
  prose, never the list.

### Measured (equal budget, N=4 per arm, temperature 0)

| arm | hits | mean | budgeted tokens |
|---|---|---|---|
| basic | 2, 2, 3, 2 | 16.1% | 494 |
| **lcm** | 3, 4, 4, 2 | **23.2%** | 509 |

Non-inferior at equal cost, and consistently ahead on 3 of 4 runs. Not enough to
claim "better"; enough to hold the "not worse" line.

### Added

- `bench/equal-budget.mjs`: pure scoring (token count, budget truncation,
  anchor scoring) plus a `--score` CLI that re-scores saved text without calling
  a model, so the numbers stay checkable offline.

## 0.2.6 — 2026-11-07

Retrieval quality measured on production data — and a relevance ranking that lost.

### Added

- `bench/retrieval.mjs`: the hard half of recoverability. §7 of the report shows a
  known seq comes back byte-exactly; this shows whether the agent can *find* that
  seq from a string it remembers. Labels are the anchors a real production
  summary dropped; metrics are recall@5/10 and MRR; no model is called.
- `searchSession(..., { rank })` with three orders: `seq` (default), `score`
  (match count), `density` (length-normalised). Exposed as the `rank` key on the
  tool and command rows.
- `test/search-rank.test.js` pins each ordering so a future change cannot
  silently flip the default.

### Measured (21 anchors from a real 436k-token compaction)

| order | recall@5 | recall@10 | MRR |
|---|---|---|---|
| **seq (default)** | **0.905** | **0.952** | 0.335 |
| score | 0.762 | 0.810 | 0.332 |
| density | 0.857 | 0.952 | **0.414** |

A second log (22 anchors): recall@5 0.955, recall@10 1.000.

**The relevance ranking lost.** Raw match count favours long log dumps, not the
answer; length-normalised density improves MRR but still trails on recall@5. The
default stays chronological, and the report records the negative result rather
than shipping a worse order that looked smarter.

### Notes

- recall@1 is 0 under every order: the top hit is always an event outside the
  compacted span (the checkpoint itself contains the string), so @1 is not a
  usable discriminator here. Look at @5 and MRR.
- 54 tests.

## 0.2.5 — 2026-11-07

The original backend's names are kept, not replaced.

### Added

- **`recall` and `search` tools, and `/recall`, are registered alongside
  `lcm_expand` / `lcm_search` / `/lcm-search`.** `dsh-compaction-instant` shipped
  those three names; anything already written against them — agent
  instructions, saved prompts, habit — keeps working after a backend switch.
  Covered by `test/compat.test.js` (5 tests).
- `legacyNames` (default `true`) on the tool and command rows; set it to
  `false` to register only the LCM names.
- `defineRecallTool` / `defineSearchTool` / `defineRecallCommand` take an
  optional name argument, so a deployment can register any alias without
  forking the module.

## 0.2.4 — 2026-11-07

Two more instances of the same off-by-one, and dead code removal.

### Fixed

- **`deriveDag` read `session.events[summary.seq + 1]`**, so on every persisted log
  (header record first, no `seq`) it looked one event past the replacement and
  found nothing: the summary DAG reported zero checkpoints for real sessions.
  Now resolved through `resolveEventAt`. Regression test added.
- Removed an unused `seqToShadowed` map left over from an earlier revision.

### Removed

- `compiler.js`: `excerptToolResult` and `tailTokens` — the last survivors of the
  VCC region compiler, dead since it was replaced by LLM summarization
  (851 → 275 lines across this series).

### Verified

- 44 tests, including three header-shift regressions (recall, search, deriveDag).

## 0.2.3 — 2026-11-07

The engine-level measurement the prompt A/B could not provide, plus a bug it found.

### Measured

`bench/recovery.mjs` runs the shipped `src/recall.js` against a real production
log and answers the only question that distinguishes this backend from a
summarizer-only one:

| | value |
|---|---|
| span | 787 nodes / 436 194 tokens |
| anchors the production summary carried | 3 / 24 (**12.5%**) |
| anchors recovered byte-exactly via recall | 21 / 21 |
| **anchors still obtainable by the model** | **24 / 24 (100%)** |
| permanently lost | 0 |

At 436k tokens no summary can hold everything; a summarizer-only checkpoint stops
at whatever it wrote. This one carries `seq` pointers and a recall guide, so the
remainder is one call away.

### Fixed

- **`session.events[seq]` was off by one on every persisted log.** A session file
  begins with a header record that has no `seq`, so `recall` and `search`
  reported `[seq N: not found in this session]` for real events. New
  `src/events.js` resolves by the event's own `seq`, preferring the session's
  `eventAt` accessor, and both modules now use it.

### Added

- `test/recovery.test.js` — header-shift regression, accessor preference,
  byte-exact projection, and a production-log recovery test with a
  **vacuous-pass guard**: if recall falls back to a raw JSON dump every
  substring matches trivially, so the test requires the real projection.
- 43 tests.
- `bench/REPORT.md` §7 records the measurement and its honest boundary: basic is
  not at zero (dsh ships `session_search`), but its checkpoint never points at it.

## 0.2.2 — 2026-11-07

Two **fatal** bugs found by a test-coverage audit. The engine had never
successfully compacted anything.

### Fixed

- **The positional replacement shape was wrong.** `commitCompactionBody` emitted
  `{op, start, end}`; the harness requires exactly `{op, startSeq, endSeq}`
  (`dsh-session/surface` `isReplaceOp`: three own keys, both non-negative safe
  integers). Every commit therefore threw *after* `compaction/start` and
  `compaction/summary` had landed, stranding an orphan summary, leaving the
  surface unable to shrink, and burning the pressure retry budget until
  "still above threshold". Inherited verbatim from `dsh-compaction-instant`,
  which targets an older harness.
- **`compactNow` referenced an out-of-scope `spec`,** so `/compact` threw
  `ReferenceError` and the catch-all rewrote it as
  `ManualCompactionError("busy")` — manual compaction was 100% broken while
  looking like lock contention. Now follows basic: `retainTokens = 0`.
- `compile()` now returns `maxTokens`, so `compaction/summary` records the
  generation ceiling instead of silently omitting it.

### Added

- `test/region.test.js` — the first tests of the durable transaction. The
  fixture replays every append through the harness's own `foldSurface`, so an
  invalid `surfaceOp` fails in CI instead of in production. Covers: commit
  shape and surface shrinkage, summary→replacement adjacency, start/end
  bracketing, the shrink guard (throws, closes its marker, records a string
  error), compile-failure lock release with no orphan summary, tool-pair-safe
  cuts, system-head exclusion, and a full `compactNow` round trip.
- 38 tests total.

## 0.2.1 — 2026-11-07

Round 2: independent audit fixes and a retracted benchmark.

### Fixed (configuration parity — found by an independent line-by-line audit)

- **D1** `static Config` did not declare `headroomTokens` or `maxTokens`, so both
  were invisible to settings and one strict-loader release away from being
  rejected as unknown keys.
- **D2** `resolveCompactSpec` defaulted the routed output reservation to 0 and
  the caller never passed it. Basic reserves `header.config.maxTokens ??
  adapterDefault`, so the threshold fired up to `O` tokens late and the
  retained tail was computed from the whole window instead of the message
  budget. Now reproduced exactly (verified against three audit-derived points:
  W=128000/O=8192 → 54272/19169, W=200000/O=8192 → 126272/30689,
  W=1000000/O=16384 → 800000/157378).
- **D3** an explicit `maxTokens` no longer caps the summary. Basic treats it as
  the summarizer's output ceiling; this backend derived the budget from
  `summaryRatio` alone, so a config that set `maxTokens: 4096` to bound spend
  silently inherited the larger `checkpointCap`. The budget is now
  `min(scaled, maxTokens)`.

### Changed (benchmark credibility)

- `bench/anchors.mjs`: anchors are de-nested (only maximal survive), balanced
  across types (≤35% each), and deduplicated by fact. The v1 set was **100%
  file paths** and gameable — nine literals scored 24/24.
- `bench/REPORT.md` v2 retracts six v1 claims: the six-type anchor coverage,
  the "random sampling", the cost-parity figure (95% CI −40%…+44%, p≈0.90), the
  "0.98× fewer" sign, the claim that an engine was compared at all, and the
  assumption that `max_tokens` was honoured.
- README no longer claims a measured win. It states what is verified (config
  drop-in), what is under test (the anchor clause, 3-arm ablation), and what was
  never done (comparing the two engines).

### Verified

- 32 tests, including three audit-derived budget points and a static-Config key
  declaration check.
- `test/compose.test.js`: the bundle patch composes to exactly one active
  engine.

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