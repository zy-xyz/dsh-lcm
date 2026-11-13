// READ-ONLY: compactions since the 0.21.0 restart, grouped into sweeps.
import zlib from 'node:zlib';
import fs from 'node:fs';

const ROOT = '/home/agent/.dsh/sessions/--home-agent-workspaces--';
const RESTART = Date.parse('2026-11-13T23:53:23+08:00');
const load = (f) => zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8')
  .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  .filter((e) => Number.isSafeInteger(e.seq));

let found = 0;
for (const name of fs.readdirSync(ROOT)) {
  const f = ROOT + '/' + name + '/session.v4.jsonl.zstd';
  if (!fs.existsSync(f)) continue;
  let events;
  try { events = load(f); } catch { continue; }
  const comps = events.filter((e) => e.type === 'compaction/summary' && e.time >= RESTART).sort((a, b) => a.time - b.time);
  if (comps.length === 0) continue;
  found += comps.length;
  console.log('=== ' + name.replace('session-', '').slice(0, 12) + ' | ' + comps.length + ' compaction(s) since restart');
  for (const c of comps) {
    const body = (c.data.summary ?? []).map((b) => b.text ?? '').join('');
    const nodes = (c.data.shadowedSeqs ?? []).length;
    const kept = Math.round(body.length / 3.9);
    const span = c.data.shadowedTokenCount ?? 0;
    const kind = body.includes('DETERMINISTIC fallback') ? 'FALLBACK'
      : body.includes('手动 /compact') ? 'manual'
      : nodes <= 4 && span > 5000 ? 'CONDENSATION' : 'leaf';
    console.log('  ' + new Date(c.time).toISOString().slice(5, 16),
      '| span', String(span).padStart(6), '-> kept', String(kept).padStart(5),
      '| ' + (span / Math.max(1, kept)).toFixed(1) + ':1',
      '| cap', String(c.data.maxTokens ?? '-').padStart(5),
      '| nodes', String(nodes).padStart(3), '| ' + kind);
  }
}
if (found === 0) console.log('no compaction since the restart yet.');
