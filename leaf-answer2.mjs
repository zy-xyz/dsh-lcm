
import fs from "node:fs";
import { complete } from "./bench/llm.mjs";
import { buildInstruction } from "./src/summarize.js";
import { countTokens } from "./bench/equal-budget.mjs";

const IDS = ["00ca467f","81507db6","505af2f5","6456829e","efc3f7c2","gpt4_18c2b244","gpt4_98f46fc6","6613b389","06db6396","7e00a6cb","e3fc4d6e"];
const LEAF = 24000;
const LOG = "/tmp/leaf-answer2.log";
const OUT = "bench/results/leaf-answerability-20261108.json";
fs.writeFileSync(LOG, "");
const d = JSON.parse(fs.readFileSync("/home/agent/workspaces/lcmx-study/data/longmemeval_s.json", "utf8"));
const byId = new Map(d.map((q) => [q.question_id, q]));
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").replace(/[.,;:!?。，；：！？、]/g, "").trim();
const rows = [];

for (const id of IDS) {
  const q = byId.get(id);
  if (!q) continue;
  const sessions = q.haystack_sessions;
  const leaves = [];
  let cur = [], curTok = 0;
  for (let i = 0; i < sessions.length; i++) {
    const t = countTokens("### session " + i + "\n" + sessions[i].map((m) => m.role.toUpperCase() + ": " + m.content).join("\n"));
    if (curTok + t > LEAF && cur.length > 0) { leaves.push({ ids: cur, tok: curTok }); cur = []; curTok = 0; }
    cur.push(i); curTok += t;
  }
  if (cur.length) leaves.push({ ids: cur, tok: curTok });
  const parts = [];
  let bad = 0;
  for (const leaf of leaves) {
    const hay = leaf.ids.map((i) => "### session " + i + "\n" + sessions[i].map((m) => m.role.toUpperCase() + ": " + m.content).join("\n")).join("\n\n");
    const budget = Math.min(2048, Math.max(512, Math.floor(leaf.tok * 0.12)));
    try {
      const out = await complete({ prompt: "以下是本次会话的一段历史记录：\n\n" + hay + "\n\n=== INSTRUCTION ===\n" + buildInstruction(budget, leaf.tok, 0), model: "balanced-lite", maxTokens: Math.max(4096, budget * 2), timeoutMs: 600000 });
      parts.push(out.content);
      if ((out.content.match(/^## /gm) || []).length < 5) bad += 1;
    } catch (e) { bad += 1; }
  }
  const ckpt = parts.join("\n\n");
  let answer = "";
  try {
    answer = (await complete({ prompt: "You are answering a question about a long conversation history with a user.\n\n<context>\n" + ckpt + "\n</context>\n\nQuestion: " + q.question + "\n\nAnswer with a short phrase or sentence. Do not explain your reasoning. If the context does not contain the answer, say UNKNOWN.", model: "balanced-lite", timeoutMs: 300000 })).content.trim();
  } catch (e) { rows.push({ id, error: "answer" }); fs.appendFileSync(LOG, id + " ANSWER_ERR\n"); continue; }
  const gold = String(q.answer).trim();
  const ok = norm(answer).includes(norm(gold)) || norm(gold).includes(norm(answer));
  rows.push({ id, leaves: leaves.length, chars: ckpt.length, badLeaves: bad, answer: answer.slice(0, 80), ok });
  fs.appendFileSync(LOG, [id, "leaves=" + leaves.length, "bad=" + bad, "ok=" + ok, JSON.stringify(answer.slice(0, 40))].join(" | ") + "\n");
  fs.writeFileSync(OUT, JSON.stringify({ ids: IDS, rows, ok: rows.filter((r) => r.ok).length, total: IDS.length }, null, 1));
}
fs.appendFileSync(LOG, "DONE ok=" + rows.filter((r) => r.ok).length + "/" + IDS.length + "\n");
