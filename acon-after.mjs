
import fs from "node:fs";
import { complete } from "./bench/llm.mjs";
import { buildInstruction } from "./src/summarize.js";
import { countTokens } from "./bench/equal-budget.mjs";

const ids = ["e47becba","95bcc1c8","76d63226","00ca467f","81507db6","505af2f5","6456829e","0ea62687","efc3f7c2","gpt4_18c2b244","gpt4_98f46fc6","6613b389","06db6396","7e00a6cb","e3fc4d6e"];
const d = JSON.parse(fs.readFileSync("/home/agent/workspaces/lcmx-study/data/longmemeval_s.json", "utf8"));
const byId = new Map(d.map((q) => [q.question_id, q]));

const rows = [];
for (const id of ids) {
  const q = byId.get(id);
  if (!q) continue;
  const hay = q.haystack_sessions.map((s, i) => "### session " + i + "\n" + s.map((m) => m.role.toUpperCase() + ": " + m.content).join("\n")).join("\n\n");
  const tok = countTokens(hay);
  const budget = Math.min(16384, Math.max(512, Math.floor(tok * 0.12)));
  let ckpt;
  try {
    ckpt = (await complete({ prompt: "以下是本次会话的一段历史记录：\n\n" + hay + "\n\n=== INSTRUCTION ===\n" + buildInstruction(budget, tok, 0), model: "balanced-lite", timeoutMs: 900000 })).content;
  } catch (e) { rows.push({ id, error: "compress: " + String(e).slice(0, 50) }); console.log(id, "COMPRESS ERROR"); continue; }
  const gold = String(q.answer).trim();
  const goldInCkpt = ckpt.toLowerCase().includes(gold.toLowerCase());
  let answer;
  try {
    answer = (await complete({ prompt: "You are answering a question about a long conversation history with a user.\n\n<context>\n" + ckpt + "\n</context>\n\nQuestion: " + q.question + "\n\nAnswer with a short phrase or sentence. Do not explain your reasoning. If the context does not contain the answer, say UNKNOWN.", model: "balanced-lite", timeoutMs: 300000 })).content.trim();
  } catch (e) { rows.push({ id, goldInCkpt, error: "answer: " + String(e).slice(0, 50) }); console.log(id, "ANSWER ERROR"); continue; }
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").replace(/[.,;:!?。，；：！？]/g, "").trim();
  const stringCorrect = norm(answer).includes(norm(gold)) || norm(gold).includes(norm(answer));
  rows.push({ id, goldInCkpt, answer: answer.slice(0, 80), stringCorrect, chars: ckpt.length });
  console.log(id, "| goldInCkpt:", goldInCkpt, "| stringCorrect:", stringCorrect, "|", JSON.stringify(answer.slice(0, 40)));
}
const ok = rows.filter((r) => r.stringCorrect).length;
const present = rows.filter((r) => r.goldInCkpt).length;
console.log("=== ANSWERABLE:", ok + "/" + ids.length, "| GOLD PRESENT:", present + "/" + ids.length, "===");
fs.writeFileSync("bench/results/acon-after-facts-20261108.json", JSON.stringify({ ids, rows, ok, present }, null, 1));
