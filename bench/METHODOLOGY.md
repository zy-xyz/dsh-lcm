# Benchmark methodology

这份文档定义 dsh-lcm 的测量口径。结构与断言方式沿用 [lcm-x 的 `benchmarks/METHODOLOGY.md`](https://github.com/zy-xyz/lcm-x)，因为目标之一就是和它可比；差异点全部单列在 §6。

它描述**方法**，不描述结论。结论在 [`bench/REPORT.md`](bench/REPORT.md)。

## 1. 两层，测的不是同一件事

### Layer 1 — 检索质量

**问的是：agent 只记得一个字符串或一个自然语言问题，能不能把承载它的那段历史捞回来。**

- 数据集：`LongMemEval_S`，HuggingFace `xiaowu0162/longmemeval`，revision `2ec2a557f339b6c0369619b1ed5793734cc87533`（pin 死）。500 题，全部有非空 `answer_session_ids`。
- 隔离：**每题一个全新的内存 session**（`bench/longmemeval.mjs`）。跨题不共享任何状态。这是公平性契约，和 lcm-x 的 per-question `tempfile` store 对应。
- 查询：METHODOLOGY 规定用**问题原文**。我们照做，并额外报一个 `tokenOr` 变体（分词、去停用词、OR 成一条正则）—— 因为 lcm-x 自己的 `fts` 臂就是这么构造查询的，不这样构造就没法比。两张表都报，标注清楚哪张是 METHODOLOGY 口径。
- 标注：`answer_session_ids`，session 级。**没有 turn 级标注，所以我们不报 tR@k** —— 编一个出来没有意义。
- 指标：recall@1/5/10/50、MRR、NDCG@10（binary relevance，完整 IDCG）。

### Layer 2 — 端到端判分

**问的是：压缩之后，模型还能不能把问题答对。** 这一层才是决定性的 —— Layer 1 的 recall 高不代表答得对，行业里几篇独立工作（Letta、memory-bench、SUMER）都在这个点上汇合。

四个 arm：

| arm | 上下文 | 测什么 |
|---|---|---|
| `full-context` | 整段 haystack | 天花板 |
| `basic-oneshot` | dsh 自带压缩的 checkpoint | 基线 |
| `lcm-oneshot` | 本项目的 checkpoint | 摘要质量 |
| `lcm-agentic` | 本项目 checkpoint + `lcm_search`/`lcm_expand` | **架构价值** |

判分：模型判分（披露 judge 模型名）+ 纯字符串包含判分（零模型、100% 可复现）**两个都给**，不许只挑好看的那个。

## 2. 公平性规则

沿用原项目的三条，逐条说明我们怎么落：

1. **adapter 只能看到 harness 给每个 provider 的同样东西** —— session 消息 + 查询。不许看 `answer`、不许看 `answer_session_ids`、不许按数据集特征特判。落地：`bench/longmemeval.mjs` 的答题路径只拿到渲染后的 session 文本。
2. **查询用的 session id 必须不在 haystack 里** —— 原项目这条是防 `lcm_recall` 的 scope prior 靠「同会话归属」偷偷提权。我们**没有 scope prior**（`src/search.js` 里只有 recency tiebreak，没有 session 归属加权），所以这条不适用；但 recency tiebreak 保留并存，那是真实生产行为，不当作 harness artifact 抹掉。
3. **单次检索载荷，不许 agentic 再展开**（Layer 1 内）—— Layer 1 只调用一次 `searchSession`，不许失败后改写查询重试。Layer 2 的 `lcm-agentic` arm 是**故意的例外**，因为它测的就是多轮检索的价值；两支分开报，不混。

## 3. 配置

| 轴 | 取值 |
|---|---|
| 嵌入（向量臂） | OpenAI 兼容端点，`text-embedding-qwen3-vl-embedding-8b`，4096 维；默认**关闭** |
| 排序 | `seq` / `score` / `density`（词面），`vector` / `hybrid`（需嵌入） |
| 答案 / 判分模型 | 每份结果文件里写明具体 id |

默认关闭嵌入是刻意的：让任何拿到仓库的人在**没有 API key、没有网络**的情况下也能复现词面数字。

## 4. 复现

```bash
# Layer 1（词面，零依赖、零网络）
curl -L -o data/longmemeval_s.json \
  'https://hf-mirror.com/datasets/xiaowu0162/longmemeval/resolve/2ec2a557f339b6c0369619b1ed5793734cc87533/longmemeval_s'
node bench/longmemeval.mjs data/longmemeval_s.json --rank all --limit 50
node bench/longmemeval.mjs data/longmemeval_s.json --rank all          # 全 500 题

# Layer 1（向量臂，需要端点）
node bench/longmemeval.mjs data/longmemeval_s.json --rank vector --limit 100

# Layer 2
node bench/layer2-qa.mjs data/longmemeval_s.json --limit 100
```

`--limit N` 只跑前 N 题，用于冒烟；**报告里必须写明实际 n**。

## 5. 必须披露的东西

每份结果文件都要写：数据集 revision 与文件 sha256、实际 n、逐类型的 n、模型 id（answerer / judge / embedding 分别写）、有没有截断、降级次数。

少一项，那个数字就不算数。

## 6. 与原项目的差异（不是偏离，是不同问题）

| | lcm-x | dsh-lcm | 为什么 |
|---|---|---|---|
| 数据规模 | 500 题 | 500 题 | 同 |
| 检索单元 | 对话 chunk / session 摘要 | 事件（一条消息一个事件） | 我们的日志粒度就是事件，seq 指针指向事件 |
| 嵌入 | FastEmbed `bge-small-en-v1.5`（floor）/ `voyage-context-3` | 可选 OpenAI 兼容端点，默认关闭 | 不引入本地模型依赖 |
| turn 级指标 | 报（有逐 turn 标注） | **不报**（LongMemEval_S 没有逐 turn 标注） | 不编 |
| 存储 | SQLite + 向量表 | append-only 日志 + 可选磁盘向量缓存 | 日志本身就是存储 |
| 原项目的 scope prior | 有（所以需要合成 session id 防提权） | 无 | 少一个作弊面 |

## 7. 已知的坑

- **同一 prompt 重跑得到逐字节相同的回复**（网关缓存）。所以「跑 3 次取均值」在这套仪器上是假重复，N=1。
- **命中数不随输出上限单调**：同一跨度，输出上限 1 500 → 10/24、3 000 → 4/24、8 000 → 20/24。只有同上限横向比较、以及自然收尾时的绝对值有意义。
- **模型会退化**：有一次 `lcm` 臂把同一句话重复 30+ 次。单次调用不是结论。
- **`max_tokens` 是否执行取决于路由**，不取决于通道：`deepseek-v4-flash-auto` 忽略，`balanced-lite` / `best` 执行。跨路由数字不可比。
- **不要走 MCP 通道做基准**：约 60 秒硬截止会杀掉整个臂，之前一次 basicplus 臂因此零数据。用 `bench/llm.mjs`（直连 OpenAI 兼容 HTTP）。
