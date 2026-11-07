# 行业怎么做的 —— 与 dsh-lcm 的对齐和差距

> 2026-11-07 调研。目的不是抄，是校准：我们的架构选择在业界处于什么位置，哪些是该补的、哪些是我们已经做对的。
> 每条都标了对 dsh-lcm 的具体动作，没动作的条目不留。

## 一句话结论

业界五条独立主线在同一个点上汇合：**压缩本身是丢信息的，赢的是「保留轻量指针 + 运行时按需取回」。**
dsh-lcm 的架构（append-only 日志 + seq 指针 + `lcm_search`/`lcm_expand`）正站在这个点上；
差距不在架构，在**指针的密度**和**失败回路的闭合**。

---

## 1. Anthropic：context engineering 与 compaction

来源：[Effective context engineering for AI agents](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)

- 把 context 当**有限注意力预算**，不当代价问题。引 Chroma 的 *context rot*：token 变多，模型从上下文里准确取回信息的能力**系统性下降**，所有模型都有，只是坡度不同。
- 两大杠杆：**compaction**（接近窗口上限时摘要后重开）与 **just-in-time 检索**（不预加载数据，只保留轻量标识符 —— 文件路径、已存查询、链接 —— 运行时用工具按需取回）。
- Claude Code 的做法：compaction 保留架构决策、未解决的 bug、实现细节，丢掉冗余工具输出；重开后带上**最近访问的五个文件**。

**对 dsh-lcm 的动作**
- ✅ 架构已对齐：我们就是 just-in-time（`(seq N)` 指针 + 两个取回工具）。
- ⬜ **指针密度不够**：checkpoint 有锚点值但**没有对应的 seq**，模型得先 `lcm_search` 猜一次才能 `lcm_expand` —— 两次往返且第一次可能失败。已派子代理做「锚点自带 seq 指针」（事后确定性归因，不动摘要输入以保住 KV cache）。
- ⬜ 「最近访问的五个文件」我们没有对应物。候选：checkpoint 里加一节「最近触碰的路径」，由日志侧统计而非模型生成。

## 2. Letta：文件系统当记忆，打赢专用记忆工具

来源：[Benchmarking AI Agent Memory: Is a Filesystem All You Need?](https://www.letta.com/blog/benchmarking-ai-agent-memory)

- 只给 agent 一套文件工具（`grep` / `search_files` / `open` / `close`），LoCoMo 上 GPT-4o mini 拿到 **74.0%**，高于 Mem0 自报的最高 68.5%。
- 原因不是检索算法更好，是**agent 会用这些工具**：文件操作在训练数据里密集出现；agent 能自己改写查询（把「Calvin 遇到挫折时怎么保持动力」改成「Calvin motivation setbacks」）并**多轮迭代**直到找到。
- 结论：**agent 的能力 > 工具的内部机制**。知识图谱之类的复杂结构可能更强，但更难被模型用对。

**对 dsh-lcm 的动作**
- ✅ 我们的工具面**故意小**：两个工具、参数简单、描述里写清何时用。这是这个结论支持的选择。
- ⬜ 没有验证过「模型能不能用对」。**这正是 Layer 2 基准要回答的**（已派子代理建 `bench/layer2-qa.mjs`，四个 arm 含 `lcm-agentic`）。
- ⬜ 工具描述里没教**改写查询**。我们的 `lcm_search` 是正则，模型照着问题原样搜基本零命中（实测 500 题里 499 题零命中）。候选动作：描述里加一句「先拆成关键词再搜，不要贴整句问题」。

## 3. memory-bench：agentic grep vs 一次性检索

来源：[iwe-org/memory-bench](https://github.com/iwe-org/memory-bench)

- LOCOMO 652 题：一次性检索 0.7515 vs agentic 文件系统基线 **0.8113** —— grep 领先 6 个点，一次性只在效率上赢。
- HotPotQA 300 题：0.90–0.91 vs 0.9033 —— **打平**，但一次性便宜 2.4×、快 5×。
- 注意这个对照的诚实之处：它没有宣布 agentic 全面胜出，而是分场景给结论。

**对 dsh-lcm 的动作**
- ✅ 我们两条路都有：checkpoint 一次性给（便宜），`lcm_search`/`lcm_expand` 迭代取（贵但对）。**这正好是这个结论要的形状。**
- ⬜ 但从未测过「一次性 vs 迭代」的差。Layer 2 的四个 arm（`basic-oneshot` / `lcm-oneshot` / `lcm-agentic` / `full-context`）就是为了量这个差。

## 4. SUMER：目标导向的搜索打赢目标无关的压缩

来源：[Goal-Directed Search Outperforms Goal-Agnostic Memory Compression](https://arxiv.org/html/2511.21726v1)（arXiv 2511.21726）

- 论点：压缩是**有损**的，而任何预定义的压缩算法都只能适配某类数据分布；压缩时不知道未来要问什么，所以必然丢掉对某个下游问题关键的信息。
- 做法：不压缩，直接在原始记忆上做**目标导向搜索**，用 RL 训练 agent 学会用 search/inspect/answer 三个工具。LoCoMo 上 7B 模型超过所有压缩方案**和**全上下文基线，比前 SOTA 高 **43%**。

**对 dsh-lcm 的动作**
- ✅ 架构上我们**就是**这个结论的实现：日志不压缩（append-only，原文永远在），压缩的只是**视图**（checkpoint）。
- ✅ 这解释了为什么我们的「可恢复性 100%」不是巧合：那不是我们做得好，是架构选对了。
- ⬜ 但 checkpoint 的内容选择仍是**目标无关**的（压缩时不知道未来要问什么）。这是理论上的下界，不追。

## 5. ACON：用失败案例反过来优化压缩指引

来源：[ACON: Optimizing Context Compression for Long-horizon LLM Agents](https://arxiv.org/abs/2510.00615)（ICML 2026）

- 方法核心：构造**配对轨迹** —— 同一条轨迹，全上下文成功、压缩后失败。让强模型分析失败原因，据此**改写压缩指引**，再蒸馏进小模型。
- 结果：峰值 token 降 26–54%，任务表现基本保住；蒸馏后仍保留 >95% 准确率。

**对 dsh-lcm 的动作**
- ⬜ **这是最该抄的方法论，也是我们现在最缺的一环。**
- 我们的 `SUMMARY_SKELETON` 和 `buildInstruction()` 是**手写**的，靠「先写完再测」迭代（20 行上限那次就是这么发现该回滚的）。ACON 的做法是：拿失败案例当输入，让模型写出为什么丢了东西，再改指引。
- 具体落地：Layer 2 跑出「`full-context` 答对但 `lcm-oneshot` 答错」的题，这些就是配对轨迹。逐条看错因，归纳成指引条款。**这比再手调一轮模板有依据。**

---

## 汇总：五个动作

| # | 动作 | 依据 | 状态 |
|---|---|---|---|
| 1 | 锚点自带 `(seq N)` 指针 | Anthropic just-in-time | 进行中 |
| 2 | Layer 2 四臂端到端基准 | Letta / memory-bench | 进行中 |
| 3 | `lcm_search` 描述里教「拆词再搜，别贴整句」 | Letta：agent 得会用工具 | 待做 |
| 4 | 用 Layer 2 的失败配对反向优化摘要指引 | ACON | 依赖 2 |
| 5 | checkpoint 加「最近触碰的路径」一节 | Anthropic / Claude Code | 待评估 |

## 不该抄的

- **知识图谱 / 专用记忆服务**：Letta 与 memory-bench 都显示，简单文件类工具配上会用的 agent 就够，复杂结构增加的是模型的负担不是能力。
- **向量当主路**：memory-bench 的 HotPotQA 上，一次性检索 + 2.4× 成本优势才打平；我们的向量层只作为**可选**补充，默认关闭，这个定位是对的。
- **用 benchmark 分数反推架构**：SUMER 那篇对「为 benchmark 调 prompt/架构」的批评成立。我们的主张是结构性的（原文永远在、指针可回溯），benchmark 只是佐证。
