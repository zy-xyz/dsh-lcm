/**
 * Same-session recall core for `dsh-lcm`.
 *
 * The lossless counterpart of the compaction step: checkpoints
 * mark every elision with a `(seq N)` / `(seqs A-B)` pointer into the durable
 * session log; this module expands those pointers back into the exact
 * original content. Because the log is append-only, every token the compiler
 * ever truncated or elided is still present and recoverable — recall closes
 * the loop that makes the compaction engine near-lossless.
 *
 * Shared by the model-facing `recall` tool (`./tool`). Reads any session-shaped
 * value with `events` and `deriveEventMessage`, so it is unit-testable without
 * a running harness.
 *
 * @module dsh-lcm/recall
 */
import { estimateEntryTokens, isCheckpointSource, projectMessageText, truncateTokens } from "./compiler.js";
import { resolveEventAt, sessionEvents } from "./events.js";

/** Default total budget for one recall operation, in density-aware tokens. */
export const DEFAULT_MAX_RECALL_TOKENS = 16000;
/** Widest single range accepted from one selection, bounding expansion work. */
export const MAX_RECALL_SPAN = 1000;

/**
 * Widest per-call budget a caller may request, in density-aware tokens — the
 * same kind of bound as MAX_RECALL_SPAN, on the output side instead of the
 * input side: a span limit stops one selection from expanding into unbounded
 * work, and this stops one expansion from filling the context it was called to
 * save.
 *
 * The number is measured, not picked. Across 21 compacted sessions, 10630
 * shadowed seqs were sampled: 2 exceeded the 16000 default and were truncated
 * on every call. The largest was a tool result of 23251 tokens / 49930 chars
 * that came back as 34621 chars (69.3%); raising the budget by hand returned it
 * whole, so the bytes were never missing, only the channel was too narrow.
 * 32768 is that largest measured event rounded up to the next power of two —
 * ~41% headroom over 23251 for an event somewhat bigger than the sampled max —
 * and it is exactly a quarter of a 128k-token window, so no single expansion
 * can consume more than a quarter of a full context.
 */
export const MAX_RECALL_TOKENS = 32768;

/**
 * Parse one seq selection string into ordered inclusive ranges.
 *
 * Accepted forms per comma-separated part: `12`, `3-7`, `seq 12`,
 * `seqs 3-7`, with optional surrounding parentheses — so a model or human
 * can paste a checkpoint marker verbatim.
 * @param input - raw selection text.
 * @returns `{ selections, errors }`; errors are stable human-readable strings.
 */
export function parseSeqSpec(input) {
  const selections = [];
  const errors = [];
  const raw = String(input ?? "").trim();
  if (raw.length === 0) return { selections, errors: ["missing seq selection"] };
  for (const part of raw.split(",")) {
    let token = part.trim();
    if (token.length === 0) continue;
    token = token.replace(/^\((.*)\)$/u, "$1").trim();
    const match = /^(?:seqs?\s+)?(\d+)(?:\s*-\s*(\d+))?$/iu.exec(token);
    if (match === null) {
      errors.push(`invalid seq selection "${part}"`);
      continue;
    }
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (end < start) {
      errors.push(`invalid seq range "${part}" (end before start)`);
      continue;
    }
    if (end - start + 1 > MAX_RECALL_SPAN) {
      errors.push(`seq range "${part}" is wider than the ${MAX_RECALL_SPAN}-seq limit`);
      continue;
    }
    selections.push({ start, end });
  }
  return { selections, errors };
}

/**
 * Resolve one caller-supplied recall budget against the configured default.
 *
 * The tool's `maxTokens` argument is the only way past DEFAULT_MAX_RECALL_TOKENS,
 * and it is bounded here rather than in the handler so the clamp and the
 * rejection live next to the constant that justifies them.
 * @param requested - raw budget from the caller; `undefined`/`null` means "not given".
 * @param fallback - the configured budget (`config.maxRecallTokens`).
 * @returns the budget to enforce, clamped to {@link MAX_RECALL_TOKENS}.
 * @throws RangeError when the value is not a positive integer.
 */
export function resolveRecallBudget(requested, fallback) {
  if (requested === undefined || requested === null) return fallback;
  if (typeof requested !== "number" || !Number.isInteger(requested) || requested <= 0) {
    throw new RangeError(`maxTokens must be a positive integer (got ${JSON.stringify(requested)})`);
  }
  return Math.min(requested, MAX_RECALL_TOKENS);
}

/**
 * The actionable tail appended after a truncation marker: what came back, of
 * how much, and the argument that returns the rest.
 *
 * Deliberately not a paging cursor — the log is indexed by seq and the budget is
 * applied to the whole call, so there is no offset to hand back. Re-calling with
 * a larger budget IS the page.
 * @param returned - the already-truncated text, marker included.
 * @param full - the untruncated body.
 * @param maxRecallTokens - the budget this call actually enforced.
 * @returns one bracketed line, newline-separated from the text it follows.
 */
function recallBudgetNote(returned, full, maxRecallTokens) {
  const cap = maxRecallTokens >= MAX_RECALL_TOKENS
    ? `${MAX_RECALL_TOKENS} is the ceiling for maxTokens`
    : `raise maxTokens (up to ${MAX_RECALL_TOKENS}) to restore the rest`;
  return "\n[recall budget " + maxRecallTokens + " tokens: returned ~" + estimateEntryTokens(returned)
    + " of ~" + estimateEntryTokens(full) + " tokens (" + returned.length + " of " + full.length
    + " chars) — " + cap + "]";
}

/** Re-exported so existing importers keep working; the definition is in compiler.js. */
export { projectMessageText } from "./compiler.js";

/**
 * Expand ordered selections into a deduplicated ordered seq list.
 * @param selections - parsed inclusive ranges.
 * @returns unique seqs in first-appearance order.
 */
export function expandSelections(selections) {
  const seqs = [];
  const seen = new Set();
  for (const { start, end } of selections) {
    for (let seq = start; seq <= end; seq += 1) {
      if (seen.has(seq)) continue;
      seen.add(seq);
      seqs.push(seq);
    }
  }
  return seqs;
}

/**
 * Collect the durable seqs of every landed compaction checkpoint node in one
 * session, oldest first. Each compaction replaces its span with exactly one
 * checkpoint node, so the ordinal (`1` = oldest) counts compactions.
 * @param session - session-shaped value with `events`.
 * @returns checkpoint node seqs in chronological order.
 */
export function findCheckpointSeqs(session) {
  const seqs = [];
  const events = sessionEvents(session);
  for (const event of events) {
    if (event.type === "user/message" && isCheckpointSource(event.data?.source)) seqs.push(event.seq);
  }
  return seqs;
}

/**
 * Resolve one typed recall reference into inclusive seq ranges.
 *
 *   - `type: "seq"` — `id` is a seq selection: numbers/ranges with the
 *     checkpoint marker forms (`12`, `3-7,15`, `seq 12`, `seqs 3-7`).
 *   - `type: "result"` — `id` names a tool result: the `result N` pointer
 *     from a tool-call one-liner (`result 3`, `seq 3`, or bare `3`); the
 *     resolved seq must be a `tool/result` event.
 *   - `type: "checkpoint"` — `id` is a checkpoint ordinal (`1` = oldest,
 *     as in the `[checkpoint N]` elision marker) or a `seq N` pointer to a
 *     checkpoint node.
 *
 * @param session - session-shaped value with `events` and `deriveEventMessage`.
 * @param type - reference type: `seq`, `result`, or `checkpoint`.
 * @param id - type-dependent reference text.
 * @returns `{ selections, errors }`; errors are stable human-readable strings.
 */
export function resolveRecallReference(session, type, id) {
  const raw = String(id ?? "").trim();
  if (type === "seq") return parseSeqSpec(raw);
  if (type === "result") {
    const token = raw.replace(/^\((.*)\)$/u, "$1").trim().replace(/^result\s+/iu, "");
    const match = /^(\d+)$/u.exec(token);
    if (match === null) return { selections: [], errors: [`invalid result reference "${id}" (expected a seq like "3" or "result 3")`] };
    const seq = Number(match[1]);
    const event = resolveEventAt(session, seq);
    if (event === undefined || event.seq !== seq) return { selections: [], errors: [`result seq ${seq} not found in this session`] };
    if (event.type !== "tool/result") return { selections: [], errors: [`seq ${seq} is not a tool result (it is ${event.type})`] };
    return { selections: [{ start: seq, end: seq }], errors: [] };
  }
  if (type === "checkpoint") {
    const token = raw.replace(/^\((.*)\)$/u, "$1").trim();
    const bySeq = /^seqs?\s+(\d+)$/iu.exec(token);
    if (bySeq !== null) {
      const seq = Number(bySeq[1]);
      const event = resolveEventAt(session, seq);
      if (event === undefined || event.seq !== seq) return { selections: [], errors: [`checkpoint seq ${seq} not found in this session`] };
      if (!isCheckpointSource(event.data?.source)) return { selections: [], errors: [`seq ${seq} is not a checkpoint node`] };
      return { selections: [{ start: seq, end: seq }], errors: [] };
    }
    const ordinal = token.replace(/^checkpoint\s+/iu, "");
    const match = /^(\d+)$/u.exec(ordinal);
    if (match === null) return { selections: [], errors: [`invalid checkpoint reference "${id}" (expected an ordinal like "1" or "checkpoint 1", or a "seq N" pointer)`] };
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index < 1) return { selections: [], errors: [`invalid checkpoint ordinal "${id}"`] };
    const checkpointSeqs = findCheckpointSeqs(session);
    const seq = checkpointSeqs[index - 1];
    if (seq === undefined) return { selections: [], errors: [`checkpoint ${index} not found (this session has ${checkpointSeqs.length} checkpoint(s))`] };
    return { selections: [{ start: seq, end: seq }], errors: [] };
  }
  return { selections: [], errors: [`invalid recall type "${String(type)}" (expected "seq", "result", or "checkpoint")`] };
}

/**
 * Recall the full original content of the requested seqs from one session's
 * durable log. Message events project through `deriveEventMessage`; log-only
 * events render as a labeled data dump. The total output is bounded by
 * `config.maxRecallTokens` (already resolved through
 * {@link resolveRecallBudget} when a caller asked for a different budget); a cut
 * appends a provenance marker plus the sizes and the argument that returns the
 * remainder, and remaining requested seqs are accounted in `skipped`.
 * @param session - session-shaped value with `events` and `deriveEventMessage`.
 * @param selections - parsed inclusive ranges.
 * @param config - `{ maxRecallTokens }`.
 * @returns `{ text, entries, seqs, recalled, missing, skipped, truncated, tokens }`.
 */
export function recallSession(session, selections, config) {
  const maxRecallTokens = config.maxRecallTokens;
  const requested = expandSelections(selections);
  const entries = [];
  const seqs = [];
  let budget = maxRecallTokens;
  let truncated = false;
  let missing = 0;
  let skipped = 0;
  for (let index = 0; index < requested.length; index += 1) {
    const seq = requested[index];
    if (budget <= 0) {
      skipped = requested.length - index;
      truncated = true;
      break;
    }
    const event = resolveEventAt(session, seq);
    if (event === undefined || event.seq !== seq) {
      missing += 1;
      entries.push({ seq, text: `[seq ${seq}: not found in this session]` });
      continue;
    }
    const message = typeof session.deriveEventMessage === "function" ? session.deriveEventMessage(event) : null;
    const body = message !== null
      ? `[seq ${seq}: ${message.role}]\n${projectMessageText(message)}`
      : `[seq ${seq}: ${event.type}]\n${JSON.stringify(event.data).slice(0, maxRecallTokens * 4)}`;
    const kept = truncateTokens(body, budget, "recall budget");
    budget -= estimateEntryTokens(kept.text);
    if (kept.truncated) {
      // The cut used to end at "…(truncated from recall budget)" and stop, which
      // told the reader that bytes were missing but not that a bigger budget
      // brings them back — the one thing they could act on.
      truncated = true;
      kept.text += recallBudgetNote(kept.text, body, maxRecallTokens);
    }
    entries.push({ seq, text: kept.text, truncated: kept.truncated });
    seqs.push(seq);
  }
  if (skipped > 0) {
    entries.push({ seq: requested[requested.length - skipped], text: `[recall budget exhausted: ${skipped} further requested seq(s) not included]` });
  }
  return {
    text: entries.map((entry) => entry.text).join("\n\n"),
    entries,
    seqs,
    recalled: seqs.length,
    missing,
    skipped,
    truncated,
    tokens: entries.reduce((total, entry) => total + estimateEntryTokens(entry.text), 0)
  };
}
