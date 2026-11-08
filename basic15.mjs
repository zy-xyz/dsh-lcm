
import fs from "node:fs";
import { complete } from "./bench/llm.mjs";
import { countTokens } from "./bench/equal-budget.mjs";

// The frozen built-in instruction, same file the Layer 2 basic arm uses, so this is
// the same compressor dsh ships. One call over the whole span, 16384 budget - the
// shape basic uses. Same 15 questions, same answerer, same string rule as the leaf
// run, so the two numbers are comparable.
const INSTRUCTION = fs.readFileSync("bench/fixtures/basic-instruction.txt", "utf8");
const IDS = ["e47becba","95bcc1c8","76d63226","00ca467f","81507db6","505af2f5","6456829e","0ea62687","efc3f7c2","gpt4_18c2b244","gpt4_98f46fc6","6613b389","06db6396","7e00a6cb","e3fc4d6e"];
const LOG = "/tmp/basic15.log";
fs.writeFileSync(LOG, "");
const d = JSON.parse(fs.readFileSync("/home/agent/workspaces/lcmx-study/data/longmemeval_s.json", "utf8"));
const byId = new Map(d.map((q) => [q.question_id, q]));
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").replace(/[.,;:!?。，；：！？、]/g, "").trim();
const rows = [];

for (const id of IDS) {
  const q = byId.get(id);
  if (!q) continue;
  const hay = q.haystack_sessions.map((s, i) => "### session " + i + "\n" + s.map((m) => m.role.toUpperCase() + ": " + m.content).join("\n")).join("\n\n");
  const tok = countTokens(hay);
  let ckpt;
  try {
    ckpt = (await complete({ prompt: hay + "\n\n" + INSTRUCTION, model: "balanced-lite", maxTokens: 32768, timeoutMs: 900000 })).content;
  } catch (e) { rows.push({ id, error: "compress" }); fs.appendFileSync(LOG, id + " COMPRESS_ERR\n"); continue; }
  let answer;
  try {
    answer = (await complete({ prompt: "You are answering a question about a long conversation history with a user.\n\n<context>\n" + ckpt + "\n</context>\n\nQuestion: " + q.question + "\n\nAnswer with a short phrase or sentence. Do not explain your reasoning. If the context does not contain the answer, say UNKNOWN.", model: "balanced-lite", timeoutMs: 300000 })).content.trim();
  } catch (e) { rows.push({ id, error: "answer" }); fs.appendFileSync(LOG, id + " ANSWER_ERR\n"); continue; }
  const gold = String(q.answer).trim();
  const ok = norm(answer).includes(norm(gold)) || norm(gold).includes(norm(answer));
  rows.push({ id, chars: ckpt.length, gold: gold.slice(0, 30), answer: answer.slice(0, 60), ok });
  fs.appendFileSync(LOG, [id, "chars=" + ckpt.length, "ok=" + ok, JSON.stringify(answer.slice(0, 40))].join(" | ") + "\n");
  fs.writeFileSync("bench/results/basic-15pairs-20261108.json", JSON.stringify({ ids: IDS, rows, ok: rows.filter((r) => r.ok).length, total: IDS.length }, null, 1));
}
fs.appendFileSync(LOG, "DONE ok=" + rows.filter((r) => r.ok).length + "/" + IDS.length + "\n");
