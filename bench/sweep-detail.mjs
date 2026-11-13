// READ-ONLY: exactly what the 16:03-16:04 sweep did and whether it moved the needle.
import zlib from 'node:zlib';
import fs from 'node:fs';

const F = '/home/agent/.dsh/sessions/--home-agent-workspaces--/session-65bd8898-db92-4879-8e80-0f1465d1f8d3/session.v4.jsonl.zstd';
const events = zlib.zstdDecompressSync(fs.readFileSync(F)).toString('utf8')
  .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  .filter((e) => Number.isSafeInteger(e.seq));

const comps = events.filter((e) => e.type === 'compaction/summary').sort((a, b) => a.time - b.time).slice(-6);
let reclaimed = 0;
for (const c of comps) {
  const body = (c.data.summary ?? []).map((b) => b.text ?? '').join('');
  const kept = Math.round(body.length / 3.9);
  reclaimed += (c.data.shadowedTokenCount ?? 0) - kept;
}
console.log('the six passes reclaimed', reclaimed, 'tokens total');
console.log('');
const lastTs = comps[comps.length - 1].time;
console.log('last compaction:', new Date(lastTs).toISOString());
console.log('minutes since   :', ((Date.now() - lastTs) / 60000).toFixed(1));
console.log('');
console.log('events after the last compaction:', events.filter((e) => e.seq > comps[comps.length - 1].seq).length);
console.log('last event at:', new Date(Math.max(...events.map((e) => e.time ?? 0))).toISOString());
console.log('');
console.log('=== fallback bodies: what went wrong ===');
for (const c of comps.filter((x) => (x.data.summary ?? []).some((b) => (b.text ?? '').includes('DETERMINISTIC')))) {
  const body = (c.data.summary ?? []).map((b) => b.text ?? '').join('');
  console.log('  seq', c.seq, '| nodes', (c.data.shadowedSeqs ?? []).length,
    '| span', c.data.shadowedTokenCount, '| cap', c.data.maxTokens ?? 'none',
    '| body', body.length, 'chars');
}
