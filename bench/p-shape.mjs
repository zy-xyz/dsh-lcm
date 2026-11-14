// The decisive comparison. 19 accounts x ~1 request/s means the endpoint allows
// ~19 REQUESTS per second — not 19 texts. A 256-text batch is ONE request that
// must finish on ONE account, which is why it took 181 s and returned HTTP 500:
// the upstream gave up, not the proxy.
//
// So: many small concurrent requests should beat one huge one. Measure it.
import fs from "node:fs";
const K = fs.readFileSync("/home/agent/.dsh/.credentials.yaml", "utf8").match(/OMNIROUTE_API_KEY[\s\S]{0,80}?([A-Za-z0-9_-]{20,})/)[1];
const URL = "http://10.126.126.4:20128/v1/embeddings";

async function batch(n, tag) {
  const input = Array.from({ length: n }, (_, i) => tag + " text " + i + " with realistic filler content for the tokenizer");
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const r = await fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + K },
      body: JSON.stringify({ model: "mistral-proxy/codestral-embed", input }),
      signal: ctrl.signal
    });
    const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, ms, n: 0 };
    const j = await r.json();
    return { ok: true, ms, n: j.data?.length ?? 0 };
  } catch { return { ok: false, ms: Date.now() - t0, n: 0 }; }
  finally { clearTimeout(timer); }
}

async function trial(label, size, conc) {
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: conc }, (_, i) => batch(size, label + i)));
  const ms = Date.now() - t0;
  const texts = rs.reduce((a, r) => a + r.n, 0);
  const ok = rs.filter((r) => r.ok).length;
  const lat = rs.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  const med = lat.length ? lat[Math.floor(lat.length / 2)] : 0;
  console.log(`${label}: batch ${size} x ${conc} = ${texts} texts in ${(ms / 1000).toFixed(1)}s`);
  console.log(`   ${ok}/${conc} ok | ${(texts / (ms / 1000)).toFixed(1)} texts/s | median latency ${med}ms`);
}

await trial("A", 32, 19);
await trial("B", 64, 10);