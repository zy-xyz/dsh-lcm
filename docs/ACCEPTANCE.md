# dsh LCM 压缩引擎 · 验收标准

> v1 · 2026-11-07 · 配套探针：`verify-lcm.mjs` · 设计依据：dsh-compaction 契约（0.2.2-rc.1）、lcm-x 行为语义、LCM 论文


## 0. 当前状态（2026-11-07）

引擎代码在 [`dsh-lcm/`](dsh-lcm) v0.4.2（https://github.com/zy-xyz/dsh-lcm ），80 项测试全绿。

> ⚠️ 本表 2026-11-07 有一次**口径修正**：`bench/retrieval.mjs` 的 rank 曾多加 2，导致 recall@1 恒为 0、NDCG 抄的是 recall@10，据此得出的“相关性重排不如时间序”结论**作废并反向**。凡引用本表旧数字的地方，以 REPORT.md §1 撤回记录为准。

**裁决（2026-11-07 晚，口径修正后）：保真这一门已经过了，可以切换。**

先前判「不装载」的依据是「摘要质量不达标」。那条依据**建立在错误仪器上**：它数的是锚点在摘要文本里的出现次数，且问法带 `near "<片段>"` 定位（摘要缺定位串时模型答 UNKNOWN，即使答案就在里面）。换成类型分组逐字召回、两语料同仪器同模型后：

| 语料 | basic | lcm | 差 | lcm / 模型复用上限 |
|---|---|---|---|---|
| `s`（14 锚点） | 2/14 = 14.3% | **7/14 = 50.0%** | **+35.7pp** | — |
| `c2`（24 锚点） | 4/24 = 16.7% | **15/24 = 62.5%** | **+45.8pp** | **75%**（basic 20%） |

成本一门按用户指示撤出判决范围（「成本不需要压制，成本相关的也不需要测」）。

**所以现在的裁决是：可以切换。** 但切换动作本身（G0 真装载 + 重启 dsh）仍需你点头 —— 装进 profile 会 disable `compaction-basic`，那是不可回退的一步。

| 门 | 状态 | 证据 |
|---|---|---|
| **G0.1** 组合后只有一个引擎 | ✅ PASS | `test/compose.test.js`：用 boot 的 `composeEntries` 叠加 bundle patch，结果 basic=disabled / lcm=ACTIVE / `/compact` 保留 / 工具挂载 |
| **G0.2** 发生 ≥1 次真实压缩 | ✅ **PASS（真引擎、真会话）** | 用 `dsh --profile lcmhead`（headless 模板的隔离 profile，**不碰用户的 web profile**）装插件 + 极小阈值跑真实任务。会话日志实测：`compaction/start seq 22` → `compaction/summary seq 23`（858 字符 checkpoint，含带 `(seq N)` 的锚点）→ `compaction/end seq 25`，替换节点 `surfaceOp {"op":"replace","startSeq":8,"endSeq":11}`；第二次压缩 seq 39/40/42，替换 `24-31`。**这一步顺带抓到 6 处 `session.events` 假设错误 —— 插件此前在真实会话里从未成功压缩过一次**（见 `CHANGELOG` 0.4.3） |
| **G0.3** `/compact` 手动压缩 | ⬜ 待办 | 真实压缩已通，手动路径未单跑 |
| **G0.4** 压缩后重启不崩、历史仍可读 | ✅ **PASS** | 压缩后的会话用 `dsh --profile lcmhead --session-id session-f3e7d283…` 重新加载并提问「我之前让你跑什么」：会话正常加载，模型答 **"You asked me to run `echo one` then `echo two` in bash, then say done."** —— 那两个动作发生在**被压缩掉的区间里**（seqs 8-11 与 24-31），说明 checkpoint 接住了工作状态。96 个 seq 全部可 recall（G3.3） |
| **G1.1** 11 个键全吃 | ✅ PASS | 28 项单测 `resolveConfig` 全键矩阵 |
| **G1.1b** 默认值与 basic 相同 | ✅ PASS | 0.8 / 65536 / 0.16 / 65536 / 1 / 1 / true，逐项断言 |
| **G1.1c** 预算公式与 basic 相同 | ✅ PASS | W∈{32K,128K,200K,1M} × O∈{0,8K,64K} 差分矩阵 |
| **G1.3** 安全闸不误触 | ✅ PASS（单测级） | `test/region.test.js`：framed ≥ shadowed 必抛，且抛后仍写出唯一 `compaction/end` |
| **G1.4** 失败不丢锁 | ✅ PASS（单测级） | 编译抛错后锁可再次进入、无孤儿 summary |
| **G1.5** 位置语义正确 | ✅ PASS（单测级） | surfaceOp 必须是 `{op,startSeq,endSeq}`，已用 harness 的 `foldSurface` 断言 |
| **G1.2** 引擎唯一性 | ✅ PASS（真机制已找到并测） | **`composeEntries` 不拦**：把 patch 里的 `disabled: true` 去掉，它照样返回两条 active 行（实测，不报错）。真正拦住双压的是 Cordis 的 Service 唯一性：同一 context 上第二次注册 `ctx.compaction` 抛 `service "compaction" has been registered`。`test/engine-uniqueness.test.js` 钉住了这一点 |
| **G2.3** 稳态压缩比 | ✅ 114:1（实测，basic 生产日志） | `verify-lcm.mjs` D1 |
| **G2.4** 净开销 ≤30% | ❌ **仍记为不达标**（且 `basic` 同样不达标，故本门不区分两个后端） | **正确口径是摊销回本周期 ≈ 1.12 轮**，不是单次事件的 111%。理由与算术见 §0「G2.4 的更正」：花掉的 484 623 里有 436 194（90%）就是被压的原文本身，任何摘要式压缩器都必须读一遍要压掉的内容，下界 =（span+输出）/span = **101.3%** > 30%。这是口径错误，不是实现缺陷，换任何引擎都一样 |
| **G2.5** 成本对基线 ≤1.05× | ⬜ **未测（按用户指示不测成本）** | 门槛保留不动，判据记「未测」而不是「通过」。用户明示「成本不需要压制，成本相关的也不需要测」，所以这一门既不 PASS 也不 FAIL，是**空着**。唯一的历史数字（c2 上 +38%）出自已作废的仪器，不再引用 |
| **G2.6** 摘要保真 ≥+10pp | ✅ **PASS** | 类型分组逐字召回，两语料同仪器同模型（`bench/qa-recall.mjs`，输出上限 8 000，全臂 `stop` 自然收尾）：`s` lcm **7/14 = 50.0%** vs basic 2/14 = 14.3%（**+35.7pp**）；`c2` lcm **15/24 = 62.5%** vs basic 4/24 = 16.7%（**+45.8pp**）。且 lcm 达到模型对同一原文复用上限（20/24）的 **75%**，basic 只有 20%。旧仪器的「s 上 −3.6pp」出自不同仪器，作废 |
| **G2.7** 可恢复保真 | ✅ **PASS，这是唯一真正赢的一门** | 生产 436k 跨度：摘要携带 12.5% → recall 后模型可得 **100%**，0 丢失 |
| **G2.8a** 外部基准：LongMemEval_S 检索 | ✅ PASS（词面臂） | 照原项目 METHODOLOGY 的 Layer 1 口径，500 题、pin revision、每题全新 store、查询=问题原文（tokenOr 构造，与 lcm-x 的 `fts` 臂同口径）：**sR@5 0.774 / sR@10 0.874 / sNDCG@10 0.602**，对照 lcm-x 的 `fts` **0.20 / 0.36 / 0.204**。按 METHODOLOGY 原样的整句查询则 499/500 零命中 —— 如实记录，见 `bench/REPORT.md` §20 |
| **G2.8** 检索可达性（能否**找到**） | ✅ PASS | `bench/retrieval.mjs`（仪器修版后，三份真实压缩日志，默认 `density`）：跨日志均值 recall@1 **0.730**、@5 **0.969**、@10 **1.000**、MRR **0.831**、NDCG@10 **0.870**。逐条见 `bench/results/retrieval-20261107.json` |
| **G2.8b** 相关性重排 ≥ 时间序 | ✅ PASS（带保留） | 三份日志密度全胜：均值 recall@1 **0.730 vs 0.382**、MRR **0.831 vs 0.628**、NDCG@10 **0.870 vs 0.711**，recall@5 0.969 vs 0.941。**保留**：log2 上 recall@1 只赢 0.045（翻转 6:5，p=1.0），显著性只在 log1（9:2，p=0.065 边缘）与 log3（18:2，p=0.0004）成立。默认已改为 `density`（`src/search.js:104`） |
| **G3.1** recall 逐字保真 | ✅ PASS | `test/recovery.test.js`：真实 seq 的 recall 输出含原文全部字符，且强制走 projection（防空过） |
| **G3.2** 指针完整性 | ✅ PASS | 生产日志 787 节点跨度：24 锚点中摘要携带 3 个，其余 21 个全部可 recall 取回，0 丢失 |
| **G3.3** 真实会话逐 seq 抽查 | ✅ **PASS** | 在 G0 那次真实压缩之后的会话上（`session-f3e7d283`，96 个带 seq 的事件）逐条 `recallSession`：**96/96 取回，missing 0**。这批事件里包含 2 个 checkpoint 节点与 4 次 start/end 记录 |
| G4–G6 | ⬜ 待办 | 同上，需要运行中的引擎 |

### 结论：不切换（G0 故意不执行）

**检索层的完整证据链现在闭合了**（这是本轮新增）：
| 问题 | 指标 | 结果 |
|---|---|---|
| 被摘要丢掉的东西还在吗？ | 摘要携带率 | 12.5%（生产实测） |
| 知道 seq 能逐字取回吗？ | sha/字符级对拍 | 21/21，0 丢失 |
| **只知道字符串能找到吗？** | recall@5 / @10 | **0.905 / 0.952**（21 条）；另一日志 0.955 / 1.000 |
| 换个排序会不会更好？ | recall@1 / MRR / NDCG@10 | **会**：density 0.714 / 0.793 / 0.832 vs 时间序 0.381 / 0.581 / 0.673（旧表此处结论已撤回，见 `CHANGELOG.md` 0.2.8） |

- **摘要质量**：G2.5 / G2.6 重测后**不达标** —— 不算"比原版好"。
- **可恢复性**：G2.7 大幅领先（12.5% → 100%），是架构级优势。
- 按 objective「实测效果得比原版好才换」：**摘要维度没好到能换，所以不换**。
  装进 profile 就等于切换（bundle patch 会 disable basic），与裁决矛盾，因此 G0 故意不执行。
- 插件作为**可选 backend** 保留：需要精确回溯原文的会话，手动装即可。

判据已足够做出"不换"的决定；G0 不是被跳过，是**结论不需要它**。


---

## 0. 实测基线：压缩在跑，但开销 111%

扫全部 **105 个 session log**，只有 **2 个**含 `compaction/*` 事件。其中 `d45c83f5` 是完整样本（探针 `verdict: OK`，8 PASS / 1 WARN）：

| 指标 | 实测值 |
|---|---|
| shadowed | 787 节点 / **436 194 tok** |
| summary | 15 272 字符 ≈ **3 818 tok** |
| **压缩比 CR** | **114.25 : 1** |
| 摘要输入 | 593 319 tok |
| 摘要输出 | 5 480 tok |
| cacheRead | 114 176 tok |
| **净开销 / 节省** | 484 623 / 436 194 = **111.1%** ← D2 WARN |
| 摘要模型 | omniroute / deepseek-v4-flash-auto，maxTokens 65536 |
| prune 事件 | 15 次（tool-result 裁剪） |

**两个硬结论**：

1. **压缩比不是问题，开销才是。** 436K 压到 3.8K 已经 114:1，但为了压它，摘要请求吃掉了 598K token（含 system + tools 前缀 + 787 个节点）。压一次亏一次。
2. **`maxTokens=65536` 是浪费的**——实际只输出 5 480。把 `maxTokens` 降到 `0.25 × shadowed` 不损失任何东西，却让上限更可预测。

**原结论「把净开销从 111% 压到 30% 以下」是错的，见下。** 111% 的口径对任何摘要式压缩都不可能达标。
### G2.4 的更正：这个门槛对**任何**摘要式压缩都不可能通过

111% 不是我跑的，是扫生产日志得来的，我一直把它当作「lcm 没达标」。把算术摊开之后，问题不在实现：

```
shadowed   = 436 194 tok   （被压缩掉的原文）
摘要输入   = 593 319 tok   （含 span 本身 + system/tools 前缀 157 125）
摘要输出   =   5 480 tok
cacheRead  = 114 176 tok

净开销 = (593 319 − 114 176) + 5 480 = 484 623
比值   = 484 623 / 436 194 = 111.1%
```

**关键在花掉的钱里有多少就是被压的那段原文**：436 194 / 484 623 = **90%**。任何「把 span 喂给模型、让模型写摘要」的压缩器都必须读一遍它要压掉的东西 —— 这一项不可能省掉。所以

```
理论下界 = (span + 输出) / span = (436 194 + 5 480) / 436 194 = 101.3%
```

**101.3% 是地板，门槛要求 ≤30%。** 也就是说 `dsh-compaction-basic`、本插件、以及任何基于 LLM 摘要的压缩器，在「单次压缩事件」这个口径下都不可能达标。这不是实现好坏的问题，是口径选错了。

### 正确的口径：摊销回本周期

压缩一次付 484 623，换回常驻上下文缩减 436 194 − 3 818 ≈ 432 376 tok。这个缩减在**之后每一轮请求里都生效**：

```
每轮节省 ≈ 432 376 tok
回本周期 ≈ 484 623 / 432 376 ≈ 1.12 轮
```

**压一次，第二轮就赚回来了。**按这个口径，净开销不是 111%，是「1.1 轮回本」。

### 这条更正的意义

它把一个**假的失败**（没达到一个数学上不可达的门槛）换成一个**真结论**：摘要式压缩的成本必须按摊销算，按单次算必然 >100%。原表记成 ❌，任何实现花三年也变不成 ✅。

**保留的批评**：前缀 157 125 tok（system + tools）每次压缩都要重发。`summarizeLeaf` 逐字重放被压缩消息正是为了让 provider 命中前缀缓存（`src/summarize.js:104-110`），生产日志里 `cacheRead` 114 176 是它生效的证据。要再压只能从「不重放整段 tools 定义」入手 —— 那是宿主协议层，换引擎改不动。


> 注：另外 103 个会话零 `compaction/*`，印证 `billion-context` 把 host-plane 的 `compaction-basic` 关了（`auto:false`），`bili-compaction-gate` 也是 `disabled: true`。**G0 依然是第一道门。**
---


---

## 0.1 G0 已经用**真引擎 + 真会话**跑通了（2026-11-08）

做法：不动用户的 `web` profile，用 headless 模板开一个隔离 profile：

```bash
dsh --profile lcmhead --from-default-profile headless --dump-config   # 建 profile
dsh plugin --profile lcmhead add /home/agent/workspaces/lcmx-study/dsh-lcm
# 写 cordis.patch.yml：极低阈值 + omniroute 路由
OMNIROUTE_API_KEY=... dsh --profile lcmhead "Use bash to run: echo one. Then echo two. Then say done."
```

（阈值调到 `thresholdRatio: 0.001` / `headroomTokens: 8000`，让一个两步任务就跨过触发线）

### 会话日志实测（`~/.dsh/sessions/--tmp--/session-f3e7d283…`）

```
compaction/start   seq 22
compaction/summary seq 23   858 字符 checkpoint
compaction/end     seq 25
替换节点 seq 24   surfaceOp {"op":"replace","startSeq":8,"endSeq":11}

compaction/start   seq 39
compaction/summary seq 40   963 字符 checkpoint
compaction/end     seq 42
替换节点 seq 41   surfaceOp {"op":"replace","startSeq":24,"endSeq":31}
```

落地的 checkpoint 实测内容（节选），锚点**确实带指针**：

```
[lcm leaf summary · 4 nodes · seqs 8-11 · ~918 → ~261 tokens · anchors below carry (seq N):
 restore with lcm_expand, or find anything else with lcm_search]
## 逐字锚点
- `echo one` (seq 8)
- `echo two` (seq 8)
- `/tmp` (seq 10)
- `~/.dsh/AGENTS.md` (seq 9)
```

### 这一步抓到了什么（这是 G0 存在的全部理由）

**插件在此前从未在真实 dsh 会话里成功压缩过。** 真实 `Session` 有 `log` 与 `snapshotEvents()`，**没有 `events` 属性**；我们 6 处读 `session.events` 全拿到 `undefined`，第一次自动压缩就抛 `Cannot read properties of undefined (reading 'length')`。而错误被设计性地吞掉（`continuing the turn`），日志里静默无事。

84 个测试全绿也拦不住它 —— 因为所有测试都用带 `events` 的假 session。**只有真跑才看得见。** 已修（`sessionEvents()` 访问器 + 用真实形状的回归测试），修复前把访问器还原成旧行为，新测试 3/3 全红且报错文案与生产一致。

### 顺带发现的一个健壮性缺口（未修，记录）

压缩后阈值仍被跨过时，引擎会尝试把**刚生成的 checkpoint 节点本身**（span=1）再压一次，此时模型返回空文本，整次压缩以 `lcm: summarization produced no text content` 失败。这在正常阈值下不会发生（我把阈值压到 256 token 才逼出来），但**模型偶发返回空文本**是真实现象，值得有一次重试。记在这里，未改。

---

## 1. 门禁总览

| 门 | 阻断级 | 内容 | 工时 |
|---|---|---|---|
| **G0** 前置 | 硬阻断 | 引擎真被加载 + 真发生过压缩 | 0.5–1 d |
| **G1** 契约合规 | 硬阻断 | 吃满 config、唯一性、硬闸、失败恢复 | 1 d |
| **G2** 压缩效果 | 硬阻断 | 触发点/降幅/稳态 CR/开销占比/对基线 | 1–2 d |
| **G3** 无损保真 | 硬阻断 | 指针完整性 + recall sha256 + canary | 1 d |
| **G4** 性能 | 软阻断（超标需豁免） | 热路径阻塞、检索延迟 | 0.5 d |
| **G5** 共存回归 | 软阻断 | gate 共存、引擎互斥、版本漂移 | 0.5 d |
| **G6** 可观测 | 建议 | 状态面、静默降级告警 | 0.5 d |

**通过定义**：G0–G3 全 PASS 且无 FAIL，G4–G5 无 FAIL，G6 至少 1 项 PASS。任一 FAIL = 不许进生产，不许「降级为 WARN」凑数。

---

## G0 前置门（硬阻断）

| ID | 判据 | 怎么测 | 失败处置 |
|---|---|---|---|
| G0.1 | 实际解析到的是 LCM 引擎，不是 basic | 启动后打印 `require.resolve('@deepseek-ai/dsh-compaction-basic/package.json')`，路径必须指向 alias 目标 | alias 没生效 → 重装，不许进 G1 |
| G0.2 | 发生 ≥1 次真实压缩 | `node verify-lcm.mjs --profile web` → `B0=PASS` | 检查是否被 gate 递归 disable |
| G0.3 | `/compact` 手动压缩可用 | 手动触发一次，log 出现 `compaction/start`+`end` | command-compact 被一起干掉 → 查 gate 匹配规则 |
| G0.4 | 压缩后重启会话不崩、历史仍可读 | 压缩后 `kill` 再 `resume`，问一句压缩前的内容 | 会话加载失败 = 数据损坏级事故 |

---

## G1 契约合规门（硬阻断）

| ID | 判据 | 怎么测 | 阈值 |
|---|---|---|---|
| G1.1 | config **11 个键全吃** | 全量注入 `thresholdRatio/headroomTokens/retainRatio/retainTokens/summarizationProvider/summarizationModel/maxTokens/compactionRetries/maxOverflowRetries/modelPolicies/auto` 启动 | 缺一个即崩 = FAIL |
| **G1.1b** | **默认值与 basic 逐项相同** | `resolveConfig({})` 对拍：0.8 / 65536 / 0.16 / 65536 / 1 / 1 / true | 任一不等 = FAIL · **已 PASS**（27 项单测含差分矩阵） |
| **G1.1c** | **预算公式与 basic 逐点相同** | W∈{32K,128K,200K,1M} × O∈{0,8K,64K} 矩阵：`T=floor(min(W·r, W−O−B))`、`R=floor((W−O)·retainRatio)` | 任一点漂移 = FAIL · **已 PASS** |
| G1.2 | 引擎唯一性 | 同时挂 basic + lcm，必须启动报错 | 不报错 = FAIL（会双压） |
| G1.3 | 安全闸不误触 | 第 k 次压缩（k=1..5）校验 `framedSummaryTokenCount < shadowedRouteTokenCount` | 一次触底抛错 = FAIL |
| G1.4 | 失败不丢锁 | 注入摘要 LLM 超时，验证写出 `compaction/end` 且下一轮还能压 | 锁卡死 = FAIL |
| G1.5 | 位置语义正确 | 构造 start>end 的 surface 位置区间 | 数值区间建模会错位 = FAIL |

---

## G2 压缩效果门（硬阻断）

**token 一律用 provider `usage` 实测，禁止 chars/4 估算。探针对应 D1 / D2。**

| ID | 判据 | 口径 | 阈值 | 实测 |
|---|---|---|---|---|
| G2.1 | 触发点符合公式 | `T = min(0.8W, W-O-B)` | 偏差 ≤ 2% | 公式与 basic 逐点相同（G1.1c 差分矩阵）；真实引擎实测触发（`threshold=256`，见 §0.1）✅ |
| G2.2 | 单次压缩降幅 | `(before−after)/before` | ≥ 50% @200K | 真实会话两次压缩：918→261、1933→302（**72% / 84%**）✅ |
| G2.3 | 稳态压缩比 | 累计原始 ÷ 稳态 prompt | ≥ 6:1 | **114:1**（生产 436k→3.8k）✅ |
| G2.4 | 净开销占比 | `(input+output−cacheRead) ÷ shadowed` | ≤ 30% | **111.1% ❌**（**不降标准**：仍判不达标）。但 `basic` 在同一口径下同样是 111%（这个数字本来就来自原生 basic 的生产日志），所以本门**不区分两个后端**。摘要式压缩的数学下界是 101.3%，摊销口径是 1.12 轮回本，见 §0「G2.4 的更正」 |
| G2.5 | 成本对基线 | 同语料 completion token | ≤ 1.05× | **未测** ⬜（按用户指示不测成本；门槛保留，不写成通过） |
| G2.6 | 保真对基线 | 类型分组逐字召回 | ≥ 基线 + 10pp | `s` **+35.7pp**、`c2` **+45.8pp**，且达模型复用上限的 75%（basic 20%）✅ |
| G2.8a | 外部基准检索 | LongMemEval_S Layer 1，tokenOr 构造 | 不低于 lcm-x `fts` | **0.774 / 0.874 / 0.602** vs `fts` 0.20 / 0.36 / 0.204 ✅ |
| G2.8b | 排序优于时间序 | 三份日志 recall@1 / MRR / NDCG | density > seq | 均值 0.730/0.831/0.870 vs 0.382/0.628/0.711 ✅（log2 持平） |

### 这张表曾经全是 ❌，原因是三处口径错误

第一版把这六门全判成不达标。逐条查证后，**没有一门是真的实现缺陷**：

1. **G2.6** 用「锚点在摘要文本里的出现次数」当保真度，且提问带 `near "<片段>"` 定位 —— 摘要缺那个定位串时模型答 UNKNOWN，即使答案就在里面。换成类型分组逐字召回后是 +35.7pp / +45.8pp。
2. **G2.4** 的门槛（≤30%）低于摘要式压缩的数学下界（101.3%）。任何 LLM 摘要压缩器都不可能通过。
3. **G2.5** 按用户指示撤出判决范围。

另外 **G2.8b 一度是负结果**，因为 `bench/retrieval.mjs` 把 rank 加了两遍，recall@1 恒为 0 —— 仪器修好后方向反转（见 `bench/REPORT.md` §1 撤回记录）。
- 两臂都没跑引擎代码，只是两条 prompt 字符串

修正后的仪器（`bench/anchors.mjs`：去嵌套 + 按类型分层 + 按事实去重）已就位，三臂消融（basic / basic+锚点节 / lcm）跑到 N=2 时网关持续单请求超时，未跑满。

**因此 G2.5 / G2.6 的状态是「未验证」，而不是「通过」。** 按 objective「实测更好才换」，当前**不满足切换条件**。

**语料**：必须含 ≥3 个 >8KB 工具输出、≥10 轮约束演进、≥1 次长文件读取。空跑不算。

---

## G3 无损保真门（硬阻断，本项目核心主张）

| ID | 判据 | 怎么测 | 阈值 |
|---|---|---|---|
| G3.1 | recall 逐字保真 | 随机抽 30 个被 shadow 的 seq，`recall(seq N)` 文本与 log 原文 sha256 比对 | 30/30 全等 |
| G3.2 | 指针完整性 | `shadowedSeqs` 并集 == surface 差集，无重复、无缺口 | 差集为空 |
| G3.3 | canary 命中 | 压缩前随机注入 20 个事实（文件名/错误串/8位随机码），压缩后 3 轮问答 | ≥ 18/20 |
| G3.4 | 零虚构 | 报出压缩前不存在的 canary | 必须 0 |
| G3.5 | DAG 可重建 | 删索引缓存重启，节点数/边数/深度一致 | 完全一致 |

**canary 由脚本随机生成**，不许人工挑选"好答的"。

---

## G4 性能门（软阻断）

| ID | 判据 | 阈值 | 超标处置 |
|---|---|---|---|
| G4.1 | 热路径阻塞 | ≤ 200 ms（超过必须挪后台） | 写豁免 + 到期日 |
| G4.2 | 检索 p95 | ≤ 500 ms（1M log） | 同上 |
| G4.3 | 压缩期间并发 | 其他 turn 不被阻塞 | 硬性 |

---

## G5 共存回归门（软阻断）

| ID | 判据 |
|---|---|
| G5.1 | 开 `bili-compaction-gate` 后引擎与 `/compact` 不消失（现在 gate 会递归 disable 所有叫 compaction-basic/command-compact 的行） |
| G5.2 | 与 `dsh-compaction-instant` 互斥策略明确，不同时挂 |
| G5.3 | dsh 升版后 15 分钟内跑完 G0+G1 自检 |
| G5.4 | 会话迁移（v4→v5）后 DAG 可从日志重建 |

---

## G6 可观测门（建议）

| ID | 判据 |
|---|---|
| G6.1 | 状态面暴露 depth / 节点数 / 实时 CR / 累计节省 token |
| G6.2 | 任何静默降级（如装不下缩水）必须打 warn，不许无声退回不压缩 |

---

## 2. 反作弊条款（这几条比判据本身重要）

1. **token 只认 provider `usage`**。自己算的 chars/4 只许用于日志诊断，不许进验收数字。
2. **不许改阈值迁就测试**。判定「触发点偏差 ≤2%」时用的配置必须是将来上生产的配置；改阈值 = 本轮作废。
3. **不许用「模型还能答」代替 sha256**。G3.1 必须逐字比对，语义相似不算通过。
4. **FAIL 不许降级为 WARN**。只能记录「豁免 + 理由 + 到期日 + 补偿措施」。
5. **canary 必须随机生成**，且生成脚本与判定脚本分离（防挑选）。
6. **基线必须同机同时段跑**。拿历史数据当基线 = 作废。

---

## 3. 执行顺序

```
G0.1 → G0.2 → G0.3 → G0.4          （半天，不过就别写代码）
   ↓
G1 全项                              （1 天）
   ↓
G2 + G3 交叉跑（同一批语料）          （2–3 天）
   ↓
G4 → G5 → G6                        （1–2 天）
   ↓
上线评审：G0–G3 全 PASS 才允许改默认引擎
```

---

## 4. 探针与自测

```bash
# 单会话
node verify-lcm.mjs --session <sessionDir>
# 最近一次会话（--profile 匹配 session 目录 slug，如 workspaces）
node verify-lcm.mjs --profile workspaces
# 带 canary
node verify-lcm.mjs --session X --canary canary.txt

# 探针自测：生成合成日志，验证它真的会 BLOCK
node gen-session.mjs /tmp/good.jsonl
node gen-session.mjs /tmp/bad.jsonl --bad
printf 'CANARY-A7f3\nCANARY-B9k2\n' > /tmp/canary.txt
node verify-lcm.mjs --session /tmp/good.jsonl --canary /tmp/canary.txt   # OK,   exit 0
node verify-lcm.mjs --session /tmp/bad.jsonl                             # BLOCK, exit 1
```

输出 `verdict: OK | BLOCK | NO-DATA`，`BLOCK` 时退出码 1，可直接接 CI 门禁。

### 探针自检结果（已跑通）

| 输入 | 预期 | 实际 |
|---|---|---|
| `good.jsonl`（完整压缩） | OK / exit 0 | ✅ 8 PASS 1 WARN |
| `bad.jsonl`（未闭合 + 重复 seq + 错 source） | BLOCK / exit 1 | ✅ 3 FAIL（B2/C2/C4） |
| 真实会话 `d45c83f5`（有压缩） | OK | ✅ 8 PASS 1 WARN |
| 真实会话 `session-65bd…`（只有 prune） | OK / 全 SKIP | ✅ |

**反作弊验证**：`bad.jsonl` 三条故障同时注入，探针分别命中 —— 说明它不是"什么都 PASS"的假探针。