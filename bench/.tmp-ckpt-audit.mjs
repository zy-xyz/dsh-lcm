import fs from "node:fs";
import { buildInstruction } from "/home/agent/workspaces/lcmx-study/dsh-lcm/src/summarize.js";
import { countTokens, defaultBudget } from "/home/agent/workspaces/lcmx-study/dsh-lcm/bench/equal-budget.mjs";

const KEY = (process.env.OMNIROUTE_API_KEY ?? process.env.OPENAI_API_KEY ?? (()=>{const t=fs.readFileSync(process.env.HOME+"/.dsh/.credentials.yaml","utf8");return /sk-[A-Za-z0-9_-]{20,}/.exec(t)[0];})());
const BASE = "http://10.126.126.4:20128/v1";
const ds = JSON.parse(fs.readFileSync("/home/agent/workspaces/lcmx-study/data/longmemeval_s.json","utf8"));

const norm = (s)=>String(s??"").toLowerCase().replace(/[^a-z0-9\u3400-\u4dbf\u4e00-\u9fff]+/gu," ").trim().replace(/\s+/gu," ");

function sections(ck){
  const lines = ck.split("\n");
  const out = {}; let cur = "(preamble)"; out[cur]=[];
  for (const l of lines){ const m=/^##\s+(.+)$/.exec(l); if(m){cur=m[1].trim(); out[cur]=out[cur]??[]; continue;} (out[cur]=out[cur]??[]).push(l); }
  return out;
}

const indices = process.argv.slice(2).map(Number);
for (const idx of indices) {
  const q = ds[idx];
  const hay = (()=>{const out=[];const S=q.haystack_sessions??[];const I=q.haystack_session_ids??[];const D=q.haystack_dates??[];
    for(let s=0;s<S.length;s++){out.push("[session "+(I[s]??"s"+s)+" | "+(D[s]??"")+"]");for(const m of (S[s]??[]))out.push(String(m.role??"user")+": "+String(m.content??""));}return out.join("\n");})();
  const tok = countTokens(hay);
  const budget = defaultBudget({tokensEstimate: tok});
  const instruction = buildInstruction(budget, tok, 0);
  const prompt = "以下是本次会话的一段历史记录：\n\n"+hay+"\n\n=== INSTRUCTION ===\n"+instruction;
  const res = await fetch(BASE+"/chat/completions",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+KEY},body:JSON.stringify({model:"balanced-lite",messages:[{role:"user",content:prompt}],max_tokens:budget,temperature:0})});
  const j = await res.json();
  const ck = String(j.choices?.[0]?.message?.content??"").trim();
  const secs = sections(ck);
  const total = ck.length;
  const gold = String(q.answer ?? "");
  const g = norm(gold);
  const present = g.length>0 && norm(ck).includes(g);
  console.log("---- idx "+idx+" | "+q.question_id+" | "+q.question_type+" ----");
  console.log("Q: "+q.question);
  console.log("gold: "+JSON.stringify(gold)+" | IN CHECKPOINT: "+present);
  console.log("haystack "+tok+" tok | budget "+budget+" | ckpt "+ck.length+"ch ~"+countTokens(ck)+"tok | finish "+(j.choices?.[0]?.finish_reason));
  const parts = Object.entries(secs).map(([k,v])=>{const txt=v.join("\n");const nl=v.filter(x=>x.trim().startsWith("- ")).length;return [k, txt.length, nl];});
  const anchorChars = parts.filter(([k])=>/锚点/.test(k)).reduce((s,[,c])=>s+c,0);
  console.log("sections: "+parts.map(([k,c,nl])=>k+"="+c+"ch/"+nl+"bullets").join(" | "));
  console.log("anchor section share: "+(100*anchorChars/Math.max(1,total)).toFixed(1)+"%");
  console.log("");
}
