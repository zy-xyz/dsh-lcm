// READ-ONLY: compactions since the 0.20.0 restart, with the target each one used.
import zlib from 'node:zlib';
import fs from 'node:fs';

const ROOT = '/home/agent/.dsh/sessions/--home-agent-workspaces--';
const RESTART = Date.parse('2026-11-13T16:27:54+08:00');

const load = (f) => zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8')
  .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  .filter((e) => Number.isSafeInteger(e.seq));

const rows = [];
for (const name of fs.readdirSync(ROOT)) {
  const f = ROOT + '/' + name + '/session.v4.jsonl.zstd';
  if (!fs.existsSync(f)) continue;
  let events;
  try { events = load(f); } catch { continue; }
  for (const c of events.filter((e) => e.type === 'compaction/summary')) {
    if (c.time < RESTART) continue;
    const body = (c.data.summary ?? []).map((b) => b.text ?? '').join('');
    rows.push({
      name: name.replace('session-', '').slice(0, 12),
      seq: c.seq,
      at: new Date(c.time).toISOString().slice(5, 16),
      shadowed: c.data.shadowedTokenCount ?? 0,
      cap: c.data.maxTokens ?? null,
      kept: Math.round(body.length / 3.9),
      nodes: (c.data.shadowedSeqs ?? []).length,
      anchors: (body.match(/\(seq \d+\)/gu) ?? []).length,
      kind: body.includes('DETERMINISTIC fallback') ? 'FALLBACK' : body.includes('手动 /compact') ? 'manual' : 'model'
    });
  }
}
rows.sort((a, b) => a.at < b.at ? -1 : 1);
console.log('compactions since the 0.20.0 restart:', rows.length);
console.log('');
if (rows.length === 0) {
  console.log('none yet — no session has crossed its threshold since the restart.');
  process.exit(0);
}
console.log('  session       seq   at (UTC)   span    target  kept   ratio  nodes  anchors  kind');
for (const r of rows) {
  console.log('  ' + r.name.padEnd(13), String(r.seq).padStart(6), r.at,
    String(r.shadowed).padStart(7), String(r.cap ?? '-').padStart(7),
    String(r.kept).padStart(6), (r.shadowed / Math.max(1, r.kept)).toFixed(1).padStart(6) + ':1',
    String(r.nodes).padStart(5), String(r.anchors).padStart(7), ' ' + r.kind);
}
console.log('');
const model = rows.filter((r) => r.kind === 'model');
if (model.length > 0) {
  const caps = [...new Set(model.map((r) => r.cap))];
  console.log('distinct targets used by model leaves:', caps.join(', '), '(expect 2000)');
  console.log('every model leaf at 2000:', model.every((r) => r.cap === 2000) ? 'YES' : 'NO');
  const avgRatio = model.reduce((a, r) => a + r.shadowed / Math.max(1, r.kept), 0) / model.length;
  console.log('mean compression ratio:', avgRatio.toFixed(1) + ':1', '(before 0.20.0 it was ~8.3:1)');
}
