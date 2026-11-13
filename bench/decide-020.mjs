// READ-ONLY: is each recorded ceiling the OLD formula or the NEW one?
// The recorded field is the request ceiling: max(4096, 2 * target).
import zlib from 'node:zlib';
import fs from 'node:fs';

const ROOT = '/home/agent/.dsh/sessions/--home-agent-workspaces--';
const RESTART = Date.parse('2026-11-13T16:27:54+08:00');

const oldTarget = (span) => Math.min(Math.min(Math.max(Math.floor(span * 0.12), 512), 16384), 65536);
const newTarget = (span) => Math.min(Math.min(Math.max(Math.floor(span * 0.20), 2000), 2000), 65536);
const ceilingOf = (t) => Math.max(4096, t * 2);

const load = (f) => zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8')
  .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  .filter((e) => Number.isSafeInteger(e.seq));

let oldHits = 0, newHits = 0, ambiguous = 0, neither = 0;
const rows = [];
for (const name of fs.readdirSync(ROOT)) {
  const f = ROOT + '/' + name + '/session.v4.jsonl.zstd';
  if (!fs.existsSync(f)) continue;
  let events;
  try { events = load(f); } catch { continue; }
  for (const c of events.filter((e) => e.type === 'compaction/summary')) {
    if (c.time < RESTART) continue;
    const body = (c.data.summary ?? []).map((b) => b.text ?? '').join('');
    if (body.includes('DETERMINISTIC fallback')) continue;   // no call, no ceiling
    const span = c.data.shadowedTokenCount ?? 0;
    if (span <= 0) continue;
    const rec = c.data.maxTokens;
    const o = ceilingOf(oldTarget(span));
    const n = ceilingOf(newTarget(span));
    let verdict;
    if (o === n) { verdict = 'ambiguous'; ambiguous += 1; }
    else if (rec === n) { verdict = 'NEW'; newHits += 1; }
    else if (rec === o) { verdict = 'old'; oldHits += 1; }
    else { verdict = 'neither'; neither += 1; }
    rows.push({ span, rec, o, n, verdict });
  }
}
console.log('  span   recorded   old would send   new would send   verdict');
for (const r of rows.sort((a, b) => a.span - b.span)) {
  console.log('  ' + String(r.span).padStart(6), String(r.rec).padStart(10), String(r.o).padStart(16), String(r.n).padStart(16), '  ' + r.verdict);
}
console.log('');
console.log('decisive (old and new differ):', rows.filter((r) => r.o !== r.n).length);
console.log('  matched NEW:', newHits, '| matched old:', oldHits, '| neither:', neither);
console.log('ambiguous (both formulas agree, usually a tiny span):', ambiguous);
