# dsh-lcm

[English](README.md) · **简体中文**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的无损上下文压缩引擎（LCM）。

`@deepseek-ai/dsh-compaction-basic` 的即插即用替代品：同一个 `ctx.compaction` 接口、**同一套配置面、同样的默认值**、同一套持久化事务协议。变的只有摘要器——由模型写一段结构化 checkpoint，被折叠的每个节点仍留在只追加的会话日志里，checkpoint 携带 `seq N` 指针，agent 可以用 `lcm_expand` 把原始 token 逐字取回。

基于 [LCM 论文](https://papers.voltropy.com/LCM)（Ehrlich & Blackman, 2026-02）与 [`dsh-compaction-instant`](https://github.com/TsFreddie/dsh-compaction-instant) 的持久化协议工作。

> **状态：通过保真门；安装是有意为之的一步。**
>
> 对照 `dsh-compaction-basic`，在两组语料上做分类型逐字召回测量：本后端交给模型**多 3.0–3.5 倍的原样字面量**（4.3k 跨度上 7/14 对 2/14，8.1k 跨度上 15/24 对 4/24），并能达到模型对同一段**未压缩**原文仍可引述内容的 **75%**，而 `basic` 是 20%。在 LongMemEval_S 上，其词面检索 sR@5 为 **0.774**，`lcm-x` 自身的词面臂为 0.20；有一条完整轨迹显示，一个 1 669 token 的 checkpoint 通过一次 `lcm_search` 回答了证据已被压缩掉的问题。
>
> 安装它会替掉整个 profile 的 `compaction-basic`，所以它保持为一次明确选择而非默认。门表格见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)，全部数字见 [bench/REPORT.md](bench/REPORT.md)，其中包含两个曾把早期结论反向的测量 bug。

## 什么测了，什么没测

第一轮基准的审计（见 [bench/REPORT.md](bench/REPORT.md)）撤回了其中三项结论。撤回原因与留下来的原因都记录在案，因为一个不说明自己错在哪里的基准不值得相信。

留下来的那个数字在同一段 8.1k token 的跨度上测得：

| | 值 |
|---|---|
| 生产环境摘要实际携带的锚点 | **3 / 24（12.5%）** |
| 通过 `lcm_expand` 逐字节取回的锚点 | 21 / 21 |
| **模型仍能获得的总锚点** | **24 / 24（100%）** |
| 永久丢失 | **0** |

在那个尺寸上**任何摘要都装不下全部**——这是容量上限，不是模型失败。纯摘要式 checkpoint 停在 12.5%，因为它里面没有任何东西告诉模型其余部分还存在。本后端携带 `seq` 指针与召回指引，所以其余部分只差一次调用。

准确地说：**可发现**的可恢复性从 12.5% 变成 100%。`basic` 并非为零——`session_search` 存在——但它的 checkpoint 从不指向那里。

旧的“更密的摘要”叙事已经作废：在两组语料上测得，本后端的摘要携带**多 3.0–3.5 倍的原样字面量**（4.3k 跨度 7/14 对 2/14；8.1k 跨度 15/24 对 4/24），并达到模型对**未压缩**原文仍可引述内容的 **75%**，`basic` 为 20%。这是成立的声明，且在两组语料上都成立。安装仍是有意为之的一步——它会停用 `compaction-basic`。

不需要基准就能成立的结构性声明：**checkpoint 是日志之上的一个视图，而日志保留一切。** 丢掉一条路径的摘要可以用 `lcm_expand` 恢复；在纯摘要式后端里丢掉就是模型再也够不到。
## 改了什么

| | `dsh-compaction-basic` | `dsh-compaction-instant` | **`dsh-lcm`** |
|---|---|---|---|
| 摘要器 | LLM | 确定性编译器 | **LLM** |
| 摘要形态 | 自由散文 | 逐字摘录 | **5 个叙述小节 + 一张逐条枚举的锚点清单** |
| 压缩后的原文 | 仅日志，模型侧无路径 | `(seq N)` + 召回工具 | **`(seq N)` + `lcm_expand`** |
| checkpoint 自检 | `framed < shadowed` | `framed < shadowed` | 同上，另加“正文非空”与“正文短于跨度”两道 |
| 同深度合并 | 无 | 无 | **fanin 4，形成对数增长的 DAG** |
| 降级梯级 | 失败即失败 | 只做确定性 | **模型 → 确定性正文 → 确定性截断** |

## 配置

**`dsh-compaction-basic` 接受的每个键这里都接受，含义相同、默认值相同。** 现成的 basic 配置原样放进来即可。完整带注释文件：[config.example.yaml](config.example.yaml)。

```yaml
- id: compaction-lcm
  name: dsh-lcm
  config:
    # ── 与 dsh-compaction-basic 完全相同 ──
    thresholdRatio: 0.75       # 触发点 = min(W*ratio, W-O-headroom)；lcm-x 的 context_threshold
    headroomTokens: 65536
    retainRatio: 0.05          # 与 retainTokens 互斥；1M 窗口下约 47k
    summarizationProvider: ""  # "" = 走当前路由的模型
    summarizationModel: ""
    maxTokens: 65536           # 限制摘要目标；请求上限是目标的 2 倍
    compactionRetries: 1
    maxOverflowRetries: 1
    modelPolicies: []
    auto: true
    # ── 仅 LCM ──
    summaryRatio: 0.20         # 下限==上限==2000，所以目标恒为 2000
    summaryFloorTokens: 2000   # lcm-x leaf_target_min_tokens
    checkpointCap: 2000        # lcm-x leaf_target_max_tokens（相等是有意的）
    leafSpanTokens: 24000      # 一次压缩最多吃这么多；48000 可把调用次数减半
    condensationFanin: 4       # 同深度 checkpoint 凑够这个数就合并成上一层的一个节点
    anchorPointers: true       # 事后给每条逐字锚点补 (seq N)
    emptySummaryRetries: 2     # 无文本块的响应重试；有文本但被截断的从不重试
    backgroundLeafPrep: false  # 空闲时预计算下一个叶；默认关，与 lcm-x 一致
    temporalRollups: true      # 按天时间线索引；默认开，与 lcm-x 一致
    rollupBuildsPerPass: 2
    rollupMaintenanceBudgetMs: 5000
    assertionExtraction: false # 抽取（主语, 谓语, 宾语）三元组；默认关，与 lcm-x 一致
    assertionMaxSourcesPerPass: 4
    # ── sweep 的两个时钟与收尾预留 ──
    fullSweepMaxSeconds: 120       # lcm-x 的 120s；110s 可用 / 32.3s 中位叶 = 3 个叶
    fullSweepSoftSeconds: 0        # 0 = 不设软目标；比目标还短的时钟会一个叶就掐死 sweep
    fullSweepTargetShare: 0.08     # 0.08×750000=60000，在一次穿越能压的 64437 之内
    fullSweepReserveSeconds: 10    # 硬上限里为“提交 + 重新测量”预留的一段
    leafEstimateFloorSeconds: 15   # 软目标判定用的叶耗时下限

# 语义路由挂在 SEARCH 行上，不在引擎行。引擎声明并解析 vector 键，
# 但压缩路径一个都不读，所以这里写 "vectorEnabled: true" 只会在
# --dump-config 里看起来是开的，而 search 悄悄仍是词面。
- id: tool-lcm-expand
  name: dsh-lcm/tool
  config:
    rank: hybrid               # 两道门都得开：这个 + vectorEnabled
    vectorEnabled: false       # 默认关；为 false 时 rank hybrid 就是词面结果
    vectorBaseUrl: "http://10.126.126.4:20128/v1"
    vectorModel: "mistral-proxy/codestral-embed"
    vectorDim: 1536
    # 密钥由环境变量名指定，再从 $DSH_HOME/.credentials.yaml 的 refs: 兜底。
    # ""（默认）不发 Authorization 头。
    vectorApiKeyEnv: "OMNIROUTE_API_KEY"
    vectorTopK: 8
    vectorCandidateTokens: 30000   # 首搜成本按文本计价，这个界定它
    vectorCandidateLimit: 500      # 条数上限，防止一堆小事件买到同样的成本
    vectorTimeoutMs: 30000
    vectorCacheDir: ".lcm-vectors"
```
### 可选的语义检索

`lcm_search` 是跑在持久日志上的正则——为“agent 记得某个字符串”而做，不是为自然语言问题。在 LongMemEval_S 上，把问题原文直接喂进去，**500 个问题里有 499 个零命中**；那是查询形态不匹配，不是匹配器的 bug。两条出路，都是开关式的：

- `rank: "vector"`——对任意 OpenAI 兼容端点做嵌入 KNN。用余弦而非点积（端点返回的是未归一化向量，点积排序会把顺序测得出反）。结果按 `sha256(model + 截断文本)` 落盘缓存。
- `rank: "hybrid"`——在词面与向量之间做 RRF（k=60），与 `lcm-x` 的 `hybrid_rrf` 臂同一套融合。

`vectorEnabled: false`（默认）时两种模式都不花成本：检索路径与纯词面逐字节相同，有测试断言。端点不可达时降级到词面并在结果文本里说明，而不是抛错。

**语义路由能看见哪些事件。** 只有当前 surface **不**展示的那些——即已压缩的那一半。给尾部排序是浪费：那些消息已经逐字在模型上下文里了。在一个 24 013 事件的会话上测得，“最新 N 条”覆盖了 100% 的活跃尾部、只覆盖 1.6% 的已压缩历史，也就是错了的那一半。窗口按 **token** 计价（`vectorCandidateTokens`），因为成本跟文本长度走而不跟事件数走：在实测端点上约每条 18 ms 加每 token 0.23 ms，分批（批 8–128 时 87–92 ms/条）与并发（8 个并行 POST **更差**，205 ms/条）都改变不了它。

**模型换得掉，缓存能填满。** 目录是 `<cacheDir>/<sha256(model) 前12位>-<dim>/`，每文本的键是 `sha256(model + 换行 + text)`，两个模型既不共享目录也不共享键，宽度不符一律当未命中。`/lcm-embed backfill` 走的是与检索完全相同的候选集并写入相同的键；默认预演，`--apply` 才真的花钱，`--limit` 限定单轮工作量（每一轮都推进），`--window` 只填计价窗口做廉价预热。`/lcm-embed status` 报候选、已缓存、待嵌入与检索预算，只读、零后端请求。

## 叶的粒度，以及它的代价

一次压缩处理**一个叶**：从最老的节点开始，把边界回退到一个配平的工具调用对边缘，最多 `leafSpanTokens` 那么多。所以一段 436 194 token 的历史要 19 个叶，不是一遍扫完。

叶存在是因为单遍扫会失败：在 15 个实测问题上，provider 在小节写完前就截断了响应，其中 5 个只剩 1 个小节。同样的提示词切成 24k 的叶后，7/7 全部返回 6 个小节齐全且 `finish: stop`（[bench/REPORT.md](bench/REPORT.md) §32）。

换来的是：永不截断的摘要、完整的小节、每次调用有界的摘要提示词。同深度的叶在攒够 `condensationFanin`（4）个兄弟后凝聚成一个更高层节点，于是 surface 按对数增长而不是排成一条平铺的行。返回空文本、或被请求上限截断的叶，落到一个由跨度自身构建的确定性正文；回来后超过收缩边界的叶，用一半预算重试一次，然后走确定性截断。这两级都不调模型，所以压缩是收敛而不是失败。

> **关于空响应**：一个只出推理的模型会把完成预算烧在隐藏思考上，返回零个文本块。**在同一上限下重试会按构造复现这个失败**——它不是抽样意外。所以在 121 个 checkpoint 上实测后，重试现在**每次把上限翻倍**（4096 → 8192 → 16384 → 32768）。依据是降级率的分布：小跨度（上限被 4096 地板钉住）的降级率是 27.3%，大跨度只有 4.0%，差的 6.8 倍正是那个地板。首次尝试仍走基础上限，模型答得出来时会远早于它停下，所以顺利路径不多花一分钱。

代价是每个叶都要重发固定前缀（系统提示 + 指令）。按实测的 271 301 token 前缀、对同一段 436 194 token 历史外推：

| | 调用数 | token（毛） | 相对 basic |
|---|---|---|---|
| `dsh-compaction-basic`，一遍 | 1 | 712 975 | 1.00× |
| `dsh-lcm`，19 × 24k 叶 | 19 | 5 665 439 | **7.95×** |

缓存命中吃掉了大部分钱但不吃 token 数：把第 2..19 个叶按缓存命中计价，外推是 1 270 361 等价价，basic 是 610 217，约 **2.08×**。两个数字都是外推，不是该规模下实测的 lcm 运行。

旋钮是 `leafSpanTokens`。提到 48 000 会让叶数减半、前缀重发减半，代价是每个叶携带更多细节、更容易漏东西。24 000 是实测校准出来的那个值。
## 工具

| 工具 | 用途 |
|---|---|
| `lcm_expand` | 按 `seq`（`"3-7,15"`）、`result`（`"3"`）或 `checkpoint`（`"1"`）逐字还原原文 |
| `lcm_search` | 在整个持久日志上做关键词/正则检索，包括 checkpoint 省略掉的内容；配置了嵌入时可选 `vector`/`hybrid` 排序 |
| `recall` / `search` | **原后端的名字，保留为别名**——行为完全相同 |
| `/lcm-search <pattern>` | 人这一侧的检索；把命中作为一条持久 user 消息追加 |
| `/lcm-status` | checkpoint 数、深度、省下的 token |
| `/lcm-embed status` | 模型、宽度、缓存目录、文件数、**bearer token 由哪个来源提供**、以及这一层是否开着 |
| `/lcm-embed backfill [--apply] [--limit N] [--window]` | 预演（默认）或填满整个已压缩语料的向量缓存——即 lcm-x 的 `/lcm embed backfill`。`--limit` 限定单轮工作量（每一轮都推进）；`--window` 只填计价过的检索窗口 |
| `/recall <pattern>` | **原命令名，保留为别名** |

换后端时，原来指向 `recall`、`search` 或 `/recall` 的东西都不会坏。在两行插件任一上设 `legacyNames: false` 可去掉别名、只注册 LCM 名字。

## 安装

一条命令，不手改 profile 文件：

```bash
dsh plugin --profile web add <本包路径或其 tarball>
```

从 git URL 安装——这是市场安装走的路径，也是这里实测过的路径（`dsh plugin --profile <p> add github:zy-xyz/dsh-lcm` 从源码构建，约 1 分 51 秒装成 0.15.x，bundle manifest 完好）：

```bash
dsh plugin --profile web add github:zy-xyz/dsh-lcm
```

它会在 profile 里跑 pnpm，然后插件管理器自身的对账逻辑（`reconcileBundleSelection`）把本包登记进 `dsh.profile.bundles`，因为本包声明了 `dsh.bundle.patch`。此后 bundle patch 就是 profile 的一层：它用 `disabled: true` 让 `compaction-basic` 停摆（一个 context 只能有一个 `ctx.compaction`——`config: {auto: false}` **不够**，那一行仍会注册服务，于是本引擎拿不到接缝），插入本引擎与它的工具，并加上 `cordis.patch.yml` 里描述的那道预设平面闩锁。重启进程以加载；别的都不用动。

**每个官方包都是 peer 而不是 dependency**：harness 自己已经带了 `@deepseek-ai/dsh-compaction`、`dsh-llm`、`dsh-session`、`dsh-token-meter`、`dsh-tools`、`dsh-util-values`、`cordis` 与 `schemastery`，再来一份就是版本漂移 bug。它们在 `peerDependenciesMeta` 里声明为 `optional`，所以从宿主树解析它们的 profile 不会被警告噪音淹没；dsh 的范围按 patch 元组逐一枚举并各带预发布标签（`>=0.2.2-0 <0.3.0-0 || >=0.2.3-0 <0.3.0-0 || …`），因为 node-semver 只有在范围里**点名了同一个 major.minor.patch 元组**且该比较符自身带预发布标签时才放行预发布——`^0.2.2-0` 接受 `0.2.2-rc.1` 却静默拒绝 `0.2.3-rc.1`。

不启动也能验证：

```bash
dsh --profile web --dump-config | grep -A1 -E 'id: compaction-basic|id: compaction-lcm'
```

## 设计笔记

- **日志是真相，checkpoint 是视图。** checkpoint 从不销毁 agent 再也够不到的信息——正因如此本后端能比纯摘要式压得更狠。
- **锚点是一张枚举清单，不是一句请求。** 让模型在写散文时“保留重要字符串”能留住约 40%；让它一行一条地列出每个标识符能留住约 74%。实测，见 [bench/REPORT.md](bench/REPORT.md)。
- **指针密度胜过摘要密度。** 业界的测量收敛到同一点（Anthropic 的 just-in-time context、Letta 的 filesystem-as-memory、memory-bench 的 agentic grep）：让模型能重读原文的收益，大于把原文塞进摘要里的收益。
- **两个时钟，不是一个。** 软目标决定何时不再**开**新叶，硬上限约束已经在跑的那一个——没有任何预算能中断它。缺了软层，一个在剩 5 秒时被批准、要跑 17 秒的叶会把上限顶穿 12 秒。
- **空闲续跑。** 一次 sweep 在软目标上停下时，会话仍在阈值之上；以前只有下一次 `agent/pre-step`（也就是操作者再敲一句）会接上它。现在 `idle` 时也会跑一轮同样受全部闸门约束的 pass。

## 局限

- **成本随叶数线性增长。** 见上面的 7.95× 毛 token / 2.08× 等价价。这是本设计的主要代价，`leafSpanTokens` 是唯一的旋钮。
- **每个叶都要重发固定前缀。** 系统提示不在叶里重放（那会让每个叶都付一遍），但指令与前缀缓存槽仍然每次都要付。
- **语义检索需要外部端点。** 默认关闭，没有端点时纯词面可用且成本为零。
- **确定性降级正文可读性差。** 它保留原文行并带 `seq` 指针，所以信息不丢、`lcm_expand` 可达，但它不是摘要。重试时的上限翻倍已把降级率从 27.3%（小跨度）往下压。
- **删除本 bundle 即恢复原状。** 不改任何出厂文件；移除后门与引擎，原组合自动回来。
