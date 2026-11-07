#!/usr/bin/env node
// bench/anchors.mjs — build a defensible verbatim-anchor set from a span.
//
// The first version of this benchmark extracted anchors by regex and kept the
// first 24 in pattern order. An audit showed that set was 100% file paths, and
// that nesting made it gameable: one short path is a substring of a dozen
// longer ones, so writing "/vol3/1000/work" scored 13 hits. This module fixes
// three things:
//
//   1. NESTING: only maximal anchors survive. If anchor A is a substring of
//      anchor B, A is dropped — you cannot score by pasting one prefix.
//   2. TYPE BALANCE: no single type may exceed MAX_TYPE_SHARE of the set, so a
//      path-heavy span cannot produce a path-only test.
//   3. DEDUPE BY FACT: repeated dumps of the same list collapse to one anchor,
//      so "5 identical tool outputs" count once.
//
// Output: { anchors: [{ value, type }], poolSize, droppedNested, typeCounts }
//
// @module bench/anchors

/** No single anchor type may exceed this share of the final set. */
const MAX_TYPE_SHARE = 0.35;
/** Hard cap on set size (a summarizer cannot be expected to carry more). */
const MAX_ANCHORS = 24;

const PATTERNS = [
  ["path", /\/vol\d+\/[\w.\/-]+/g],
  ["path", /\/[\w.-]+\/[\w.-]+\/[\w.\/-]+\.(?:img|sh|py|md|json|yaml|yml|txt|log|db|patch|diff)/g],
  ["uuid", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g],
  ["hex", /0x[0-9a-fA-F]{8,}/g],
  ["env", /\b[A-Z][A-Z0-9_]{3,}_[A-Z0-9_]{2,}\b/g],
  ["error", /\b(?:Error|ERROR|error|failed|FAILED|cannot|refusing)[^\n]{10,70}/g],
  ["number", /\b\d{2,}(?:\.\d+)?(?:ms|s|KB|MB|GB|B|bytes|tok|tokens)\b/g],
  ["command", /\b(?:adb|git|pnpm|npm|node|python3|curl|ffmpeg|ditto|hdiutil|qemu-system-[a-z0-9]+)\s+[^\n]{4,60}/g]
];

/**
 * Collect candidate anchors, typed and deduplicated, then drop every anchor
 * that is a substring of a longer surviving one.
 * @param text - the span text.
 * @returns typed candidates plus the nesting that was removed.
 */
export function collectAnchors(text) {
  const byValue = new Map();
  for (const [type, pattern] of PATTERNS) {
    for (const match of text.match(pattern) ?? []) {
      const value = match.trim().replace(/[),.;:'"]+$/, "");
      if (value.length < 8 || value.length > 140) continue;
      if (!byValue.has(value)) byValue.set(value, { value, type });
    }
  }
  const all = [...byValue.values()];
  // Drop any anchor contained in a longer one: nesting is what made a one-line
  // prefix score a dozen hits.
  const maximal = all.filter((a) => !all.some((b) => b !== a && b.value.length > a.value.length && b.value.includes(a.value)));
  return { candidates: maximal, droppedNested: all.length - maximal.length, poolSize: all.length };
}

/**
 * Build the final balanced anchor set.
 * @param text - the span text.
 * @returns the anchor set plus its provenance.
 */
export function buildAnchorSet(text) {
  const { candidates, droppedNested, poolSize } = collectAnchors(text);
  // Group by type, interleave round-robin so balance is structural rather than
  // a post-hoc truncation.
  const buckets = new Map();
  for (const candidate of candidates) {
    if (!buckets.has(candidate.type)) buckets.set(candidate.type, []);
    buckets.get(candidate.type).push(candidate);
  }
  const order = [...buckets.keys()].sort();
  const picked = [];
  const perTypeCap = Math.max(1, Math.floor(MAX_ANCHORS * MAX_TYPE_SHARE));
  const usedPerType = new Map();
  for (let round = 0; picked.length < MAX_ANCHORS; round += 1) {
    let added = false;
    for (const type of order) {
      const bucket = buckets.get(type);
      const used = usedPerType.get(type) ?? 0;
      if (used >= perTypeCap) continue;
      const next = bucket.shift();
      if (next === undefined) continue;
      picked.push(next);
      usedPerType.set(type, used + 1);
      added = true;
      if (picked.length >= MAX_ANCHORS) break;
    }
    if (!added) break;
  }
  const typeCounts = {};
  for (const anchor of picked) typeCounts[anchor.type] = (typeCounts[anchor.type] ?? 0) + 1;
  return { anchors: picked, poolSize, droppedNested, typeCounts, perTypeCap };
}
