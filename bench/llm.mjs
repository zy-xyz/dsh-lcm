/**
 * Direct OpenAI-compatible client for the benchmark harnesses.
 *
 * The benchmarks used to reach the model through the agent's MCP transport,
 * which has two properties that quietly corrupted measurements:
 *   1. a ~60s deadline — long prompts were killed mid-call, so whole arms
 *      (notably the anchor-enumeration arm) simply had no data;
 *   2. the `max_tokens` in the request was not enforced, so "equal budget"
 *      comparisons were never actually equal.
 *
 * Calling the gateway over plain HTTP fixes both: the deadline is ours, and the
 * ceiling really applies. Credentials come from the environment first, then the
 * DSH credential file, so the harness runs outside the agent as well.
 *
 * @module bench/llm
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Default gateway: the routed OpenAI-compatible endpoint. */
const DEFAULT_BASE_URL = "http://10.126.126.4:20128/v1";
const DEFAULT_MODEL = "deepseek-v4-flash-auto";

/**
 * Resolve the API key from the environment, then the DSH credential file.
 * @returns the key.
 * @throws when no key is available.
 */
function resolveKey() {
  for (const name of ["OMNIROUTE_API_KEY", "OPENAI_API_KEY"]) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  const credentialFile = path.join(os.homedir(), ".dsh", ".credentials.yaml");
  if (fs.existsSync(credentialFile)) {
    const text = fs.readFileSync(credentialFile, "utf8");
    const match = /OMNIROUTE_API_KEY[^\n]*\n?\s*(?:value:\s*)?["']?(sk-[A-Za-z0-9_-]+)/.exec(text) ?? /(sk-[A-Za-z0-9_-]{20,})/.exec(text);
    if (match !== null) return match[1];
  }
  throw new Error("no gateway key: set OMNIROUTE_API_KEY or write it to ~/.dsh/.credentials.yaml");
}

/**
 * One chat completion with a caller-owned deadline.
 * @param options - `{ prompt, maxTokens, model?, baseUrl?, timeoutMs?, temperature? }`.
 * @returns `{ content, usage, model, elapsedMs }`.
 */
export async function complete(options) {
  const key = resolveKey();
  const baseUrl = options.baseUrl ?? process.env.OMNIROUTE_BASE_URL ?? DEFAULT_BASE_URL;
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(baseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: options.prompt }],
        max_tokens: options.maxTokens,
        temperature: options.temperature ?? 0
      }),
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) throw new Error("gateway " + response.status + ": " + body.slice(0, 300));
    const parsed = JSON.parse(body);
    const usage = parsed.usage ?? {};
    // Hidden reasoning is billed inside completion_tokens against the same
    // ceiling, so that number overstates how much TEXT a call wrote - measured at
    // 7264 of 12953 on one arm. Every caller that wants "how much summary came
    // back" must use visibleCompletionTokens, never completion_tokens.
    const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning ?? 0;
    const visible = typeof usage.completion_tokens === "number" ? Math.max(0, usage.completion_tokens - reasoning) : undefined;
    return {
      content: parsed.choices?.[0]?.message?.content ?? "",
      usage,
      reasoningTokens: reasoning,
      visibleCompletionTokens: visible,
      model: parsed.model ?? model,
      finishReason: parsed.choices?.[0]?.finish_reason ?? "unknown",
      elapsedMs: Date.now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}

// CLI smoke test: node bench/llm.mjs "say OK" [maxTokens]
if (process.argv[1]?.endsWith("llm.mjs")) {
  const prompt = process.argv[2] ?? "say OK";
  const maxTokens = Number(process.argv[3] ?? 32);
  const out = await complete({ prompt, maxTokens });
  console.log(JSON.stringify({
    model: out.model,
    elapsedMs: out.elapsedMs,
    finishReason: out.finishReason,
    completionTokens: out.usage.completion_tokens,
    content: out.content.slice(0, 200)
  }, null, 1));
}
