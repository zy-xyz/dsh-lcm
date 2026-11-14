// Is a 256-text batch feasible right now? The backfill has been waiting 5+ min.
import fs from "node:fs";
const K = fs.readFileSync("/home/agent/.dsh/.credentials.yaml", "utf8").match(/OMNIROUTE_API_KEY[\s\S]{0,80}?([A-Za-z0-9_-]{20,})/)[1];
const URL = "http://10.126.126.4:20128/v1/embeddings";
for (const n of [32, 64, 128, 256]) {
  const batch = Array.from({ length: n }, (_, i) => "probe text " + i + " with filler content to be realistic");
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const r = await fetch(URL, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + K }, body: JSON.stringify({ model: "mistral-proxy/codestral-embed", input: batch }), signal: ctrl.signal });
    const ms = Date.now() - t0;
    if (!r.ok) { const t = await r.text(); console.log(`${n}: http=${r.status} ${ms}ms ${t.slice(0, 60)}`); continue; }
    const j = await r.json();
    console.log(`${n}: ok ${ms}ms -> ${(n / (ms / 1000)).toFixed(1)} texts/s`);
  } catch (e) { console.log(`${n}: FAILED ${Date.now() - t0}ms ${String(e.message).slice(0, 40)}`); }
  finally { clearTimeout(timer); }
}