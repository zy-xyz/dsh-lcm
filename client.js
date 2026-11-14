window.__ModuleLoader__.load({
  id: 'dsh-lcm/insight',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useCallback } = React;

    // The module id is the package plus a subpath so the Web app can tell this half
    // apart from the host row; the slot key matches the sidebar entry id.
    const PLUGIN = 'dsh-lcm/insight';
    const NS = 'lcmInsight';
    // The Session header row (breadcrumb, actions, utilities) is the row meant by
    // "the top bar of the trajectory/context line"; `utilities` is its right-aligned
    // list, the one slot there that takes list registrations.
    const HEADER_SLOT = 'conversation.session.header.utilities';
    // The central panel, selected by the sidebar entry's id, and the sidebar entry
    // itself: one installation serves both the readout and the detail.
    const PANEL_SLOT = 'main';
    const ENTRY_SLOT = 'sidebar.panellist';
    const REFRESH_MS = 5000;

    // ── palette ────────────────────────────────────────────────────────────
    // Three series hues that hold up in both themes, plus the host's own tokens
    // for everything structural. No gradients and no glow: a chart is read, not
    // admired.
    const SERIES = ['#4f7cf0', '#3fa89b', '#d3922f', '#c2686b'];

    const DICT = {
      en: {
        title: 'LCM insight',
        description: 'Compaction, structure and embedding statistics for this profile.',
        panel: 'LCM insight',
        session: 'This session',
        app: 'This profile',
        emptySession: 'No checkpoint in this session yet. Nothing has been compacted.',
        emptyApp: 'No session has been compacted in the last 30 days.',
        loading: 'Reading session logs…',
        offline: 'The insight endpoint did not answer. Restart dsh if the bundle was just installed.',
        checkpoints: 'Checkpoints',
        ratio: 'Compression',
        saved: 'Removed',
        kept: 'Kept',
        fallback: 'Degraded',
        anchors: 'Anchors',
        anchorsPerNode: 'per node',
        pressure: 'Pressure',
        ofThreshold: 'of the limit',
        days: 'Per day',
        spans: 'Span distribution',
        depths: 'Structure depth',
        sessions: 'Sessions',
        events: 'Events',
        rollups: 'Rollups',
        assertions: 'Assertions',
        vectors: 'Embeddings',
        unreadable: 'unreadable',
        estimated: 'Estimated from checkpoint bodies; spans are engine-recorded.',
        noPressure: 'No session is loaded in this process, so live pressure is unavailable.',
        recent: 'Recent checkpoints',
        nodes: 'nodes',
        colSeq: 'seq',
        colAt: 'at',
        colSpan: 'span',
        colDepth: 'd',
        colSession: 'session',
        colTokens: 'tokens',
      },
      zh: {
        title: 'LCM 洞察',
        description: '本配置档的压缩、结构与嵌入统计。',
        panel: 'LCM 洞察',
        session: '本会话',
        app: '本配置档',
        emptySession: '本会话还没有 checkpoint，尚未压缩过。',
        emptyApp: '近 30 天没有会话被压缩过。',
        loading: '正在读取会话日志…',
        offline: '洞察接口没有响应。若刚安装该 bundle，请重启 dsh。',
        checkpoints: '检查点',
        ratio: '压缩比',
        saved: '已移除',
        kept: '保留',
        fallback: '降级',
        anchors: '锚点',
        anchorsPerNode: '每节点',
        pressure: '压力',
        ofThreshold: '占上限',
        days: '按天',
        spans: '跨度分布',
        depths: '结构深度',
        sessions: '会话',
        events: '事件',
        rollups: '时间线',
        assertions: '断言',
        vectors: '嵌入',
        unreadable: '个不可读',
        estimated: '正文 token 为估算，跨度为引擎记录。',
        noPressure: '本进程未加载任何会话，实时压力不可用。',
        recent: '最近的检查点',
        nodes: '节点',
        colSeq: '序号',
        colAt: '时间',
        colSpan: '跨度',
        colDepth: '深度',
        colSession: '会话',
        colTokens: 'token',
      }
    };

    // ── formatting ─────────────────────────────────────────────────────────

    /** Compact token count: 1234 -> 1.2k, 1234567 -> 1.2M. */
    function tok(value) {
      if (value === null || value === undefined) return '—';
      const n = Number(value);
      if (!Number.isFinite(n)) return '—';
      if (n < 1000) return String(Math.round(n));
      if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
      return (n / 1000000).toFixed(1) + 'M';
    }

    function pct(value) {
      if (value === null || value === undefined || !Number.isFinite(value)) return '—';
      return (value * 100).toFixed(value >= 0.1 ? 0 : 1) + '%';
    }

    function ratioText(value) {
      if (value === null || value === undefined || !Number.isFinite(value)) return '—';
      return value.toFixed(1) + ':1';
    }

    function dayLabel(day) {
      return day.slice(5);
    }

    // ── styles ─────────────────────────────────────────────────────────────
    // One radius system, tabular figures for every number, host tokens for
    // structure. Rendered as a React element so unmounting removes it.
    const CSS = `
      .lcmi-root {
        --lcmi-radius: 6px;
        display: flex; flex-direction: column; gap: 18px;
        height: 100%; overflow-y: auto; padding: 20px 22px 28px;
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-base);
        font-size: 13px; line-height: 1.45;
      }
      .lcmi-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
      .lcmi-head h2 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
      .lcmi-head .lcmi-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .lcmi-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .lcmi-tab {
        appearance: none; background: none; border: 0; cursor: pointer;
        padding: 7px 12px; min-height: 34px; font: inherit; font-size: 12px;
        color: var(--dsw-alias-label-secondary);
        border-bottom: 2px solid transparent; margin-bottom: -1px;
      }
      .lcmi-tab[aria-selected='true'] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); }
      .lcmi-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .lcmi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(124px, 1fr)); gap: 10px; }
      .lcmi-stat {
        border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--lcmi-radius);
        background: var(--dsw-alias-bg-layer-1); padding: 10px 12px;
      }
      .lcmi-stat .k { color: var(--dsw-alias-label-secondary); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
      .lcmi-stat .v { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
      .lcmi-stat .n { color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
      .lcmi-card {
        border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--lcmi-radius);
        background: var(--dsw-alias-bg-layer-1); padding: 12px 14px;
      }
      .lcmi-card > h3 { margin: 0 0 10px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
      .lcmi-note { color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .lcmi-msg { padding: 28px 4px; color: var(--dsw-alias-label-secondary); font-size: 13px; }
      .lcmi-msg[data-tone='error'] { color: var(--dsw-alias-state-error-primary); }
      .lcmi-legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 8px; }
      .lcmi-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
      .lcmi-bars { display: flex; flex-direction: column; gap: 6px; }
      .lcmi-bar-row { display: grid; grid-template-columns: 74px 1fr 54px; align-items: center; gap: 8px; font-size: 12px; }
      .lcmi-bar-row .l { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
      .lcmi-bar-row .n { text-align: right; font-variant-numeric: tabular-nums; }
      .lcmi-bar { height: 8px; border-radius: 2px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
      .lcmi-bar > i { display: block; height: 100%; border-radius: 2px; }
      .lcmi-chip {
        appearance: none; cursor: pointer; font: inherit;
        display: inline-flex; align-items: center; gap: 6px;
        border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
        background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
        padding: 3px 10px; min-height: 26px; font-size: 11px;
        font-variant-numeric: tabular-nums;
      }
      .lcmi-chip:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
      .lcmi-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .lcmi-chip b { font-weight: 600; color: var(--dsw-alias-label-primary); }
      .lcmi-table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
      .lcmi-table th { text-align: left; font-weight: 500; color: var(--dsw-alias-label-secondary); font-size: 11px; padding: 4px 8px 4px 0; text-transform: uppercase; letter-spacing: 0.03em; }
      .lcmi-table td { padding: 5px 8px 5px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
      .lcmi-table td.num { text-align: right; }
      .lcmi-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    `;

    function Style() {
      return h('style', { 'data-plugin': PLUGIN }, CSS);
    }

    // ── charts ─────────────────────────────────────────────────────────────

    /**
     * Vertical bars over a labelled axis.
     *
     * Bars are drawn at a fixed viewBox and scaled by the container, so the chart
     * never reflows on resize. Values are printed above a bar only when it is tall
     * enough to hold the text.
     */
    function ColumnChart({ data, height = 96, color = SERIES[0], format = tok, ariaLabel }) {
      const max = Math.max(1, ...data.map((d) => d.value));
      const slot = 100 / Math.max(1, data.length);
      const barW = slot * 0.62;
      return h('div', null,
        h('svg', {
          viewBox: '0 0 100 ' + height,
          preserveAspectRatio: 'none',
          role: 'img',
          'aria-label': ariaLabel,
          style: { width: '100%', height: height + 'px', display: 'block' }
        },
          h('line', { x1: 0, y1: height - 14, x2: 100, y2: height - 14, stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 0.5, vectorEffect: 'non-scaling-stroke' }),
          data.map((d, i) => {
            const barH = Math.max(d.value === 0 ? 0 : 1.5, ((height - 22) * d.value) / max);
            return h('rect', {
              key: d.label + i,
              x: i * slot + (slot - barW) / 2,
              y: height - 14 - barH,
              width: barW,
              height: barH,
              rx: 0.8,
              fill: d.color ?? color,
              opacity: d.muted ? 0.45 : 1
            });
          })
        ),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums' } },
          data.length <= 8
            ? data.map((d, i) => h('span', { key: i }, d.label))
            : [data[0]?.label, data[data.length - 1]?.label].filter(Boolean).map((label, i) => h('span', { key: i }, label))
        ),
        h('div', { className: 'lcmi-note', style: { marginTop: '4px' } }, 'max ' + format(max))
      );
    }

    /** Horizontal labelled bars; used where the category name must be readable. */
    function BarRows({ data, format = tok, color = SERIES[0] }) {
      const max = Math.max(1, ...data.map((d) => d.value));
      return h('div', { className: 'lcmi-bars' },
        data.map((d, i) => h('div', { className: 'lcmi-bar-row', key: d.label + i },
          h('span', { className: 'l' }, d.label),
          h('span', { className: 'lcmi-bar' }, h('i', { style: { width: (100 * d.value) / max + '%', background: d.color ?? color } })),
          h('span', { className: 'n' }, format(d.value))
        ))
      );
    }

    /** Two-part donut: what compaction removed against what it kept. */
    function Donut({ saved, kept, t, size = 108 }) {
      const total = Math.max(1, saved + kept);
      const r = 42;
      const c = 2 * Math.PI * r;
      const savedLen = (c * saved) / total;
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: '16px' } },
        h('svg', { width: size, height: size, viewBox: '0 0 100 100', role: 'img', 'aria-label': 'removed vs kept' },
          h('circle', { cx: 50, cy: 50, r, fill: 'none', stroke: 'var(--dsw-alias-bg-layer-2)', strokeWidth: 13 }),
          h('circle', {
            cx: 50, cy: 50, r, fill: 'none', stroke: SERIES[1], strokeWidth: 13,
            strokeDasharray: savedLen + ' ' + (c - savedLen),
            strokeDashoffset: 0, transform: 'rotate(-90 50 50)', strokeLinecap: 'butt'
          }),
          h('text', {
            x: 50, y: 50, textAnchor: 'middle', dominantBaseline: 'central',
            fontSize: 17, fontWeight: 600, fill: 'var(--dsw-alias-label-primary)'
          }, ratioText(saved / Math.max(1, kept)))
        ),
        h('div', { className: 'lcmi-legend', style: { flexDirection: 'column', gap: '6px' } },
          h('span', null, h('i', { style: { background: SERIES[1] } }), t('saved') + ' ' + tok(saved)),
          h('span', null, h('i', { style: { background: 'var(--dsw-alias-bg-layer-2)' } }), t('kept') + ' ' + tok(kept))
        )
      );
    }

    /** One stat tile. */
    function Stat({ label, value, note }) {
      return h('div', { className: 'lcmi-stat' },
        h('div', { className: 'k' }, label),
        h('div', { className: 'v' }, value),
        note === undefined ? null : h('div', { className: 'n' }, note)
      );
    }

    function Card({ title, children, note }) {
      return h('div', { className: 'lcmi-card' },
        title === undefined ? null : h('h3', null, title),
        children,
        note === undefined ? null : h('div', { className: 'lcmi-note', style: { marginTop: '8px' } }, note)
      );
    }

    // ── data ───────────────────────────────────────────────────────────────

    /**
     * Poll one endpoint while a component is mounted.
     *
     * The interval is cleared on unmount and the in-flight request is abandoned via
     * its own signal, so closing the panel stops the work instead of leaving a
     * timer behind — the disposal rule this plugin's `ctx.effect` also follows.
     * @returns `{ data, error, loading, reload }`.
     */
    function useEndpoint(url) {
      const [state, setState] = useState({ data: null, error: null, loading: true });
      const [nonce, setNonce] = useState(0);
      const reload = useCallback(() => setNonce((n) => n + 1), []);
      useEffect(() => {
        let live = true;
        const controller = new AbortController();
        const load = async () => {
          try {
            const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
            if (!response.ok) {
              const detail = await response.json().catch(() => ({}));
              throw new Error(detail.error ?? 'HTTP ' + response.status);
            }
            const body = await response.json();
            if (live) setState({ data: body, error: null, loading: false });
          } catch (error) {
            if (!live || controller.signal.aborted) return;
            setState((prev) => ({ data: prev.data, error: String(error.message ?? error), loading: false }));
          }
        };
        load();
        const timer = setInterval(load, REFRESH_MS);
        return () => {
          live = false;
          controller.abort();
          clearInterval(timer);
        };
      }, [url, nonce]);
      return { ...state, reload };
    }

    // ── session view ───────────────────────────────────────────────────────

    function SessionView({ data, t }) {
      const report = data.report;
      const totals = report.totals;
      if (totals.count === 0) return h('div', { className: 'lcmi-msg' }, t('emptySession'));

      const share = data.tokens !== null && data.threshold ? data.tokens / data.threshold : null;
      const days = report.days.slice(-14).map((d) => ({ label: dayLabel(d.day), value: d.count }));
      const spans = report.spans.map((s) => ({ label: s.label, value: s.count }));
      const depths = report.depths.map((d) => ({ label: 'd' + d.depth, value: d.count }));

      return h(React.Fragment, null,
        h('div', { className: 'lcmi-grid' },
          h(Stat, { label: t('checkpoints'), value: tok(totals.count), note: tok(totals.nodes) + ' ' + t('nodes') }),
          h(Stat, { label: t('ratio'), value: ratioText(totals.ratio), note: tok(totals.saved) + ' ' + t('saved') }),
          h(Stat, { label: t('pressure'), value: share === null ? '—' : pct(share), note: t('ofThreshold') }),
          h(Stat, {
            label: t('anchors'),
            value: tok(totals.anchors),
            note: totals.anchorsPerNode === null ? '—' : totals.anchorsPerNode.toFixed(2) + ' ' + t('anchorsPerNode')
          }),
          h(Stat, {
            label: t('fallback'),
            value: totals.fallbacks,
            note: totals.fallbackRate === null ? '—' : pct(totals.fallbackRate)
          })
        ),
        h(Card, { title: t('kept') + ' / ' + t('saved') }, h(Donut, { saved: totals.saved, kept: totals.kept, t })),
        days.length > 1 || (days[0] && days[0].value > 0)
          ? h(Card, { title: t('days') }, h(ColumnChart, { data: days, ariaLabel: t('days'), format: String }))
          : null,
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px' } },
          h(Card, { title: t('spans') }, h(ColumnChart, { data: spans, color: SERIES[2], ariaLabel: t('spans'), format: String })),
          h(Card, { title: t('depths') }, h(ColumnChart, { data: depths, color: SERIES[1], ariaLabel: t('depths'), format: String }))
        ),
        h(Card, { title: t('recent') },
          h('table', { className: 'lcmi-table' },
            h('thead', null, h('tr', null,
              h('th', null, t('colSeq')), h('th', null, t('colAt')), h('th', { className: 'num' }, t('colSpan')),
              h('th', { className: 'num' }, t('kept')), h('th', { className: 'num' }, t('ratio')),
              h('th', { className: 'num' }, t('colDepth')), h('th', { className: 'num' }, t('anchors'))
            )),
            h('tbody', null, report.recent.slice().reverse().slice(0, 12).map((row) => h('tr', { key: row.seq },
              h('td', { className: 'lcmi-mono' }, row.seq),
              h('td', { className: 'lcmi-mono' }, row.at === null ? '—' : new Date(row.at).toISOString().slice(5, 16).replace('T', ' ')),
              h('td', { className: 'num' }, tok(row.span)),
              h('td', { className: 'num' }, tok(row.kept)),
              h('td', { className: 'num' }, ratioText(row.span / Math.max(1, row.kept))),
              h('td', { className: 'num' }, row.depth),
              h('td', { className: 'num' }, row.fallback ? 'fallback' : row.anchors)
            )))
          )
        ),
        h('div', { className: 'lcmi-note' }, t('estimated'))
      );
    }

    // ── application view ───────────────────────────────────────────────────

    function AppView({ data, t }) {
      const days = data.days.slice(-21).map((d) => ({ label: dayLabel(d.day), value: d.count }));
      const spans = data.spans.map((s) => ({ label: s.label, value: s.count }));
      const totals = data.totals;
      if (data.perSession.filter((s) => s.checkpoints).length === 0) {
        return h('div', { className: 'lcmi-msg' }, t('emptyApp'));
      }
      return h(React.Fragment, null,
        h('div', { className: 'lcmi-grid' },
          h(Stat, { label: t('sessions'), value: tok(data.sessions), note: data.unreadable ? data.unreadable + ' ' + t('unreadable') : null }),
          h(Stat, { label: t('events'), value: tok(data.events) }),
          h(Stat, { label: t('checkpoints'), value: tok(totals.count) }),
          h(Stat, { label: t('ratio'), value: ratioText(totals.ratio), note: tok(totals.saved) + ' ' + t('saved') }),
          h(Stat, { label: t('rollups'), value: tok(data.sidecars.rollupRows), note: data.sidecars.rollupFiles + ' files' }),
          h(Stat, { label: t('assertions'), value: tok(data.sidecars.assertionRows), note: data.sidecars.assertionFiles + ' files' })
        ),
        data.vectors.length > 0
          ? h(Card, {
              title: t('vectors'),
              note: data.vectors.map((v) => v.family + ': ' + tok(v.entries) + ' entries, ' + (v.bytes / 1048576).toFixed(1) + ' MB').join(' · ')
            },
            h(BarRows, { data: data.vectors.map((v) => ({ label: v.family.split('-')[0], value: v.entries })), color: SERIES[2], format: String })
          )
          : null,
        days.length > 0 ? h(Card, { title: t('days') }, h(ColumnChart, { data: days, ariaLabel: t('days'), format: String })) : null,
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px' } },
          h(Card, { title: t('spans') }, h(ColumnChart, { data: spans, color: SERIES[2], ariaLabel: t('spans'), format: String })),
          h(Card, {
            title: t('pressure'),
            note: '% of the compaction threshold; red is over'
          },
            data.pressure.length === 0
              ? h('div', { className: 'lcmi-note' }, t('noPressure'))
              : h(BarRows, {
                  data: data.pressure.slice(0, 8).map((p) => ({
                    label: p.id.replace(/^session-/u, '').slice(0, 8),
                    value: Math.round((p.share ?? 0) * 100),
                    color: (p.share ?? 0) >= 1 ? SERIES[3] : (p.share ?? 0) >= 0.9 ? SERIES[2] : SERIES[0]
                  })),
                  format: (v) => v + '%',
                  color: SERIES[0]
                })
          )
        ),
        h(Card, { title: t('sessions') },
          h('table', { className: 'lcmi-table' },
            h('thead', null, h('tr', null,
              h('th', null, t('colSession')), h('th', { className: 'num' }, t('colTokens')),
              h('th', { className: 'num' }, t('checkpoints')), h('th', { className: 'num' }, t('ratio')),
              h('th', { className: 'num' }, t('rollups'))
            )),
            h('tbody', null, data.perSession.filter((s) => s.checkpoints !== null).slice(0, 12).map((row) => h('tr', { key: row.id },
              h('td', { className: 'lcmi-mono' }, row.id.replace(/^session-/u, '').slice(0, 10)),
              h('td', { className: 'num' }, tok(row.tokens)),
              h('td', { className: 'num' }, row.checkpoints),
              h('td', { className: 'num' }, ratioText(row.ratio)),
              h('td', { className: 'num' }, row.rollups)
            )))
          )
        ),
        h('div', { className: 'lcmi-note' }, t('estimated'))
      );
    }

    // ── the panel ──────────────────────────────────────────────────────────

    function Panel(props) {
      const t = props.t;
      const [tab, setTab] = useState('session');
      const sessionId = props.sessionId ?? props.session?.id ?? null;

      const sessionUrl = sessionId === null ? null : '/lcm-insight/session?id=' + encodeURIComponent(sessionId);
      const session = useEndpoint(sessionUrl ?? '/lcm-insight/session?id=unknown');
      const app = useEndpoint('/lcm-insight/app');

      // The session endpoint is only meaningful with an id; a null id keeps the
      // request idle instead of firing one that must 404.
      useEffect(() => {
        if (sessionId === null) return;
        // Nothing to do: useEndpoint already owns the lifecycle for the url.
      }, [sessionId]);

      const active = tab === 'session' ? session : app;
      const body = (() => {
        if (active.error !== null && active.data === null) {
          return h('div', { className: 'lcmi-msg', 'data-tone': 'error', role: 'alert' }, t('offline') + ' (' + active.error + ')');
        }
        if (active.loading && active.data === null) return h('div', { className: 'lcmi-msg' }, t('loading'));
        if (tab === 'session') {
          if (sessionId === null) return h('div', { className: 'lcmi-msg' }, t('emptySession'));
          if (session.data === null) return h('div', { className: 'lcmi-msg' }, t('loading'));
          return h(SessionView, { data: session.data, t });
        }
        if (app.data === null) return h('div', { className: 'lcmi-msg' }, t('loading'));
        return h(AppView, { data: app.data, t });
      })();

      return h('div', { className: 'lcmi-root' },
        h(Style),
        h('div', { className: 'lcmi-head' },
          h('h2', null, t('title')),
          h('span', { className: 'lcmi-sub' }, t('description'))
        ),
        h('div', { className: 'lcmi-tabs', role: 'tablist' },
          h('button', {
            className: 'lcmi-tab', role: 'tab', type: 'button',
            'aria-selected': tab === 'session' ? 'true' : 'false',
            onClick: () => setTab('session')
          }, t('session')),
          h('button', {
            className: 'lcmi-tab', role: 'tab', type: 'button',
            'aria-selected': tab === 'app' ? 'true' : 'false',
            onClick: () => setTab('app')
          }, t('app'))
        ),
        body
      );
    }

    // ── the sidebar entry and the header readout ───────────────────────────

    function SidebarIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16;
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round',
        'aria-hidden': true, style: { display: 'block' }
      },
        h('path', { d: 'M3 20h18' }),
        h('rect', { x: 5, y: 12, width: 3, height: 8, rx: 0.5 }),
        h('rect', { x: 10.5, y: 7, width: 3, height: 13, rx: 0.5 }),
        h('rect', { x: 16, y: 3, width: 3, height: 17, rx: 0.5 })
      );
    }

    /**
     * The Session header readout: two numbers and nothing else.
     *
     * A header utility is a glance, not a report — the panel owns the detail. It
     * renders nothing until the first successful read so an uninstalled endpoint
     * cannot leave an empty chip in every session header.
     */
    function HeaderReadout(props) {
      const t = props.t;
      const sessionId = props.sessionId ?? props.session?.id ?? null;
      const url = sessionId === null ? null : '/lcm-insight/session?id=' + encodeURIComponent(sessionId);
      const [data, setData] = useState(null);
      useEffect(() => {
        if (url === null) return undefined;
        let live = true;
        const controller = new AbortController();
        const load = async () => {
          try {
            const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
            if (!response.ok) return;
            const body = await response.json();
            if (live) setData(body);
          } catch {
            // A header readout never reports an error; the panel does that.
          }
        };
        load();
        const timer = setInterval(load, 15000);
        return () => {
          live = false;
          controller.abort();
          clearInterval(timer);
        };
      }, [url]);

      if (data === null || data.report.totals.count === 0) return null;
      const totals = data.report.totals;
      return h('button', {
        type: 'button',
        className: 'lcmi-chip',
        title: t('panel'),
        onClick: () => {
          // Selecting the sidebar entry is the sidebar's job; the header readout
          // only needs to be a readable summary, so it is a plain button with a
          // tooltip rather than a second navigation path.
        },
        style: { cursor: 'default' }
      },
        h('span', null, 'LCM'),
        h('b', null, totals.count),
        h('span', { 'aria-hidden': true }, '·'),
        h('b', null, ratioText(totals.ratio))
      );
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        ctx.effect(function* () {
          yield ctx.locale.register(NS, DICT);
          const t = ctx.locale.bind(NS);

          yield ctx.slots.inject(PANEL_SLOT, () => ctx.slots.register(
            { name: PANEL_SLOT, key: PLUGIN, locale: NS },
            (props) => h(Panel, { ...props, t })
          ));

          yield ctx.slots.inject(ENTRY_SLOT, () => ctx.slots.register(
            { name: ENTRY_SLOT, id: PLUGIN, order: 30, label: () => t('title'), locale: NS },
            SidebarIcon
          ));

          yield ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register(
            { name: HEADER_SLOT, id: 'dsh-lcm-insight-chip', order: 900, label: () => t('title'), locale: NS },
            (props) => h(HeaderReadout, { ...props, t })
          ));
        });
      }
    };
  }
});
