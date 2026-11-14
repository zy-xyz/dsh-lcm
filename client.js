window.__ModuleLoader__.load({
  // The id MUST be the package name: client-modules keys the module graph by
  // `graphRow(packageName, ...)` and resolves `<id>/client` to that same row. A
  // subpath here left the bundle unregisterable and the row never activated.
  id: 'dsh-lcm',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useCallback } = React;

    // Slot keys are this plugin's own namespace; they are NOT the module id.
    const PLUGIN = 'lcm-insight';
    const NS = 'lcmInsight';
    // `conversation.view` is the row that carries 轨迹 / 上下文: a View tab beside
    // them, which is what "编队标签页" means. Two other placements were built and
    // removed — a chip in the session header row (competes with the host's own
    // navigation) and a floating overlay (covers the conversation it describes).
    const VIEW_SLOT = 'conversation.view';
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
        view: 'LCM',
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
        noSession: 'No session is open. Open one and this window follows it.',
        context: 'Context',
        systemPrompt: 'System prompt',
        rawMessages: 'Raw messages',
        raw: 'raw',
        messages: 'messages',
        onSurface: 'on surface',
        total: 'total',
        liveOnly: 'Available only while the session is loaded in this process.',
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
        view: 'LCM',
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
        noSession: '当前没有打开的会话。打开一个，本窗口会自动跟随。',
        context: '上下文',
        systemPrompt: '系统提示',
        rawMessages: '原始消息',
        raw: '原始',
        messages: '条',
        onSurface: '在表面',
        total: '共',
        liveOnly: '仅当该会话仍被本进程加载时可用。',
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
      /* A View tab renders inside the conversation column, which already owns the
         scroll container and the outer padding. So this is a plain flow block: no
         height, no overflow, no background of its own. */
      .lcmi-view {
        --lcmi-radius: 6px;
        display: flex; flex-direction: column; gap: 18px;
        padding: 16px 20px 28px;
        color: var(--dsw-alias-label-primary);
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
      /* Trees. The connector is a border on the row's leading edge at the depth's
         indent, so a deep branch reads as one line rather than as floating text. */
      .lcmi-tree { font-size: 12px; }
      .lcmi-tree-row {
        display: flex; align-items: baseline; gap: 6px;
        padding: 3px 0; min-height: 22px;
        border-left: 1px solid transparent;
      }
      .lcmi-tree-row[data-depth='1'] { border-left-color: var(--dsw-alias-border-l2); }
      .lcmi-tree-row[data-depth='2'] { border-left-color: var(--dsw-alias-border-l2); }
      .lcmi-twisty {
        appearance: none; background: none; border: 0; cursor: pointer; font: inherit;
        color: var(--dsw-alias-label-secondary); width: 14px; min-width: 14px;
        padding: 0; line-height: 1; text-align: center;
      }
      .lcmi-twisty:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; border-radius: 2px; }
      .lcmi-tree-label { color: var(--dsw-alias-label-primary); white-space: nowrap; }
      .lcmi-tree-label[data-tone='warn'] { color: var(--dsw-alias-state-error-primary); }
      .lcmi-tree-detail { color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
      .lcmi-tree-value {
        margin-left: auto; padding-left: 8px;
        font-variant-numeric: tabular-nums; font-weight: 600;
      }
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

    // ── trees ──────────────────────────────────────────────────────────────

    /**
     * One row of an indented tree.
     *
     * Indentation is left padding in whole steps, with a connector drawn as a
     * border on the row's leading edge. That keeps the tree readable without SVG
     * path bookkeeping, and it reflows on a narrow window instead of overflowing.
     */
    function TreeRow({ depth, label, detail, value, tone, expandable, expanded, onToggle }) {
      const pad = 8 + depth * 14;
      return h('div', {
        className: 'lcmi-tree-row',
        style: { paddingLeft: pad + 'px' },
        'data-depth': depth
      },
        expandable
          ? h('button', {
              type: 'button',
              className: 'lcmi-twisty',
              'aria-expanded': expanded ? 'true' : 'false',
              onClick: onToggle
            }, expanded ? '▾' : '▸')
          : h('span', { className: 'lcmi-twisty', 'aria-hidden': true }),
        h('span', { className: 'lcmi-tree-label', 'data-tone': tone ?? 'normal' }, label),
        detail === undefined ? null : h('span', { className: 'lcmi-tree-detail' }, detail),
        value === undefined ? null : h('span', { className: 'lcmi-tree-value' }, value)
      );
    }

    /**
     * The context tree: what the model is actually being sent, by kind.
     *
     * Three branches, in assembly order — system, checkpoints, raw messages — with
     * each checkpoint expandable to the nodes it absorbed. The numbers come from the
     * meter's own per-node prices, so they add up to the same total the engine
     * compares against its threshold; a view that disagreed with the engine would be
     * worse than no view.
     */
    function ContextTree({ data, t }) {
      const report = data.report;
      const composition = data.composition;
      const [open, setOpen] = useState(() => new Set());
      const toggle = useCallback((seq) => {
        setOpen((previous) => {
          const next = new Set(previous);
          if (next.has(seq)) next.delete(seq);
          else next.add(seq);
          return next;
        });
      }, []);

      const roots = report.tree?.roots ?? [];
      const total = data.tokens;

      const renderNode = (node, depth) => {
        const expanded = open.has(node.seq);
        const kids = node.children ?? [];
        const expandable = kids.length > 0 || node.rawMessages > 0;
        return h(React.Fragment, { key: node.seq },
          h(TreeRow, {
            depth,
            label: 'seq ' + node.seq,
            detail: (node.at === null ? '' : new Date(node.at).toISOString().slice(5, 16).replace('T', ' ') + ' · ') +
              'd' + node.depth + ' · ' + tok(node.span) + '→' + tok(node.kept),
            value: node.fallback ? t('fallback') : undefined,
            tone: node.fallback ? 'warn' : 'normal',
            expandable,
            expanded,
            onToggle: () => toggle(node.seq)
          }),
          expanded
            ? h(React.Fragment, null,
                kids.map((child) => renderNode(child, depth + 1)),
                node.rawMessages > 0
                  ? h(TreeRow, {
                      depth: depth + 1,
                      label: t('rawMessages'),
                      detail: node.rawMessages + ' ' + t('messages'),
                      value: undefined
                    })
                  : null
              )
            : null
        );
      };

      return h('div', { className: 'lcmi-tree' },
        h(TreeRow, {
          depth: 0,
          label: t('context'),
          detail: total === null ? t('liveOnly') : tok(total) + (data.threshold ? ' / ' + tok(data.threshold) : ''),
          value: data.threshold && total !== null ? pct(total / data.threshold) : undefined
        }),
        composition === null
          ? h('div', { className: 'lcmi-note', style: { paddingLeft: '22px' } }, t('liveOnly'))
          : h(React.Fragment, null,
              h(TreeRow, { depth: 1, label: t('systemPrompt'), detail: composition.nodes.system + ' ' + t('messages'), value: tok(composition.system) }),
              h(TreeRow, {
                depth: 1,
                label: t('checkpoints'),
                detail: roots.length + ' ' + t('onSurface') + ' / ' + (report.tree?.total ?? 0) + ' ' + t('total'),
                value: tok(composition.checkpoints)
              }),
              roots.map((node) => renderNode(node, 2)),
              h(TreeRow, { depth: 1, label: t('rawMessages'), detail: composition.nodes.raw + ' ' + t('messages'), value: tok(composition.raw) })
            )
      );
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
        h(Card, { title: t('context') }, h(ContextTree, { data, t })),
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

    /**
     * The View tab's body.
     *
     * This is the ONLY surface the plugin renders. A header chip and a floating
     * window were both built and removed; the tab is where a per-session report
     * belongs, because the tab row is already how the host switches between views of
     * one session.
     *
     * `sessionId` arrives from the View registration's `inject(sessionId)`; the store
     * lookup is the fallback for a host that does not pass it.
     */
    function Panel(props) {
      const t = props.t;
      // The View registration's `inject(sessionId)` hands this in; the store lookup
      // stays as a fallback for a host that does not pass it.
      const sessionId = props.sessionId ?? useActiveSessionId(props.sessions);
      const sessionUrl = sessionId === null ? null : '/lcm-insight/session?id=' + encodeURIComponent(sessionId);
      const session = useEndpoint(sessionUrl);
      const app = useEndpoint('/lcm-insight/app');
      // A View tab renders INSIDE the conversation column, which already owns the
      // scroll and the padding: no fixed height, no own scroll container, and no
      // second title bar competing with the tab label.
      return h('div', { className: 'lcmi-view' },
        h(Style),
        h(PanelBody, { t, sessionId, session, app })
      );
    }

    /**
     * The panel's tabs and body: the profile summary first, the session detail second.
     *
     * The profile leads because it is the wider view; a reader who wants one
     * session's history moves to the second tab.
     */
    function PanelBody({ t, sessionId, session, app }) {
      const [tab, setTab] = useState('app');
      const active = tab === 'app' ? app : session;

      const body = (() => {
        if (active.error !== null && active.data === null) {
          return h('div', { className: 'lcmi-msg', 'data-tone': 'error', role: 'alert' }, t('offline') + ' (' + active.error + ')');
        }
        if (active.loading && active.data === null) return h('div', { className: 'lcmi-msg' }, t('loading'));
        if (tab === 'app') {
          if (app.data === null) return h('div', { className: 'lcmi-msg' }, t('loading'));
          return h(AppView, { data: app.data, t });
        }
        if (sessionId === null) return h('div', { className: 'lcmi-msg' }, t('noSession'));
        if (session.data === null) return h('div', { className: 'lcmi-msg' }, t('loading'));
        return h(SessionView, { data: session.data, t });
      })();

      return h(React.Fragment, null,
        h('div', { className: 'lcmi-tabs', role: 'tablist' },
          h('button', {
            className: 'lcmi-tab', role: 'tab', type: 'button',
            'aria-selected': tab === 'app' ? 'true' : 'false',
            onClick: () => setTab('app')
          }, t('app')),
          h('button', {
            className: 'lcmi-tab', role: 'tab', type: 'button',
            'aria-selected': tab === 'session' ? 'true' : 'false',
            onClick: () => setTab('session')
          }, t('session'))
        ),
        body
      );
    }

    /**
     * The Session the panel is describing.
     *
     * `retainedBy.mainView > 0` marks the session the conversation column is
     * holding, which is the one a statistics panel should describe. Subscribed, so
     * opening a different session moves the panel with it.
     * @param sessions - the client `sessions` service.
     * @returns the active session id, or null when none is mounted.
     */
    function useActiveSessionId(sessions) {
      const read = useCallback(() => {
        try {
          const list = sessions?.list?.getSnapshot?.();
          if (list === undefined || list === null) return null;
          const row = Object.values(list.byId ?? {}).find((candidate) => (candidate?.retainedBy?.mainView ?? 0) > 0);
          return typeof row?.id === 'string' ? row.id : null;
        } catch {
          return null;
        }
      }, [sessions]);
      const [id, setId] = useState(read);
      useEffect(() => {
        if (sessions?.list?.subscribe === undefined) return undefined;
        const unsubscribe = sessions.list.subscribe(() => {
          const next = read();
          setId((previous) => (previous === next ? previous : next));
        });
        setId(read());
        return unsubscribe;
      }, [sessions, read]);
      return id;
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        ctx.effect(function* () {
          yield ctx.locale.register(NS, DICT);
          const t = ctx.locale.bind(NS);

          // A View tab beside 轨迹 and 上下文: `conversation.view` is the row that
          // carries those, and its registration receives an `inject(sessionId)`
          // callback, so the tab is handed the session it is showing instead of
          // hunting for it. That is the placement the operator meant by "编队标签页".
          yield ctx.slots.inject(VIEW_SLOT, () => ctx.slots.register(
            {
              name: VIEW_SLOT,
              id: PLUGIN,
              order: 30,
              locale: NS,
              label: () => t('view'),
              inject: (sessionId) => ({ sessionId })
            },
            (props) => h(Panel, { ...props, t })
          ));
        });
      }
    };
  }
});