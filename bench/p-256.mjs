// How long does ONE 256-text batch actually take right now?
// The backfill has 8 in flight and nothing has completed in 5 minutes, so the
// ceiling may be under the real latency rather than the endpoint being dead.
import fs from "node:fs";
const K = fs.readFileSync("/home/agent/.dsh/.credentials.yaml", "utf8").match(/OMNIROUTE_API_KEY[\s\S]{0,80}?([A-Za-z0-9_-]{20,})/)[1];
const batch = Array.from({ length: 256 }, (_, i) => "latency probe text " + i + " with realistic filler content");
const t0 = Date.now();
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 300000);
try {
  const r = await fetch("http://10.126.126.4:20128/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + K },
    body: JSON.stringify({ model: "mistral-proxy/codestral-embed", input: batch }),
    signal: ctrl.signal
  });
  const ms = Date.now() - t0;
  if (!r.ok) console.log(`http=${r.status} ${ms}ms ${(await r.text()).slice(0, 80)}`);
  else { const j = await r.json(); console.log(`ok ${ms}ms ${j.data.length} vectors -> ${(256 / (ms / 1000)).toFixed(1)} texts/s`); }
} catch (e) { console.log(`FAILED ${Date.now() - t0}ms ${String(e.message).slice(0, 50)}`); }