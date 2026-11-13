/**
 * Background leaf preparation — lcm-x's `background_leaf_prep_enabled`, off by default.
 *
 * The reference has a daemon thread (`_LeafPrep`, name `lcm-leaf-prep`) that, after
 * each turn, pre-summarises the leaf a future compaction would need and stores it.
 * When the foreground pass reaches that leaf it promotes the prepared body instead
 * of paying a model call, so a threshold crossing costs nothing.
 *
 * Why it exists at all: a sweep is bounded by two clocks (soft 60 s / hard 120 s in
 * the reference), and a 17 s leaf means the clock, not the backlog, decides when a
 * pass ends. Work that has already been computed is what lets the next pass spend
 * its clock on the NEXT leaf rather than re-doing this one.
 *
 * Why it is off by default: it spends model calls on a session that may never
 * compact, it holds the session open for a summary nobody asked for, and lcm-x
 * ships it disabled too (`config.py:1494`). `_continueOnIdle` covers the common
 * case — a sweep that stopped early resumes when the agent goes idle — without
 * speculating about a future leaf.
 *
 * A prepared entry is only usable for the EXACT span and route it was computed
 * from. The key covers both, plus a digest of every message body in the span, so a
 * rewritten or reordered surface misses instead of promoting a stale summary.
 */
import { createHash } from "node:crypto";

/** How many prepared leaves to keep. One sweep's worth plus slack. */
const PREP_CAPACITY = 4;

/**
 * Digest of the span a prepared summary belongs to.
 *
 * Route first, because the same tokens summarised by a different model are a
 * different summary. Then the seq list, then each body: a span whose content moved
 * under the same seqs (a rewind, an edited event) must miss.
 * @param prepared - the priced span snapshot from `prepareCompaction`.
 * @param route - `{ provider, model }` the summary would be computed with.
 * @returns a hex digest usable as a cache key.
 */
export function preparedLeafKey(prepared, route) {
  const hash = createHash("sha256");
  hash.update(route.provider + "\u0000" + route.model + "\u0000");
  hash.update(String(prepared.shadowedSeqs.length) + "\u0000");
  for (const seq of prepared.shadowedSeqs) {
    hash.update(String(seq) + "\u0000");
    const event = prepared.session?.eventAt?.(seq);
    const message = event === undefined || event === null ? null : prepared.session.deriveEventMessage(event);
    hash.update(message === null ? "" : JSON.stringify(message));
    hash.update("\u0001");
  }
  return hash.digest("hex");
}

/**
 * A bounded, insertion-ordered map of prepared leaves.
 *
 * Deliberately not durable: the reference stores its queue in SQLite because it
 * survives process restarts and serves several conversations from one bank. Here a
 * restart simply means the next crossing pays a model call, which is the
 * behaviour every deployment had before this feature existed — so memory is the
 * honest scope, and a stale entry cannot outlive the process that computed it.
 */
export class LeafPrepCache {
  /** @param capacity - how many entries to keep; the oldest is evicted first. */
  constructor(capacity = PREP_CAPACITY) {
    this.capacity = capacity;
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
    this.computed = 0;
  }

  /** @returns true when a new job may be started. */
  get hasCapacity() {
    return this.entries.size < this.capacity;
  }

  /** @returns true when the span is already prepared. */
  has(key) {
    return this.entries.has(key);
  }

  /**
   * Take the prepared entry for a key, removing it.
   *
   * Removing rather than keeping: a checkpoint is committed once, and a second
   * promotion of the same body would replace a different span with a summary of
   * the first one.
   * @param key - from {@link preparedLeafKey}.
   * @returns the stored result, or undefined.
   */
  take(key) {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.misses += 1;
      return undefined;
    }
    this.entries.delete(key);
    this.hits += 1;
    return entry;
  }

  /**
   * Store one prepared result.
   * @param key - from {@link preparedLeafKey}.
   * @param result - what `summarizeLeaf` returned.
   */
  put(key, result) {
    if (this.entries.has(key)) return;
    this.entries.set(key, result);
    this.computed += 1;
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Drop everything; used when the route or the configuration changes. */
  clear() {
    this.entries.clear();
  }

  /** @returns a one-line summary for the status surface. */
  describe() {
    return `prepared=${this.entries.size}/${this.capacity} hits=${this.hits} misses=${this.misses} computed=${this.computed}`;
  }
}
