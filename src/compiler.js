/**
 * Text primitives for `dsh-lcm`.
 *
 * Everything here is deterministic and dependency-free (no cordis, no dsh
 * imports) so it can be unit-tested and reused outside a running harness:
 *
 *   - a token estimator matching the harness's own density heuristic
 *   - sanitization of control bytes / ANSI escapes
 *   - budget truncation that never splits a surrogate pair
 *   - the checkpoint framing constants and the model-facing recall guide
 *
 * The region compiler that `dsh-compaction-instant` ships is intentionally NOT
 * here: this backend summarizes with a model, so it needs measurement and
 * framing, not a verbatim compiler.
 *
 * @module dsh-lcm/compiler
 */

// ── tokenizer ──────────────────────────────────────────────────────────────

const TOKEN_RE = /[a-zA-Z]+|[0-9]+|[^\sa-zA-Z0-9]|\s+/g;

/** Whether a UTF-16 code unit can be an unpaired high surrogate. */
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Whether a UTF-16 code unit can be an unpaired low surrogate. */
function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Move the end of a slice to a code-point boundary: a cut must never leave a
 * high surrogate without its low half (a lone surrogate renders as garbage
 * for the model and every UI).
 * @param text - sliced text.
 * @returns the text without a trailing unpaired high surrogate.
 */
function completeCodePointAtEnd(text) {
  return isHighSurrogate(text.charCodeAt(text.length - 1)) ? text.slice(0, -1) : text;
}

/**
 * Move the start of a slice to a code-point boundary (a tail excerpt must
 * never begin inside a surrogate pair).
 * @param text - sliced text.
 * @returns the text without a leading unpaired low surrogate.
 */
function completeCodePointAtStart(text) {
  return isLowSurrogate(text.charCodeAt(0)) ? text.slice(1) : text;
}

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * Split text into fixed-density tokens under the harness's character-class
 * heuristic: letter runs, digit runs, single punctuation chars, and whitespace
 * runs. Deterministic, offline, and consistent for every budget decision.
 * @param text - source text.
 * @returns the token list (whitespace tokens included, never counted).
 */
export function tokenize(text) {
  return text.match(TOKEN_RE) ?? [];
}

/**
 * DeepSeek's documented character→token conversion (quick_start/token_usage):
 * about 0.3 token per English character and 0.6 token per Chinese character.
 * The tokenizer still varies per model, so this is an estimate — the real
 * usage comes from the model's `usage` field.
 * @param char - one code point.
 * @returns true when the character carries the 0.6 CJK weight.
 */
export function isCjkChar(char) {
  const code = char.codePointAt(0);
  return (
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
    (code >= 0x3000 && code <= 0x303f) || // CJK Symbols and Punctuation
    (code >= 0xff00 && code <= 0xffef) // Fullwidth Forms
  );
}

/**
 * Estimate tokens under the DeepSeek docs conversion (0.3 per non-CJK
 * character, 0.6 per CJK character).
 * @param text - arbitrary text.
 * @returns the estimated token count (may be fractional).
 */
export function estimateDeepSeekTokens(text) {
  let nonCjk = 0;
  let cjk = 0;
  for (const char of text) {
    if (isCjkChar(char)) cjk += 1;
    else nonCjk += 1;
  }
  return (nonCjk * 3 + cjk * 6) / 10;
}

/** Count the non-whitespace tokens of a text under {@link tokenize}. */
export function countTokens(text) {
  let count = 0;
  for (const token of tokenize(text)) if (token.trim().length > 0) count += 1;
  return count;
}

/**
 * Size one text block the way every budget in this backend is enforced: the
 * word-class token count, floored at the DeepSeek-doc character density
 * equivalent so pathological long runs are not undercounted.
 * @param text - block text.
 * @returns the budget-relevant size in tokens.
 */
export function estimateEntryTokens(text) {
  return Math.max(countTokens(text), Math.ceil(estimateDeepSeekTokens(text)));
}

/**
 * Strip carriage returns, ANSI escapes, and control bytes — deterministic
 * cleanup, never token-changing rewrites.
 * @param text - raw text.
 * @returns sanitized text.
 */
export function sanitize(text) {
  if (typeof text !== "string") return "";
  let out = text;
  if (out.includes("\r")) out = out.replaceAll("\r", "");
  if (out.includes("\x1b")) out = out.replace(ANSI_RE, "");
  return out.replace(CTRL_RE, "");
}

// ── truncation ─────────────────────────────────────────────────────────────

/**
 * Truncate text to a non-whitespace-token budget, appending a provenance note
 * when something was cut.
 *
 * The tokenizer counts a whole unbroken run of letters or digits as one token,
 * so a pathological output (a 100 KB base64 blob, a minified file) could
 * otherwise pass any budget; every budget is therefore enforced twice — by
 * token count AND by a `limit * 4` character ceiling.
 * @param text - text to bound.
 * @param limit - non-whitespace token budget; `0` keeps nothing.
 * @param ref - provenance appended as `...(truncated from {ref})` on a cut.
 * @returns `{ text, truncated }`.
 */
export function truncateTokens(text, limit, ref) {
  const tokens = tokenize(text);
  let count = 0;
  let cut = tokens.length;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.trim().length === 0) continue;
    count += 1;
    if (count > limit) {
      cut = index;
      break;
    }
  }
  let out = cut >= tokens.length ? text : tokens.slice(0, cut).join("");
  let truncated = cut < tokens.length;
  const maxChars = Math.max(32, limit * 4);
  if (out.length > maxChars) {
    out = completeCodePointAtEnd(out.slice(0, maxChars));
    truncated = true;
  } else if (truncated) {
    out = completeCodePointAtEnd(out);
  }
  if (!truncated) return { text, truncated: false };
  out = out.replace(/\s+$/u, "");
  const note = ref === undefined ? "...(truncated)" : `...(truncated from ${ref})`;
  return { text: out + note, truncated: true };
}



// ── projection ─────────────────────────────────────────────────────────────

/**
 * Project nested tool-result blocks into one plain-text string: text blocks
 * are joined, images and documents render as labels.
 * @param blocks - nested result content.
 * @returns projected text.
 */
export function projectToolResultText(blocks) {
  const parts = [];
  for (const block of blocks) {
    if (block.type === "text") {
      const text = sanitize(block.text ?? "");
      if (text.length > 0) parts.push(text);
    } else if (block.type === "image") parts.push("[image]");
    else if (block.type === "document") parts.push("[document]");
    else parts.push(`[${String(block.type)}]`);
  }
  return parts.join("\n");
}

/**
 * Whether a message source identifies a landed compaction checkpoint node.
 * The harness brands these with `{ kind: "compact-checkpoint", compactionId }`
 * via `compactCheckpointSource`; any backend's checkpoint matches.
 * @param source - persisted message source.
 * @returns whether this node is a checkpoint.
 */
export function isCheckpointSource(source) {
  return source !== undefined && source !== null && source.kind === "compact-checkpoint";
}

// ── checkpoint framing ─────────────────────────────────────────────────────

/**
 * Instruction prefixed to every checkpoint so the model treats it as
 * established background rather than as a fresh user request.
 */
export const CHECKPOINT_PREAMBLE =
  "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";

/** Opening tag around the checkpoint body. */
export const CHECKPOINT_OPEN_TAG = "<compacted-checkpoint>";

/** Closing tag around the checkpoint body. */
export const CHECKPOINT_CLOSE_TAG = "</compacted-checkpoint>";

/**
 * Model-facing guide framed into the head of every checkpoint: tells the model
 * that the log is append-only and how to restore exact originals.
 */
export const RECALL_GUIDE =
  'RECALL: the session log is append-only — nothing is lost. This checkpoint is a summary, not the only copy. Use `lcm_expand` to restore exact original content by reference: type "seq", id "3-7,15"; or type "result", id "3" for a tool result. Use `lcm_search` to find anything by keyword or regex, including content this checkpoint omitted.';

/** Build marker for this backend revision, so debug logs prove which code ran. */
export const COMPILER_REV = "lcm-summary-1";

/**
 * Join framed entries with separators: consecutive tool rows join with a
 * single newline, every other boundary keeps a blank line.
 * @param entries - ordered entry texts (strings or `{ seq, text, kind }`).
 * @returns the joined body text.
 */
export function joinCompiledEntries(entries) {
  let out = "";
  let previousKind;
  for (const entry of entries) {
    const kind = typeof entry === "string" ? "text" : entry.kind;
    if (out.length > 0) out += previousKind === "tool" && kind === "tool" ? "\n" : "\n\n";
    out += typeof entry === "string" ? entry : entry.text;
    previousKind = kind;
  }
  return out;
}

/**
 * Frame compiled entries as the durable replacement checkpoint content: the
 * shared preamble, the recall guide, then one tagged block.
 * @param entries - ordered entry texts (strings or `{ seq, text, kind }`).
 * @param headerLine - optional structural header.
 * @param introLine - optional human-facing intro line.
 * @param footerLine - optional retention footer.
 * @returns the checkpoint content blocks.
 */
export function frameCheckpoint(entries, headerLine, introLine, footerLine) {
  const body = [RECALL_GUIDE];
  if (introLine !== undefined) body.push(introLine);
  if (headerLine !== undefined) body.push(headerLine);
  body.push(...entries);
  if (footerLine !== undefined) body.push(footerLine);
  return [
    { type: "text", text: `${CHECKPOINT_PREAMBLE}\n\n${CHECKPOINT_OPEN_TAG}` },
    { type: "text", text: joinCompiledEntries(body) },
    { type: "text", text: CHECKPOINT_CLOSE_TAG }
  ];
}
