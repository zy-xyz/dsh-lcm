# 给 dsh 装 LCM：裁决与实施设计

> 生成：2026-11-07 ｜ 依据：lcm-x@64f8b18 源码、dsh 0.2.2-rc.1 契约、dsh-compaction-instant@0.1.4、LCM 论文(Ehrlich & Blackman 2026-02)

## 0. 裁决

**不移植 lcm-x，按论文语义在 dsh 原生契约上重写，90% 复用现成件。**

- 移植：1 251 个 py / compaction.py 3 820 行 / engine.py 12 179 行 / CompactionMixin 63 方法；且 40/63 个方法在 dsh 上作废（ingest 保护、reconcile、lifecycle 冲突检测、ledger 审计 —— dsh 的 append-only session log 已经替它做了）。
- 重写：真正缺的只有 3 件事 —— ① depth>1 的持久层级 ② 大 payload 外置为指针 ③ 沿 DAG 展开的检索。
- ③ 已被 dsh-session-query(FTS5) + dsh-tool-session-query 覆盖一半；先例 dsh-compaction-instant 已把 ② 的指针形态、alias 安装、schema 注入坑全踩平。

## 1. 契约事实（已核实）

| 项 | 事实 | 证据 |
|---|---|---|
| seam | `ctx.compaction` = CompactionEngine 抽象类 | dsh-compaction/lib/types/index.d.ts:116,137,157 |
| 语义 | compactRegion 把 surface 一段**替换成 1 条摘要**，原文留 log 变 shadowed | 同上 + types.d.ts:116-126 |
| 唯一性 | 一个 context 只能挂一份实现 | index.d.ts:99-100 |
| 安装 | preset 硬编码 `@deepseek-ai/dsh-compaction-basic`，patch 层按 id 命不中嵌套行 → 只能 npm alias | dsh-web-app/presets/standard.patch.yml:76-77 |
| 硬闸 | framedSummaryTokenCount >= shadowedRouteTokenCount 直接抛 | compaction-basic/lib/index.js:600-601 |
| 位置语义 | shadowedRange 是 surface **位置**，start 可 > end | types.d.ts:116-126 |
| DAG 载体 | checkpoint 事件已带 summary/shadowedSeqs/shadowedTokenCount → **可从日志派生，不需要 SQLite 真相** | types.d.ts:35-57 |
| 反例 | appendPluginRecord 仅限 packages/experimental/ 且迁移会 best-effort 丢弃 → **不能承载 DAG** | dsh-session/lib/types/index.d.ts:104-108 |

## 2. 三层复用

```
第 3 层（自写，唯一必须发明的）  depth>1 多级凝聚 DAG + 大 payload 外置
第 2 层（自写，~400 行）          LcmCompactionEngine extends CompactionEngine
第 1 层（直接装）                 dsh-compaction-instant（编译器/指针/recall/search 现成）
第 0 层（白送）                   append-only session log + dsh-session-query(FTS5)
```

## 3. 里程碑

### M1（今天，0.5–1 天）零 LLM 先行
```bash
dsh plugin --profile web add dsh-compaction-instant
# 若 preset 未生效，用别名覆盖：
# npm i "@deepseek-ai/dsh-compaction-basic@npm:dsh-compaction-instant" --prefix ~/.dsh/profiles/web
```
通过判据（三条全中）：
1. 一次压缩后日志 `surfaceOp.replace` 增加且 `compaction/start` ≥ 1
2. `recall(seq N)` 返回文本与被 shadow 的 seq N 原文 sha256 一致
3. `search` 命中只存在于被 shadow 区间的关键词（证明读全量日志而非 surface）

### M2（2–4 天）LLM 叶摘要引擎 v0
- 继承 CompactionEngine，实现 compactIfNeeded/compactNow/compactRegion
- Config **必须吃掉 basic 全部 11 个键**（thresholdRatio/headroomTokens/retainRatio/retainTokens/summarizationProvider/summarizationModel/maxTokens/compactionRetries/maxOverflowRetries/modelPolicies/auto），漏一个预设加载即崩
- 提交前自检 `framedSummaryTokenCount < shadowedRouteTokenCount`，不过就降级更短渲染，不许抛错丢锁
- 通过判据：200K 会话压缩后 token 总量降 ≥50%；compaction/start:end 配对率 ≥90%；压缩后连问 3 轮能报出压缩前的文件名/命令/错误串

### M3（1–2 周）多级凝聚
- fanin=4，depth≤3，condense 预算 = max(1000, 0.40×Σchild)
- 节点/边从日志派生：节点 = isCompactCheckpointSource 的 user/message；边 = sourceEventSeqs 中的 checkpoint seq
- 通过判据：连续 5 次压缩后 checkpoint 不再包含已被 D1 吸收的原文；重启后 DAG 可从日志重建

## 4. 七个坑（按致命度）

| # | 坑 | 处置 |
|---|---|---|
| R1 | preset 嵌套行 patch 命不中 | 只能 npm alias 安装 |
| R2 | 任何 `dsh plugin add` 触发的 pnpm install 可能**静默回退到官方 basic** | 生产化前加自检 `require.resolve('@deepseek-ai/dsh-compaction-basic/package.json')` |
| R3 | billion-context 的 gate 会**递归 disable 所有叫 compaction-basic / command-compact 的行**，一开就同时干掉你的引擎和 /compact 且不报错 | 确认 `bili-compaction-gate: disabled: true` 常驻；启用前先改 gate 匹配规则 |
| R5 | 单条 checkpoint 装不下「叶摘要+指针+新鲜尾部」→ 缩水闸反复抛 → 静默降级成不压缩 | M2 判据 5 就是测它；装不下就退回 instant |
| R4 | pre-step 里 await LLM 秒级延迟 | 大叶子走后台 sweep，热路径只做确定性编译 |
| R6 | 位置区间非单调（start 可 > end），用数值区间建模会在第二次压缩后静默错位 | 一律用 shadowedSeqs（surface 顺序） |
| R7 | 0.2.2-rc.1 是 RC，契约一变每版跟改 | 记账，0.5–1 天/版 |

## 5. 建议目录

```
dsh-lcm/
├─ package.json            # 5 个 subpath 入口 + alias 说明
├─ cordis.patch.yml        # 自身 layer
└─ src/
   ├─ index.ts             # 引擎 row（inject: llm/tokenMeter/sessions）
   ├─ engine/{engine,policy,select,commit,condense,invariant}.ts
   ├─ store/{service,dag-view,index-cache,payload}.ts
   ├─ externalize.ts       # messageProjection 行（照 compaction-image-offload 形态）
   ├─ tool.ts              # lcm_expand：sessionQuery 做不到的「沿 DAG 展开」
   ├─ command.ts           # /lcm
   └─ compiler/{tokens,render}.ts
```

## 6. 一句话

先花半天装 instant 跑 M1 三条判据；只有实测证明「指针化 checkpoint 在 200K+ 会话里真让模型丢事实」，才投 M2 的 LLM 叶摘要；多级凝聚等 M2 数据说话。
