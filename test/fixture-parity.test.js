/**
 * The basic fixture must be the REAL instruction, byte for byte.
 *
 * Layer 2 compares this backend against `dsh-compaction-basic`. If the fixture
 * were a paraphrase, every "basic" number would be a comparison against
 * something no user runs. The fixture is extracted from the installed package;
 * this test re-extracts it the same way and fails if the two ever diverge - a
 * package upgrade that rewords the instruction must not silently change the
 * baseline.
 *
 * Skips when the package is not installed (outside a dsh profile).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "..", "bench", "fixtures", "basic-instruction.txt");

/** Locate the installed built-in backend's compiled entry. */
function findPackage() {
  const candidates = [
    "@deepseek-ai/dsh-compaction-basic",
    path.join(process.env.HOME ?? "", ".dsh/profiles/web/node_modules/@deepseek-ai/dsh-compaction-basic")
  ];
  for (const base of candidates) {
    const entry = path.join(base, "lib", "index.js");
    if (fs.existsSync(entry)) return entry;
    try {
      const resolved = import.meta.resolve(base + "/package.json");
      const entry2 = path.join(path.dirname(fileURLToPath(resolved)), "lib", "index.js");
      if (fs.existsSync(entry2)) return entry2;
    } catch {
      /* not resolvable from here */
    }
  }
  return null;
}

/** Rebuild the instruction exactly as the package's own array join does. */
function extractReal(entry) {
  const src = fs.readFileSync(entry, "utf8");
  const start = src.indexOf("const COMPACTION_INSTRUCTION = [");
  const end = src.indexOf('].join("\\n");', start);
  if (start < 0 || end < 0) return null;
  const body = src.slice(start, end);
  const parts = [];
  const re = new RegExp('^\\t("(?:[^"\\\\]|\\\\.)*"|`(?:[^`\\\\]|\\\\.)*`),?$', "gm");
  for (const match of body.matchAll(re)) {
    const raw = match[1];
    if (raw[0] === '"') {
      parts.push(JSON.parse(raw));
    } else {
      parts.push(
        raw
          .slice(1, -1)
          .replace(/\\`/g, "`")
          .replace(/\$\{SUMMARY_OPEN_TAG\}/g, "<compacted-summary>")
          .replace(/\$\{SUMMARY_CLOSE_TAG\}/g, "</compacted-summary>")
      );
    }
  }
  return parts.join("\n");
}

test("the basic fixture is the installed backend's instruction, byte for byte", (t) => {
  const entry = findPackage();
  if (entry === null) {
    t.skip("dsh-compaction-basic is only resolvable inside a dsh profile");
    return;
  }
  const real = extractReal(entry);
  if (real === null) {
    t.skip("COMPACTION_INSTRUCTION not found in this package version");
    return;
  }
  // The fixture carries a three-line banner that the prompt builder prepends.
  const fixture = fs.readFileSync(fixturePath, "utf8").replace(/^\s*=== INSTRUCTION ===\s*\n/, "").trim();
  assert.equal(fixture, real.trim(), "basic fixture drifted from the installed instruction");
});
