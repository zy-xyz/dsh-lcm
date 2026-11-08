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
 * Render any thrown value as text.
 *
 * Providers and the harness both throw non-Error values on some paths (a plain
 * failure record, an aborted signal payload). Stringifying those yields
 * "[object Object]", which is exactly the line an operator cannot act on - it
 * appeared in a real run as `step compaction failed: [object Object]` with no
 * way to tell a network failure from a bug in this package.
 * @param error - whatever was thrown.
 * @returns a message that names the cause.
 */
export function describeError(error) {
  if (error instanceof Error) return error.message;
  if (error === undefined || error === null) return String(error);
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const record = error;
    const named = [record.message, record.reason, record.code, record.name, record.type].find(
      (value) => typeof value === "string" && value.length > 0
    );
    if (named !== undefined) return named;
    try {
      const json = JSON.stringify(error);
      if (json !== undefined && json !== "{}") return json;
    } catch {
      /* circular or throwing getters: fall through to the tag */
    }
    return Object.prototype.toString.call(error);
  }
  return String(error);
}

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
