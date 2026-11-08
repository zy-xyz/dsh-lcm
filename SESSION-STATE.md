# SESSION-STATE —— 交接/压缩锚点

> 写于 2026-11-08 凌晨。**任何后续会话先读这个文件**，再读 bench/REPORT.md 与 docs/ACCEPTANCE.md。
> 所有数字都可用仓库内脚本复现，不要相信本文件以外的口头叙述。

## 目标
团队模式、领导者不做执行。优雅实现 / 上传 GitHub / **不能比原版 lcm 更差** / **比较方法参考原项目 METHODOLOGY.md** / **不能比 dsh 自带压缩更差** / 遵循验收标准 / **验收标准不能降低**。

成本不测（用户明示）。先小规模验证再放大（用户明示）。

## 仓库
https://github.com/zy-xyz/dsh-lcm ｜ **0.4.2** ｜ **100 测试全绿**
关键文档：`docs/ACCEPTANCE.md`（门禁表）、`bench/REPORT.md`（26 节实测）、`bench/METHODOLOGY.md`（照原项目结构）、`RESEARCH-INDUSTRY.md`、`docs/G0-RUNBOOK.md`（怎么在隔离 profile 里复现 G0）

## 一句话现状
**G0 已用真引擎真会话跑通；G0.2/G0.3/G0.4/G1/G2.6/G2.8/G3/G4/G5/G6 全绿；G2.4 仍记不达标（但 basic 同样不达标，本门不区分后端）；G2.5 按用户指示未测。**

## G0 是本轮最大收获（它抓到的东西比门禁本身重要）
用 headless 模板开隔离 profile（`dsh --profile lcmhead --from-default-profile headless`）装插件跑真任务。**没有碰用户的 web profile。**

会话日志实测两次完整压缩（`compaction/start|summary|end` + `surfaceOp replace 8-11 / 24-31`），checkpoint 858 / 963 字符，锚点真的带 `(seq N)`。

**它抓到：插件在此之前从未在真实 dsh 会话里成功压缩过一次。** 真实 `Session` 有 `log` + `snapshotEvents()`，**没有 `events`**；6 处读 `session.events` 全 undefined，第一次自动压缩就抛 `Cannot read properties of undefined`，而错误被 `continuing the turn` 吞掉。100 个测试全绿也拦不住 —— 所有夹具都有 `events`。

## 由 G0 牵出的三个健壮性修复（都有测试）
1. **空摘要**：模型只返回 reasoning 无 text → `emptySummaryRetries`（默认 2）同 prompt 重试；`max-tokens` 不重试。
2. **推理吃光预算**：reasoning 优先后端把预算全花在思考上 → 无 text 的 `max-tokens` 预算翻倍一次，**instruction 里的上限同步重建**（否则告诉模型 512 却允许 1024）。
3. **压不能缩小的跨度**：引擎会去压刚生成的 checkpoint（428 tok，预算钳到 512）→ `selectCompactableRange` 加 `minTokens` 守卫，自动路径传 `summaryFloorTokens`。修复后真引擎日志里 `span=1` 出现 **0** 次。

## 保真（唯一可采信的口径）
类型分组逐字召回，输出上限 8000 全臂 stop：

| 语料 | basic | lcm | 天花板 |
|---|---|---|---|
| `s`（4302 tok） | 2/14 = 14.3% | **7/14 = 50.0%** | 未测 |
| `c2`（8065 tok） | 4/24 = 16.7% | **15/24 = 62.5%** | **20/24 = 83.3%** |

## 外部基准（LongMemEval_S，照 METHODOLOGY Layer 1）
500 题、pin revision、每题全新 store：

| 查询构造 | sR@5 | sR@10 | sNDCG@10 |
|---|---|---|---|
| 问题原文（METHODOLOGY 原样） | 0.002 | 0.002 | 0.001 |
| tokenOr（与 lcm-x `fts` 同构造） | **0.774** | **0.874** | **0.602** |
| lcm-x `fts` 臂 | 0.20 | 0.36 | 0.204 |

## 一条完整的 agentic 轨迹（这是架构的实证）
150k haystack → **1 669 tok checkpoint（预算的 10%，且不含答案）** → 模型调用 `lcm_search({"pattern":"graduate|degree"})` **一次** → 命中 seq 530 → 答对，两个判分器一致。
模型写的是 `a|b` 交替而不是整句 —— 这正是 0.4.1 改工具描述与零命中提示想让它做的事。**描述变了，pattern 变了，这是因果不是相关。**

## 被实测否掉的方向
1. **叙述节 ≤20 行上限**（为压成本）→ `s` 语料 7/14 掉到 3/14。已回滚。
2. **「别压太狠」的下限条款** → 31k 上 1927 → 1881 token，无实质变化。
3. **分片摘要**（n=1 时看似能保住整段丢的事实）→ n=3 复现后 **A 1/3、B 1/3**，且**承载 gold 那一片也只保住 0/5**。分片贵 3.5 倍且不更准。
   附带发现：整段臂的输出 **56% 是隐藏 reasoning**（7264/12953），可见摘要只有 5689 —— 「模型写太短」要修正为「它在花大预算思考」。

## 仪器事实（别再重学）
1. 同一 prompt 重跑 → 逐字节相同（网关缓存）。N≠重复。
2. 命中数**不随输出上限单调**。只有同上限横向比较和 `stop` 绝对值有意义。
3. **`--limit N` 不是分层抽样**：数据集按题型成组，必须用 `--sample N`。输出文件名已带作用域，部分跑批不会覆盖全量结果。
4. `max_tokens` 是否执行取决于**路由**。`balanced-lite` 是别名，一次 run 会落到 5 个后端。
5. **嵌入端点有输入敏感缺陷**：特定字符串稳定 400 `invalid_type expected number received nan`。已按单条二分降级。

## 未完成
1. **Layer 2 四臂 20 题**（在跑，ETA 数小时）。已确认 `lcm-agentic` 真调用工具、judge 空串问题已修
2. **向量臂放大**到 `--sample 100`（热缓存 1.5 分钟）
3. ACON 式「用失败配对反向优化摘要指引」—— 依赖 2
4. 跨会话检索（`session_scope`）—— P1

## 网络
拉取优先 `https://git.acezy.top/` + 完整原 URL（clone 1.2s）。**不要**用 `github.com/OWNER/REPO/raw/...` 形式。推送必须直连 + `-c http.version=HTTP/1.1`。

## 嵌入端点
`http://10.126.126.3:1234/v1`，`text-embedding-qwen3-vl-embedding-8b`，4096 维，32 条 981ms。
