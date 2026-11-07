# SESSION-STATE —— 交接/压缩锚点

> 写于 2026-11-07 深夜。**任何后续会话先读这个文件**，再读 bench/REPORT.md。
> 所有数字都可用仓库内脚本复现，不要相信本文件以外的口头叙述。

## 目标
团队模式、领导者不做执行。优雅实现 / 上传 GitHub / **不能比原版 lcm 更差** / **比较方法参考原项目 METHODOLOGY.md** / **不能比 dsh 自带压缩更差** / 遵循验收标准。

**成本不是判据**（用户明示：成本不需要压制，成本相关的也不需要测）。
**先小规模验证，确认没问题再跑大批量**（用户明示）。

## 仓库
https://github.com/zy-xyz/dsh-lcm ｜ 版本 **0.4.2** ｜ **76 测试全绿**
本地：`/home/agent/workspaces/lcmx-study/dsh-lcm`
验收标准：`/home/agent/workspaces/lcmx-study/ACCEPTANCE-dsh-lcm.md`
方法论（照原项目结构写的）：`bench/METHODOLOGY.md`

## 一句话现状
**保真这一门过了（lcm 摘要把 3.0–3.5 倍逐字事实交给模型，达到模型复用上限的 75%，basic 20%）；外部基准（LongMemEval_S）词面臂 sR@5 0.774 vs lcm-x 的 fts 0.20；向量臂小样本 sR@5 0.850。真装载需用户点头。**

## 唯一可采信的保真指标
类型分组逐字召回（`bench/qa-recall.mjs`），输出上限 8000，全臂 `stop`：

| 语料 | 跨度 | basic | lcm | 天花板 |
|---|---|---|---|---|
| `s` | 4302 tok | 2/14 = 14.3% | **7/14 = 50.0%** | 未测 |
| `c2` | 8065 tok | 4/24 = 16.7% | **15/24 = 62.5%** | **20/24 = 83.3%** |

## 外部基准（照 METHODOLOGY 的 Layer 1）
LongMemEval_S 500 题，pin revision `2ec2a557`，每题全新 store：

| 查询构造 | sR@5 | sR@10 | sNDCG@10 |
|---|---|---|---|
| 问题原文（METHODOLOGY 原样） | 0.002 | 0.002 | 0.001 |
| tokenOr（与 lcm-x 的 fts 同构造） | **0.774** | **0.874** | **0.602** |
| lcm-x 的 `fts` 臂 | 0.20 | 0.36 | 0.204 |

问题原文那行 499/500 零命中，是**查询形状不匹配**，不是检索质量 —— 两张表都报。

## 向量臂（小规模验证，n=20，未放大）
热缓存 sR@5 0.850 / sR@10 0.950 / sNDCG 0.865；冷缓存 0.750 / 0.850 / 0.765。
**n=20 不足以排序方案**（同 20 题上 tokenOr.score 是 0.900，反而更高）。

## 可恢复性（架构级，不靠 benchmark）
生产 436 194 tok 跨度：摘要只携带 12.5% 锚点，`lcm_expand` 逐字取回 **21/21，0 丢失**，模型可得 **100%**。

## 检索可达性（三份真实压缩日志，density 默认）
跨日志均值 recall@1 **0.730** / @5 **0.969** / MRR **0.831** / NDCG@10 **0.870**；时间序 0.382 / 0.941 / 0.628 / 0.711。
显著性：log1 9:2 p=0.065（边缘）、log2 6:5 p=1.0（持平）、log3 18:2 p=0.0004。**不是三份都显著。**

## 仪器事实（别再重学）
1. 同一 prompt 重跑 → **逐字节相同**（网关缓存）。跑 3 次是假重复，N=1。
2. 命中数**不随输出上限单调**：c2 全跨度 1500→10/24、3000→4/24、8000→20/24。
3. `lcm` 臂在 8000 上限下退化过两次（重复短语 30+ 次）。单次调用不是结论。
4. `max_tokens` 是否执行**取决于路由**：`deepseek-v4-flash-auto` 忽略，`balanced-lite`/`best` 执行。
5. **`--limit N` 不是分层抽样**：LongMemEval_S 按题型成组存放，`--limit 20` 全是 single-session-user。必须用 `--sample N`。
6. 输出文件名现在带作用域（`-sampleN`/`-limitN`），部分跑批不会覆盖全量结果。

## 已修的真 bug（都带回归测试）
1. `surfaceOp` 写成 `{op,start,end}` → harness 要 `{op,startSeq,endSeq}`；插件曾从未成功压缩过一次（0.2.2）
2. `compactNow` 引用越界 `spec` → `/compact` 必抛 ReferenceError（0.2.2）
3. `session.events[seq]` 错位 → recall/search/deriveDag 全部查不到（0.2.3/0.2.4）
4. 锚点清单排在末节 → 截断时被砍光（0.2.7）
5. `retrieval.mjs` 把 rank 加了两遍 → 排序结论一度是反的（0.2.8）
6. 指令自称「最后一节」而骨架早已把锚点提到第一节（0.3.0）
7. `compose.test.js` 用包名匹配引擎行，改名后匹配到 0 条，断言反而「通过」（0.3.0）
8. 嵌入批处理**整批失败**：一条毒文本拖垮整道题（实测 1–3/20）→ 改为二分定位 + 单条降级（0.4.2）
9. `--sample 3` 验证跑覆盖了 500 题结果文件（17k 行删除）→ 输出名带作用域（0.4.2）

## 被实测否掉的想法
- **给叙述节加「合计不超过 20 行」上限压成本** → `s` 语料 7/14 掉到 3/14。已回滚，测试留了反向断言。
- **加「别压太狠」的下限条款** → 31k haystack 上输出 1927 → 1881 token，无实质变化。模型不是被预算逼着压，是自己判断可以压。

## 行业对齐（`RESEARCH-INDUSTRY.md`）
五条主线（Anthropic context engineering / Letta filesystem-as-memory / memory-bench agentic grep / SUMER 目标导向搜索 / ACON 失败驱动优化指引）在一点汇合：**压缩是有损的，赢的是保留轻量指针 + 运行时按需取回**。我们的架构正站在这里。

已做的对齐动作：① 锚点自带 `(seq N)` 指针（0.4.1，归因 3.06ms/1200 事件）② 零命中给可执行建议 + 工具描述教查询形状（0.4.1）③ Layer 2 四臂基准（在建）

## 未完成
1. **G0 真装载**（`dsh plugin add` + 重启 dsh）—— 需用户点头；装进 profile 会 disable `compaction-basic`
2. Layer 2 判分链路有缺陷（judge 返回空串被记未判、fetch failed 无重试）—— 修好后才能跑 20 题
3. 向量臂放大到 `--sample 100`（冷缓存约 60 分钟，热约 1.5 分钟）
4. ACON 式「用失败配对反向优化摘要指引」—— 依赖 2
5. 跨会话检索（`session_scope`）—— P1

## 网络
**拉取优先用自建镜像** `git.acezy.top`（前缀 + 完整原 URL）：clone 1.20s / raw 1.18s / tarball 1.62s。**不要**用 `github.com/OWNER/REPO/raw/...` 形式（15s 超时或 404）。
**推送必须直连** + `-c http.version=HTTP/1.1`（HTTP/2 报 framing 错误）。代理 `192.168.2.121:7890` 不可用。

## 嵌入端点
`http://10.126.126.3:1234/v1`，`text-embedding-qwen3-vl-embedding-8b`，4096 维，32 条 981ms，无鉴权。
**已知缺陷**：对特定文本稳定返回 400 `invalid_type expected number received nan`（`import x from 'rn-maps';` 失败，前置空格即成功）。已按单条降级。
