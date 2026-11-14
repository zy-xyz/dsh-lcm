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
    // The sidebar's panel list is built from `ctx.slots.entriesOfSlot("sidebar.panellist")`
    // (ui-sidebar's `syncPanels`), one row per registration, and selecting a row
    // dispatches `main` by that same id. So a sidebar entry needs BOTH rows, under one
    // id: the entry supplies the label, the panel supplies the body.
    const ENTRY_SLOT = 'sidebar.panellist';
    const PANEL_SLOT = 'main';
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
        live: 'live',
        stale: 'stale',
        graphHint: 'Each box is a checkpoint; a box with several lines into it is a rollup of those checkpoints.',
        depth: 'depth',
        children: 'children',
        close: 'Close',
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
        embeddings: 'Embeddings',
        embedNote: 'Measured against the vector cache: "embedded" means a vector exists for that exact text and model.',
        embedCandidates: 'Corpus',
        embedEmbedded: 'Embedded',
        embedPending: 'Pending',
        embedCache: 'Cached',
        embedMeasured: 'Measured',
        embedCorpus: 'texts the engine can embed',
        embedWork: 'not yet embedded',
        embedMeasuring: 'measuring…',
        embedComplete: 'all recent sessions',
        embedOff: 'The vector layer is off for this profile, so there is nothing to measure.',
        embedCoverage: 'Coverage',
        unreadable: 'unreadable',
        estimated: 'Estimated from checkpoint bodies; spans are engine-recorded.',
        noPressure: 'No session is loaded in this process, so live pressure is unavailable.',
        noSession: 'No session is open. Open one and this window follows it.',
        context: 'Context',
        rawMessages: 'Raw messages',
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
        live: '实时',
        stale: '已断开',
        graphHint: '每个方块是一个检查点；多条线汇入的方块是把它们合并的凝聚节点。',
        depth: '深度',
        children: '子节点',
        close: '关闭',
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
        embeddings: '嵌入',
        embedNote: '对向量缓存实测：只有该文本与模型确实存在向量文件才算「已嵌入」。',
        embedCandidates: '语料',
        embedEmbedded: '已嵌入',
        embedPending: '待嵌入',
        embedCache: '缓存条数',
        embedMeasured: '已测',
        embedCorpus: '引擎可嵌入的文本',
        embedWork: '尚未嵌入',
        embedMeasuring: '测量中…',
        embedComplete: '近期会话已全部测完',
        embedOff: '本配置档未启用向量层，没有可测数据。',
        embedCoverage: '覆盖率',
        unreadable: '个不可读',
        estimated: '正文 token 为估算，跨度为引擎记录。',
        noPressure: '本进程未加载任何会话，实时压力不可用。',
        noSession: '当前没有打开的会话。打开一个，本窗口会自动跟随。',
        context: '上下文',
        rawMessages: '原始消息',
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
    // ── the surface language, learned from dsh-context ──────────────────────
    // Every colour is a HOST TOKEN, never a literal: the panel has to hold up in
    // both themes and across a host reskin. Radius is one scale (8 tiles, 12 cards),
    // shadows come from the host's own elevation tokens, and hairlines are 1px at
    // the border tokens so a card edge is visible on a light canvas without drawing
    // a box on a dark one.
    //
    // Motion follows dsh-context's vocabulary exactly: one ease curve
    // (cubic-bezier(.4,0,.2,1)), short durations (bars .35 s, donuts .45 s), and a
    // STAGGER driven by a --lcmi-i index so a chart draws left to right instead of
    // appearing as a block. Everything is disabled under prefers-reduced-motion —
    // an animated chart is a preference, not a requirement.
    const CSS = `
      .lcmi-view, .lcmi-panel {
        --lcmi-radius-card: 12px;
        --lcmi-radius-tile: 8px;
        --lcmi-ease: cubic-bezier(.4, 0, .2, 1);
        --lcmi-line: 1px solid var(--dsw-alias-border-l2);
        --lcmi-shadow-card: var(--dsw-shadow-lv1, 0 1px 2px rgb(0 0 0 / 8%)), var(--dsw-shadow-lv1-blur, 0 2px 8px rgb(0 0 0 / 6%));
        --lcmi-shadow-hover: var(--dsw-shadow-lv2, 0 4px 16px rgb(0 0 0 / 12%));
        /* A recessed track rather than a flat one: the unfilled arc has to read as a
           container the filled arc sits in, which is how dsh-context draws its donut.
           color-mix keeps it neutral across both themes instead of pinning a grey. */
        --lcmi-track: color-mix(in srgb, var(--dsw-alias-label-secondary) 18%, transparent);
        color: var(--dsw-alias-label-primary);
        font-size: 13px; line-height: 1.45;
        display: flex; flex-direction: column; gap: 14px;
      }
      /* A View tab renders inside the conversation column, which already owns the
         scroll container and the outer padding: no height, no overflow. */
      .lcmi-view { padding: 16px 20px 28px; background: transparent; }
      /* The "main" panel IS the page: it owns the scroll and the height. */
      .lcmi-panel { height: 100%; overflow-y: auto; padding: 18px 20px 28px; background: var(--dsw-alias-bg-base); }

      @keyframes lcmi-bar-in { 0% { transform: scaleY(0); } }
      @keyframes lcmi-donut-in { 0% { stroke-dasharray: 0 100; } }
      @keyframes lcmi-stacked-in { 0% { transform: scaleX(0); } }
      @keyframes lcmi-fade-up { 0% { opacity: 0; transform: translateY(6px); } }
      @keyframes lcmi-pulse { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }

      /* Stagger by position, not by a prop: the views are literal element trees, and
         an index prop would have to be threaded through every call and kept in sync
         with each insertion. */
      .lcmi-grid > :nth-child(1), .lcmi-view > :nth-child(2) { --lcmi-i: 0; }
      .lcmi-grid > :nth-child(2), .lcmi-view > :nth-child(3) { --lcmi-i: 1; }
      .lcmi-grid > :nth-child(3), .lcmi-view > :nth-child(4) { --lcmi-i: 2; }
      .lcmi-grid > :nth-child(4), .lcmi-view > :nth-child(5) { --lcmi-i: 3; }
      .lcmi-grid > :nth-child(5), .lcmi-view > :nth-child(6) { --lcmi-i: 4; }
      .lcmi-grid > :nth-child(6), .lcmi-view > :nth-child(7) { --lcmi-i: 5; }
      .lcmi-anim-bar { animation: lcmi-bar-in .35s var(--lcmi-ease) calc(var(--lcmi-i, 0) * 15ms) both; transform-origin: bottom; }
      .lcmi-anim-donut { animation: lcmi-donut-in .45s var(--lcmi-ease) both; }
      .lcmi-anim-stacked { animation: lcmi-stacked-in .4s var(--lcmi-ease) calc(var(--lcmi-i, 0) * 30ms) both; transform-origin: left; }
      .lcmi-anim-fade { animation: lcmi-fade-up .35s var(--lcmi-ease) calc(var(--lcmi-i, 0) * 35ms) both; }
      .lcmi-anim-pulse { animation: lcmi-pulse 1.8s ease-in-out infinite; }
      @media (prefers-reduced-motion: reduce) {
        .lcmi-anim-bar, .lcmi-anim-donut, .lcmi-anim-stacked, .lcmi-anim-fade, .lcmi-anim-pulse {
          animation: none !important;
        }
      }
      .lcmi-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
      .lcmi-head h2 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
      .lcmi-head .lcmi-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; }
      /* A live dot, not decoration: the panel re-reads every 5 s, and a readout with
         no freshness signal is indistinguishable from a frozen one. It pulses while
         the last poll succeeded and goes flat the moment one fails. */
      .lcmi-live { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .lcmi-live i {
        width: 6px; height: 6px; border-radius: 50%; display: block;
        background: var(--dsw-alias-brand-primary);
      }
      .lcmi-live[data-stale='true'] i { background: var(--dsw-alias-state-error-primary); animation: none; }
      .lcmi-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .lcmi-tab {
        appearance: none; background: none; border: 0; cursor: pointer;
        padding: 7px 12px; min-height: 34px; font: inherit; font-size: 12px;
        color: var(--dsw-alias-label-secondary);
        border-bottom: 2px solid transparent; margin-bottom: -1px;
      }
      .lcmi-tab[aria-selected='true'] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); }
      .lcmi-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .lcmi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
      .lcmi-stat {
        border: var(--lcmi-line); border-radius: var(--lcmi-radius-tile);
        background: var(--dsw-alias-bg-layer-2); padding: 7px 9px;
        display: flex; flex-direction: column; gap: 2px; min-width: 0;
        box-shadow: var(--lcmi-shadow-tile, none);
        transition: box-shadow var(--ds-transition-duration, .2s) var(--lcmi-ease);
      }
      .lcmi-stat:hover { box-shadow: var(--lcmi-shadow-hover); }
      .lcmi-stat .k {
        color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 600;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .lcmi-stat .v { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; line-height: 1.2; }
      .lcmi-stat .n { color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .lcmi-card {
        border: var(--lcmi-line); border-radius: var(--lcmi-radius-card);
        background: var(--dsw-alias-bg-layer-1); padding: 8px 10px;
        box-shadow: var(--lcmi-shadow-card);
      }
      .lcmi-card > h3 {
        margin: 0 0 9px; padding-bottom: 7px;
        border-bottom: var(--lcmi-line);
        font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary);
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      }
      .lcmi-note { color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .lcmi-msg { padding: 28px 4px; color: var(--dsw-alias-label-secondary); font-size: 13px; }
      .lcmi-msg[data-tone='error'] { color: var(--dsw-alias-state-error-primary); }
      .lcmi-legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 8px; }
      .lcmi-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
      .lcmi-bars { display: flex; flex-direction: column; gap: 6px; }
      .lcmi-bar-row { display: grid; grid-template-columns: 74px 1fr 54px; align-items: center; gap: 8px; font-size: 12px; }
      .lcmi-bar-row .l { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
      .lcmi-bar-row .n { text-align: right; font-variant-numeric: tabular-nums; }
      /* The track is the host's recessive layer, the fill is the series colour: a
         bare fill on the card background reads as a floating line, not as a bar. */
      .lcmi-bar { background: var(--dsw-alias-bg-layer-2); border-radius: 3px; overflow: hidden; }
      .lcmi-bar > i { transition: width .4s var(--lcmi-ease); }
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
      .lcmi-table tbody tr { transition: background-color var(--ds-transition-duration, .2s) var(--lcmi-ease); }
      .lcmi-table tbody tr:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }

      /* ── embedding coverage bar ─────────────────────────────────────────── */
      .lcmi-embedbar {
        height: 10px; border-radius: 3px; overflow: hidden;
        background: var(--dsw-alias-bg-layer-2);
        border: var(--lcmi-line);
      }
      .lcmi-embedbar-fill {
        height: 100%; background: var(--lcmi-series-1, #3fa89b);
        transition: width .4s var(--lcmi-ease);
      }
      /* ── the node graph ─────────────────────────────────────────────────── */
      .lcmi-graph-wrap { display: flex; flex-direction: column; gap: 8px; }
      /* The graph scrolls inside its own box: a 59-checkpoint DAG is taller and wider
         than any panel, and shrinking it to fit would make the labels unreadable.
         The scroll happens on this DIV — an "svg" with overflow does not scroll its
         own content. */
      .lcmi-graph-scroll {
        max-height: 320px; overflow: auto;
        border: var(--lcmi-line); border-radius: var(--lcmi-radius-tile);
        background: var(--dsw-alias-bg-base);
      }
      .lcmi-graph { display: block; }
      .lcmi-gedge {
        fill: none;
        stroke: color-mix(in srgb, var(--dsw-alias-label-secondary) 45%, transparent);
        stroke-width: 1.25;
        transition: stroke .2s var(--lcmi-ease), stroke-width .2s var(--lcmi-ease);
      }
      .lcmi-gedge[data-active='true'] { stroke: var(--dsw-alias-brand-primary); stroke-width: 2; }
      .lcmi-gnode { cursor: pointer; }
      .lcmi-gnode:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .lcmi-gnode-box {
        fill: var(--dsw-alias-bg-layer-1);
        stroke: var(--dsw-alias-border-l2);
        stroke-width: 1;
        transition: fill .2s var(--lcmi-ease), stroke .2s var(--lcmi-ease);
      }
      .lcmi-gnode:hover .lcmi-gnode-box { stroke: var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); }
      .lcmi-gnode.is-selected .lcmi-gnode-box { stroke: var(--dsw-alias-brand-primary); stroke-width: 1.75; }
      .lcmi-gnode-box[data-fallback='true'] { stroke: var(--dsw-alias-state-error-primary); stroke-dasharray: 3 2; }
      .lcmi-gnode-seq { fill: var(--dsw-alias-label-primary); font-size: 10px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .lcmi-gnode-meta { fill: var(--dsw-alias-label-secondary); font-size: 9px; font-variant-numeric: tabular-nums; }
      .lcmi-gnode-track { fill: var(--dsw-alias-bg-layer-2); }
      .lcmi-gnode-fill { fill: var(--dsw-alias-brand-primary); opacity: .75; }
      .lcmi-gdetail {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        border: var(--lcmi-line); border-radius: var(--lcmi-radius-tile);
        background: var(--dsw-alias-bg-layer-2); padding: 6px 8px 6px 10px;
      }
      .lcmi-gdetail-row { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
      .lcmi-gdetail-row b { color: var(--dsw-alias-label-primary); }
      .lcmi-gdetail-warn { color: var(--dsw-alias-state-error-primary); }
      .lcmi-close {
        appearance: none; border: 0; background: none; cursor: pointer;
        color: var(--dsw-alias-label-secondary); font: inherit; font-size: 15px; line-height: 1;
        width: 22px; height: 22px; border-radius: 4px;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .lcmi-close:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); }
      .lcmi-close:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
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
            // `--lcmi-i` staggers the draw left to right: 15 ms per bar is fast
            // enough to feel like one motion and slow enough to see direction.
            return h('rect', {
              key: d.label + i,
              className: 'lcmi-anim-bar',
              style: { '--lcmi-i': i },
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
          h('span', { className: 'lcmi-bar' }, h('i', {
            className: 'lcmi-anim-stacked',
            style: { '--lcmi-i': i, width: (100 * d.value) / max + '%', background: d.color ?? color }
          })),
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
          h('circle', { cx: 50, cy: 50, r, fill: 'none', stroke: 'var(--lcmi-track)', strokeWidth: 13 }),
          h('circle', {
            className: 'lcmi-anim-donut',
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
      return h('div', { className: 'lcmi-stat lcmi-anim-fade' },
        h('div', { className: 'k' }, label),
        h('div', { className: 'v' }, value),
        note === undefined ? null : h('div', { className: 'n' }, note)
      );
    }

    function Card({ title, children, note }) {
      return h('div', { className: 'lcmi-card lcmi-anim-fade' },
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

    // ── embeddings ─────────────────────────────────────────────────────────

    /**
     * Embedding coverage, per session and in total.
     *
     * The numbers are MEASURED, never inferred: the host walks each session's corpus
     * with the engine's own collector and checks every candidate's cache digest, so
     * "embedded" means a vector file exists for that exact text and model. A gap is
     * work not done — the cache cannot tell "never attempted" from "attempted and
     * failed", because a failure writes nothing — so the panel reports it as pending
     * rather than as a success rate it cannot compute.
     */
    function EmbeddingPanel({ data, t }) {
      const embedding = data.embedding;
      const cache = data.vectors ?? [];
      const bytes = cache.reduce((total, family) => total + family.bytes, 0);
      const entries = cache.reduce((total, family) => total + family.entries, 0);

      if (embedding === undefined || embedding.enabled === false) {
        return h('div', { className: 'lcmi-note' }, t('embedOff'));
      }

      const share = embedding.candidates === 0 ? null : embedding.embedded / embedding.candidates;
      const rows = data.perSession
        .filter((row) => row.embedCandidates !== null && row.embedCandidates > 0)
        .sort((a, b) => (a.embedCoverage ?? 0) - (b.embedCoverage ?? 0))
        .slice(0, 10);

      return h(React.Fragment, null,
        h('div', { className: 'lcmi-grid' },
          h(Stat, { label: t('embedCandidates'), value: tok(embedding.candidates), note: t('embedCorpus') }),
          h(Stat, { label: t('embedEmbedded'), value: tok(embedding.embedded), note: share === null ? '—' : pct(share) }),
          h(Stat, { label: t('embedPending'), value: tok(embedding.pending), note: t('embedWork') }),
          h(Stat, { label: t('embedCache'), value: tok(entries), note: (bytes / 1048576).toFixed(1) + ' MB' }),
          h(Stat, {
            label: t('embedMeasured'),
            value: embedding.measured + '/' + embedding.total,
            note: embedding.measured < embedding.total ? t('embedMeasuring') : t('embedComplete')
          })
        ),
        h('div', { className: 'lcmi-embedbar', title: pct(share) },
          h('div', { className: 'lcmi-embedbar-fill lcmi-anim-stacked', style: { width: (share ?? 0) * 100 + '%' } })
        ),
        h('div', { className: 'lcmi-legend' },
          h('span', null, h('i', { style: { background: SERIES[1] } }), t('embedEmbedded') + ' ' + tok(embedding.embedded)),
          h('span', null, h('i', { style: { background: 'var(--dsw-alias-bg-layer-2)' } }), t('embedPending') + ' ' + tok(embedding.pending)),
          h('span', { className: 'lcmi-mono' }, embedding.model + ' · ' + embedding.dim + 'd')
        ),
        rows.length === 0
          ? null
          : h('table', { className: 'lcmi-table', style: { marginTop: '8px' } },
              h('thead', null, h('tr', null,
                h('th', null, t('colSession')),
                h('th', { className: 'num' }, t('embedCandidates')),
                h('th', { className: 'num' }, t('embedEmbedded')),
                h('th', { className: 'num' }, t('embedCoverage'))
              )),
              h('tbody', null, rows.map((row) => h('tr', { key: row.id },
                h('td', { className: 'lcmi-mono' }, row.id.replace(/^session-/u, '').slice(0, 10)),
                h('td', { className: 'num' }, tok(row.embedCandidates)),
                h('td', { className: 'num' }, tok(row.embedEmbedded)),
                h('td', { className: 'num' }, row.embedCoverage === null ? '—' : pct(row.embedCoverage))
              )))
            )
      );
    }

    // ── the node graph ─────────────────────────────────────────────────────
    //
    // A NODE-LINK DIAGRAM, not an indented list. The checkpoint DAG is a graph: one
    // condensation absorbs up to `fanin` siblings, so a linear list hides the very
    // thing worth seeing — how many leaves each rollup swallowed and how deep the
    // chain runs. Nodes are laid out by depth on X and by leaf order on Y, edges are
    // drawn as curves so a merge reads as a merge.

    /** Node box geometry, in viewBox units. */
    const NODE = { w: 118, h: 26, gapX: 46, gapY: 10, padX: 8, padY: 8, r: 5 };

    /**
     * Lay a tree out: depth on X, leaf order on Y.
     *
     * A row is assigned only to LEAVES; a parent is centred on its children, which is
     * what makes a merge visually obvious. Doing it the other way (a row per node)
     * would leave gaps wherever a parent has several children.
     * @param roots - tree roots from the session report.
     * @returns `{ nodes, edges, width, height, rows }`.
     */
    function layoutGraph(roots) {
      const nodes = [];
      const edges = [];
      let row = 0;

      const place = (node, depth) => {
        const children = node.children ?? [];
        const childRows = [];
        for (const child of children) childRows.push(place(child, depth + 1));
        const y = childRows.length === 0
          ? row++
          : (childRows[0] + childRows[childRows.length - 1]) / 2;
        const placed = { ...node, depth, row: y };
        nodes.push(placed);
        for (const child of children) {
          edges.push({ from: placed, to: nodes.find((candidate) => candidate.seq === child.seq) });
        }
        return y;
      };

      for (const root of roots) place(root, 0);

      const maxDepth = nodes.reduce((max, node) => Math.max(max, node.depth), 0);
      const width = (maxDepth + 1) * (NODE.w + NODE.gapX) - NODE.gapX + NODE.padX * 2;
      const height = Math.max(1, row) * (NODE.h + NODE.gapY) - NODE.gapY + NODE.padY * 2;
      return { nodes, edges, width, height, rows: row };
    }

    /**
     * One checkpoint node.
     *
     * The bar inside the box is the compression of that node — span on the track, kept
     * on the fill — so a rollup that barely shrank anything is visible without
     * reading the numbers.
     */
    function GraphNode({ node, x, y, selected, onSelect, t }) {
      const saved = Math.max(0, node.span - node.kept);
      const ratio = node.kept === 0 ? 1 : Math.min(1, node.kept / Math.max(1, node.span));
      return h('g', {
        transform: 'translate(' + x + ',' + y + ')',
        className: 'lcmi-gnode' + (selected ? ' is-selected' : ''),
        role: 'button',
        tabIndex: 0,
        'aria-label': 'seq ' + node.seq + ', ' + t('depth') + ' ' + node.depth,
        onClick: () => onSelect(node.seq),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(node.seq);
          }
        }
      },
        h('rect', {
          className: 'lcmi-gnode-box',
          width: NODE.w, height: NODE.h, rx: NODE.r, ry: NODE.r,
          'data-fallback': node.fallback ? 'true' : 'false'
        }),
        h('text', { className: 'lcmi-gnode-seq', x: 7, y: 11 }, 'seq ' + node.seq),
        h('text', { className: 'lcmi-gnode-meta', x: NODE.w - 7, y: 11, textAnchor: 'end' },
          'd' + node.depth + ' · ' + tok(saved)),
        h('rect', { className: 'lcmi-gnode-track', x: 7, y: 16, width: NODE.w - 14, height: 3, rx: 1.5 }),
        h('rect', {
          className: 'lcmi-gnode-fill', x: 7, y: 16, width: (NODE.w - 14) * ratio, height: 3, rx: 1.5
        })
      );
    }

    /**
     * The context DAG.
     *
     * Scrolls in both axes rather than shrinking to fit: a 59-checkpoint session is
     * wider than the panel, and scaling it down would make the labels unreadable — the
     * one thing a node graph is for.
     */
    function ContextGraph({ data, t }) {
      const report = data.report;
      const roots = report.tree?.roots ?? [];
      const [selected, setSelected] = useState(null);
      const layout = useMemo(() => layoutGraph(roots), [roots]);

      if (roots.length === 0) {
        return h('div', { className: 'lcmi-note' }, t('emptySession'));
      }

      const xOf = (depth) => NODE.padX + depth * (NODE.w + NODE.gapX);
      const yOf = (row) => NODE.padY + row * (NODE.h + NODE.gapY);

      return h('div', { className: 'lcmi-graph-wrap' },
        // The scroll container is this DIV, not the `svg`: an SVG element with
        // `overflow: auto` does not scroll its own content, it clips it.
        h('div', { className: 'lcmi-graph-scroll' },
        h('svg', {
          className: 'lcmi-graph',
          viewBox: '0 0 ' + layout.width + ' ' + layout.height,
          width: layout.width,
          height: layout.height,
          role: 'img',
          'aria-label': t('context')
        },
          h('g', { className: 'lcmi-gedges' },
            layout.edges.map((edge, index) => {
              const x1 = xOf(edge.from.depth) + NODE.w;
              const y1 = yOf(edge.from.row) + NODE.h / 2;
              const x2 = xOf(edge.to.depth);
              const y2 = yOf(edge.to.row) + NODE.h / 2;
              const mid = (x1 + x2) / 2;
              return h('path', {
                key: 'e' + index,
                className: 'lcmi-gedge',
                'data-active': selected === edge.from.seq || selected === edge.to.seq ? 'true' : 'false',
                d: 'M' + x1 + ',' + y1 + ' C' + mid + ',' + y1 + ' ' + mid + ',' + y2 + ' ' + x2 + ',' + y2
              });
            })
          ),
          h('g', { className: 'lcmi-gnodes' },
            layout.nodes.map((node) => h(GraphNode, {
              key: node.seq,
              node,
              x: xOf(node.depth),
              y: yOf(node.row),
              selected: selected === node.seq,
              onSelect: (seq) => setSelected((prev) => (prev === seq ? null : seq)),
              t
            }))
          )
        )
        ),
        selected === null
          ? null
          : h(GraphDetail, {
              node: layout.nodes.find((candidate) => candidate.seq === selected),
              t,
              onClose: () => setSelected(null)
            })
      );
    }

    /** The selected node's numbers, because a box has no room for them. */
    function GraphDetail({ node, t, onClose }) {
      if (node === undefined) return null;
      return h('div', { className: 'lcmi-gdetail' },
        h('div', { className: 'lcmi-gdetail-row' },
          h('b', null, 'seq ' + node.seq),
          h('span', null, t('depth') + ' ' + node.depth),
          h('span', null, tok(node.span) + ' → ' + tok(node.kept)),
          h('span', null, t('rawMessages') + ' ' + node.rawMessages),
          h('span', null, node.children.length + ' ' + t('children')),
          node.fallback ? h('span', { className: 'lcmi-gdetail-warn' }, t('fallback')) : null
        ),
        h('button', { type: 'button', className: 'lcmi-close', onClick: onClose, 'aria-label': t('close') }, '×')
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
        h(Card, { title: t('context'), note: t('graphHint') }, h(ContextGraph, { data, t })),
        data.embedding === null || data.embedding === undefined
          ? null
          : h(Card, { title: t('embeddings'), note: t('embedNote') },
              h('div', { className: 'lcmi-grid' },
                h(Stat, { label: t('embedCandidates'), value: tok(data.embedding.candidates) }),
                h(Stat, { label: t('embedEmbedded'), value: tok(data.embedding.embedded) }),
                h(Stat, { label: t('embedPending'), value: tok(data.embedding.pending) }),
                h(Stat, {
                  label: t('embedCoverage'),
                  value: data.embedding.coverage === null ? '—' : pct(data.embedding.coverage)
                })
              ),
              h('div', { className: 'lcmi-embedbar', title: pct(data.embedding.coverage) },
                h('div', {
                  className: 'lcmi-embedbar-fill lcmi-anim-stacked',
                  style: { width: (data.embedding.coverage ?? 0) * 100 + '%' }
                })
              ),
              h('div', { className: 'lcmi-legend' },
                h('span', { className: 'lcmi-mono' }, data.vectorModel + ' · ' + data.vectorDim + 'd')
              )
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
        h(Card, { title: t('embeddings'), note: t('embedNote') }, h(EmbeddingPanel, { data, t })),
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
     * The sidebar entry's glyph.
     *
     * `sidebar.panellist` renders this in a fixed-size box with `{ size, active }`, so
     * the icon must be pure SVG on `currentColor` and must not bring its own label:
     * the sidebar draws the label beside it when the column is wide.
     */
    function SidebarGlyph(props) {
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
      // Two containers render this: the View tab (inside the conversation column,
      // which owns the scroll) and the `main` panel behind the sidebar entry (its own
      // full-height page). `variant` picks the root class; the body is identical.
      const variant = props.variant ?? 'view';
      // The View registration's `inject(sessionId)` hands this in; the store lookup
      // stays as a fallback for a host that does not pass it.
      const sessionId = props.sessionId ?? useActiveSessionId(props.sessions);
      const sessionUrl = sessionId === null ? null : '/lcm-insight/session?id=' + encodeURIComponent(sessionId);
      const session = useEndpoint(sessionUrl);
      const app = useEndpoint('/lcm-insight/app');
      // A View tab renders INSIDE the conversation column, which already owns the
      // scroll and the padding: no fixed height and no second title bar competing
      // with the tab label. A `main` panel is the whole page, so it gets the height
      // and the heading back.
      if (variant === 'panel') {
        const stale = app.error !== null && app.data !== null;
        return h('div', { className: 'lcmi-panel' },
          h(Style),
          h('div', { className: 'lcmi-head' },
            h('h2', null, t('title')),
            h('span', { className: 'lcmi-sub' }, t('description')),
            h('span', { className: 'lcmi-live', 'data-stale': stale ? 'true' : 'false' },
              h('i', { className: 'lcmi-anim-pulse', 'aria-hidden': true }),
              t(stale ? 'stale' : 'live')
            )
          ),
          h(PanelBody, { t, sessionId, session, app })
        );
      }
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
            (props) => h(Panel, { ...props, t, variant: 'view' })
          ));

          // The sidebar entry and its panel. ui-sidebar's `syncPanels` reads
          // `entriesOfSlot("sidebar.panellist")` and needs `id`, `order` and `label`;
          // selecting the row then dispatches `main` by that same `id`. Two rows, one
          // id — an entry alone opens nothing and a panel alone has no row.
          yield ctx.slots.inject(ENTRY_SLOT, () => ctx.slots.register(
            { name: ENTRY_SLOT, id: PLUGIN, order: 30, label: () => t('view'), locale: NS },
            SidebarGlyph
          ));

          yield ctx.slots.inject(PANEL_SLOT, () => ctx.slots.register(
            { name: PANEL_SLOT, key: PLUGIN, locale: NS },
            (props) => h(Panel, { ...props, t, variant: 'panel', sessions: ctx.sessions })
          ));
        });
      }
    };
  }
});