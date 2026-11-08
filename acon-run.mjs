
import fs from "node:fs";
import { complete } from "./bench/llm.mjs";
import { buildInstruction } from "./src/summarize.js";
import { countTokens } from "./bench/equal-budget.mjs";

const ids = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync("/home/agent/workspaces/lcmx-study/data/longmemeval_s.json", "utf8"));
const byId = new Map(d.map((q) => [q.question_id, q]));
const LOG = "/tmp/acon-after.log";
fs.writeFileSync(LOG, "");

for (const id of ids) {
  const q = byId.get(id);
  if (!q) continue;
  const hay = q.haystack_sessions.map((s, i) => "### session " + i + "\n" + s.map((m) => m.role.toUpperCase() + ": " + m.content).join("\n")).join("\n\n");
  const tok = countTokens(hay);
  const budget = Math.min(16384, Math.max(512, Math.floor(tok * 0.12)));
  let ckpt;
  try {
    ckpt = (await complete({ prompt: "以下是本次会话的一段历史记录：\n\n" + hay + "\n\n=== INSTRUCTION ===\n" + buildInstruction(budget, tok, 0), model: "balanced-lite", timeoutMs: 900000 })).content;
  } catch (e) {
    fs.appendFileSync(LOG, id + " COMPRESS_ERROR " + String(e).slice(0, 60) + "\n");
    continue;
  }
  const gold = String(q.answer).trim();
  const goldIn = ckpt.toLowerCase().includes(gold.toLowerCase());
  const hasFactsSection = /##\s*用户事实/.test(ckpt);
  let answer;
  try {
    answer = (await complete({ prompt: "You are answering a question about a long conversation history with a user.\n\n<context>\n" + ckpt + "\n</context>\n\nQuestion: " + q.question + "\n\nAnswer with a short phrase or sentence. Do not explain your reasoning. If the context does not contain the answer, say UNKNOWN.", model: "balanced-lite", timeoutMs: 300000 })).content.trim();
  } catch (e) {
    fs.appendFileSync(LOG, id + " ANSWER_ERROR " + String(e).slice(0, 60) + "\n");
    continue;
  }
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").replace(/[.,;:!?。，；：！？]/g, "").trim();
  const ok = norm(answer).includes(norm(gold)) || norm(gold).includes(norm(answer));
  fs.appendFileSync(LOG, [id, "goldIn=" + goldIn, "facts=" + hasFactsSection, "chars=" + ckpt.length, "ok=" + ok, "answer=" + JSON.stringify(answer.slice(0, 45))].join(" | ") + "\n");
  fs.writeFileSync("/tmp/acon-after-" + id + ".txt", ckpt);
}
fs.appendFileSync(LOG, "DONE\n");
