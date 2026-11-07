# A/B 报告 v3 — 结论：不换

> 2026-11-07 第三版。v1 被审计推翻；v2 撤回并重做仪器；v3 给出重测数据与裁决。

## 0. 裁决

**不切换默认引擎。** 现有证据既不支持"lcm 的摘要更好"，也不支持"引擎有增益"——
两个语料上的方向相反，而唯一的 basicplus 数据点（只给 basic 加那一段锚点指令）
反而最高。**收益（如果有）跟的是那段 prompt 指令，不是引擎。**

## 1. 撤回记录（v1 的错误，全部作废）

| v1 说法 | 实际 |
|---|---|
| 24 条 canary 覆盖六类 | 实际 100% 是路径；uuid/hex/ENV/error 被正则模式序挤掉 |
| 随机抽样 | `step=floor(38/24)=1`，等于取前 24 条，确定性 |
| canary 可比 | 锚点嵌套，9 条字面量即可打满 24/24 |
| 同样成本 | 95% CI = −40.5%…+44.4%（Welch p≈0.90） |
| 0.98× fewer | 符号反了，实际 1.019× |
| 「换引擎」 | 两臂都是裸 prompt 调用，没跑任何引擎代码 |

这些全部写在 v2，本版不再重复论证。

## 2. 修好的仪器

`bench/anchors.mjs`：去嵌套（只留极大元素）→ 按类型分层（单类 ≤35%）→ 按事实去重。
原来 span.mjs 的抽取已换成它，`canaryPool` / `droppedNested` / `canaryTypes` 一并落盘。

## 3. 重测数据（唯一可采信的那批）

### 语料 c2（真实压缩跨度，8 065 tok，24 锚点：path4 env5 error5 hex4 command3 uuid3）

| 臂 | n | 锚点保真 | completion token |
|---|---|---|---|
| basic | 4 | 38.5%（8 9 10 10 /24） | 5 741 |
| **lcm** | 4 | **51.0%**（11 13 11 14 /24） | **7 912（+38%）** |
| basicplus | 4 | **全部超时，0 条数据** | — |

### 语料 s（小跨度，4 302 tok，14 锚点，为了让 basicplus 能跑完而缩小）

| 臂 | n | 锚点保真 | completion token |
|---|---|---|---|
| basic | 2 | 35.7%（7 3 /14） | 3 203 |
| lcm | 2 | 32.1%（4 5 /14） | 3 514 |
| **basicplus** | 1 | **50.0%（7/14）** | 7 332 |

### 跨语料汇总

| 臂 | 语料均值的均值 | 说明 |
|---|---|---|
| basic | 37.1% | 两语料稳定在 35–39% |
| lcm | 41.6% | 全靠 c2 拉起来，s 上是负的 |
| basicplus | 50.0% | 只有 n=1，但方向值得记下 |

## 4. 读这几张表要抓住的四件事

1. **方向不稳定。** c2 上 lcm +12.5pp，s 上 lcm −3.6pp。n=4/n=2 的样本撑不起"更好"。
2. **lcm 不是免费的。** c2 上它多写了 38% 的输出 token（7 912 vs 5 741）——枚举锚点本身就贵。
3. **basicplus 是唯一的归因线索，而现在它最高。** 如果这条成立，那增益来自"强制枚举"这段指令，任何 backend 加上都该有——与引擎无关。
4. **basicplus 在大语料上跑不完。** 强制枚举会把输出拉到 7–10k token，超过 MCP 工具 60s 上限；缩到 4.3k 语料才跑得通。这本身就是一条产品结论：**枚举策略的代价是输出长度，不是免费午餐。**

## 5. 所以按你的第 4 条要求：不换

"实测效果得比原版好才换" —— 现在没有一份能站住的对照数据说 lcm 更好。
**保持 basic 为默认引擎，插件留在仓库里作为可选 backend。**

真正能支撑"换"的实验还没做：用真实 `compile()` 跑 787 节点 / 436k tok 的生产跨度，
压缩后继续原任务，记完成步数与重读次数。那才是引擎级指标，而本报告全部是 prompt 级指标。

## 6. 复现

```bash
node bench/span.mjs <session.v4.jsonl.zstd> [--max-tokens 8000|--last 120|--range A-B] > span.json
# 三臂 prompt：basic / basic+锚点节 / buildInstruction()
# 同模型、temperature 0、各跑 N 次，按 anchors.js 的集合打分
```

原始行数据：`/tmp/ablate.jsonl`（c2）与 `/tmp/ablate2.jsonl`（s）—— 已随本次提交固化到
`bench/results/ablation-20261107.json`。
## 7. 引擎级实测（唯一能支撑"换"的那类证据）

前面全部是 prompt 级指标。这一节是真的跑代码、真的对真实生产日志量的。

用 `bench/recovery.mjs` + 仓库里真实发货的 `src/recall.js`，对 `d45c83f5` 的**真实生产压缩跨度**：

| 指标 | 值 |
|---|---|
| 跨度 | **787 节点 / 436 194 token** |
| 生产摘要实际携带的锚点 | **3 / 24（12.5%）** |
| 通过 recall 找回的锚点 | **21 / 21** |
| **模型可获得的锚点合计** | **24 / 24（100%）** |
| 彻底丢失 | **0** |

复现：

```bash
node bench/recovery.mjs <session.v4.jsonl.zstd>
```

### 为什么这条比前面的 prompt 对比重要

436k token 的跨度上，**任何摘要都装不下全部锚点** —— 生产摘要只留下 12.5%。
这不是模型不够好，是摘要本身的容量天花板。

- **摘要型 backend**：checkpoint 里有多少就是多少，12.5% 之后剩下的没了（模型侧没有指针）
- **本 backend**：checkpoint 里同样只有一部分，但每个 checkpoint 都带 `seq` 指针和
  RECALL 指南，`lcm_expand` 能把原文逐字取回 → 100%

**这才是架构差异，且不依赖任何 prompt 技巧。**

### 与此同时发现的真 bug

写这个测量时发现 `recall.js` 用 `session.events[seq]` 直接下标。持久化日志的**第一条是
没有 `seq` 的 header 记录**，于是每个 seq 都错位一格，每次 recall 都返回
`[seq N: not found in this session]`。

修复：新增 `src/events.js` 的 `resolveEventAt()`，优先用 session 自己的
`eventAt`，否则按事件自身的 `seq` 建索引（缓存）。`recall.js` / `search.js` 全部改用它。

回归测试在 `test/recovery.test.js`，其中包括一条**防空过**断言：若 recall 走了
raw-JSON fallback，子串永远能命中，测试就失去意义 —— 所以强制要求走 projection。

### 诚实的边界

basic 在大跨度上不是"0"：dsh 有 `session_search` 系列工具，模型**如果自己想起来去搜**
也能找回。差别在于：

- 本 backend 的 checkpoint **主动告诉模型怎么找**（RECALL 指南 + 每个条目的 `seq`）
- basic 的 checkpoint **什么也不说**，找回全靠模型自己想到

所以准确的表述是「**可发现的可恢复性** 12.5% → 100%」，而不是「basic 完全找不回」。
