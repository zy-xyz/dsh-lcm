
import fs from "node:fs";
import { complete } from "./bench/llm.mjs";
import { buildInstruction } from "./src/summarize.js";
import { countTokens } from "./bench/equal-budget.mjs";

const IDS = ["e47becba","95bcc1c8","76d63226","00ca467f","81507db6","505af2f5","6456829e","0ea62687","efc3f7c2","gpt4_18c2b244","gpt4_98f46fc6","6613b389","06db6396","7e00a6cb","e3fc4d6e"];
const LOG = "/tmp/after-final.log";
const OUT = "bench/results/acon-after-final-20261108.json";
fs.writeFileSync(LOG, "");

const d = JSON.parse(fs.readFileSync("/home/agent/workspaces/lcmx-study/data/longmemeval_s.json", "utf8"));
const byId = new Map(d.map((q) => [q.question_id, q]));
const rows = [];
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").replace(/[.,;:!?。，；：！？、]/g, "").trim();

for (const id of IDS) {
  const q = byId.get(id);
  if (!q) { rows.push({ id, error: "missing" }); continue; }
  const hay = q.haystack_sessions.map((s, i) => "### session " + i + "\n" + s.map((m) => m.role.toUpperCase() + ": " + m.content).join("\n")).join("\n\n");
  const tok = countTokens(hay);
  const budget = Math.min(16384, Math.max(512, Math.floor(tok * 0.12)));
  let ckpt;
  try {
    ckpt = (await complete({ prompt: "以下是本次会话的一段历史记录：\n\n" + hay + "\n\n=== INSTRUCTION ===\n" + buildInstruction(budget, tok, 0), model: "balanced-lite", timeoutMs: 900000 })).content;
  } catch (e) { rows.push({ id, error: "compress: " + String(e).slice(0, 50) }); fs.appendFileSync(LOG, id + " COMPRESS_ERR\n"); continue; }
  fs.writeFileSync("/tmp/ckpt-" + id + ".txt", ckpt);
  const sections = (ckpt.match(/^## /gm) || []).length;
  const hasFacts = /##\s*用户事实/.test(ckpt);
  let answer;
  try {
    answer = (await complete({ prompt: "You are answering a question about a long conversation history with a user.\n\n<context>\n" + ckpt + "\n</context>\n\nQuestion: " + q.question + "\n\nAnswer with a short phrase or sentence. Do not explain your reasoning. If the context does not contain the answer, say UNKNOWN.", model: "balanced-lite", timeoutMs: 300000 })).content.trim();
  } catch (e) { rows.push({ id, sections, hasFacts, error: "answer: " + String(e).slice(0, 50) }); fs.appendFileSync(LOG, id + " ANSWER_ERR\n"); continue; }
  const gold = String(q.answer).trim();
  const ok = norm(answer).includes(norm(gold)) || norm(gold).includes(norm(answer));
  const row = { id, type: q.question_type, gold: gold.slice(0, 40), sections, hasFacts, chars: ckpt.length, answer: answer.slice(0, 60), ok };
  rows.push(row);
  fs.appendFileSync(LOG, [id, "sec=" + sections, "facts=" + hasFacts, "ok=" + ok, JSON.stringify(answer.slice(0, 40))].join(" | ") + "\n");
  fs.writeFileSync(OUT, JSON.stringify({ ids: IDS, rows, ok: rows.filter((r) => r.ok).length, total: IDS.length }, null, 1));
}
fs.appendFileSync(LOG, "DONE ok=" + rows.filter((r) => r.ok).length + "/" + IDS.length + "\n");
