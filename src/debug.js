/**
 * The engine's one debug sink.
 *
 * Shared by the engine entry point (`./index.js`) and the summarizer
 * (`./summarize.js`) so retry diagnostics land in exactly the same place as
 * every other engine diagnostic: stderr when it is visible, plus the debug log
 * when `debug` is on. Normal output stays untouched by design — a retry that
 * succeeded is not the user's business, but "why did compaction fail" must be
 * answerable after the fact.
 *
 * @module dsh-lcm/debug
 */
import { appendFileSync } from "node:fs";

/**
 * Emit one engine-side debug line through the resolved sink when debug is on.
 * @param config - resolved configuration.
 * @param line - the diagnostic text.
 */
export function engineDebug(config, line) {
  if (config.debug !== true) return;
  const text = `[dsh-lcm] engine: ${line}`;
  try {
    console.error(text);
  } catch {
    /* stderr may be unavailable in embedded contexts */
  }
  try {
    appendFileSync(config.debugLogPath, `${text}\n`, "utf8");
  } catch {
    /* a failing debug log must never break the engine */
  }
}
