// READ-ONLY: current size of every active session, and how far each is from threshold.
import zlib from 'node:zlib';
import fs from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import { foldSurface } from '@deepseek-ai/dsh-session/surface';

const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);
const ROOT = '/home/agent/.dsh/sessions/--home-agent-workspaces--';
const WINDOW = 1000000, THRESHOLD = 750000;
const meter = new TokenMeter(new Context(), {});

for (const name of fs.readdirSync(ROOT)) {
  const f = ROOT + '/' + name + '/session.v4.jsonl.zstd';
  if (!fs.existsSync(f)) continue;
  const st = fs.statSync(f);
  const ageH = (Date.now() - st.mtimeMs) / 3600000;
  if (ageH > 12) continue;
  let raw;
  try {
    raw = zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8')
      .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .filter((e) => Number.isSafeInteger(e.seq));
  } catch { continue; }
  const bySeq = new Map(raw.map((e) => [e.seq, e]));
  const hdr = [...raw].reverse().find((e) => e.type === 'request/header');
  const session = {
    id: name,
    get events() { return raw; }, get seq() { return raw.length; },
    get surface() { return { nodes: foldSurface(raw.map((e) => (SURFACE.has(e.type) ? (e.surfaceOp === undefined ? { ...e, surfaceOp: 'append' } : e) : e))).nodes, replaceGeneration: 1 }; },
    eventAt: (s) => bySeq.get(s),
    deriveEventMessage: (e) => e?.data?.message ?? null,
    requestHeader: () => hdr?.data?.header ?? { config: { provider: 'p', model: 'm' }, tools: [] }
  };
  let m;
  try { m = meter.measure(session, session.requestHeader()); } catch { continue; }
  const comps = raw.filter((e) => e.type === 'compaction/summary').length;
  console.log(name.replace('session-', '').slice(0, 12),
    '|', String(m.totalTokens).padStart(7),
    '|', (100 * m.totalTokens / THRESHOLD).toFixed(0).padStart(4) + '% threshold',
    '|', m.totalTokens >= THRESHOLD ? 'OVER -> sweep owed' : 'below',
    '| comps', String(comps).padStart(3), '| idle', ageH.toFixed(1) + 'h');
}
