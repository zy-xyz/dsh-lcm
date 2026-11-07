# SESSION-STATE —— 交接/压缩锚点

> 写于 2026-11-07，上下文将满。**任何后续会话先读这个文件**，再读 bench/REPORT.md。
> 所有数字都可用仓库内脚本复现，不要相信本文件以外的口头叙述。

## 目标（当前版本）
团队模式、领导者不做执行。优雅实现 / 上传 GitHub / **不能比原版 lcm 更差** / **不能比 dsh 自带压缩更差** / 遵循验收标准。

## 仓库
https://github.com/zy-xyz/dsh-compaction-lcm ｜ 版本 **0.2.9** ｜ **57 测试全绿**
本地：`/home/agent/workspaces/lcmx-study/dsh-compaction-lcm`
验收标准：`/home/agent/workspaces/lcmx-study/ACCEPTANCE-dsh-lcm.md`（19 ✅ / 5 ❌）

## 一句话现状
**质量维度不差、可恢复性远胜、成本持平或更低；摘要密度方向不稳（已如实记录）。默认引擎未切换。**

## 关键实测（都可复现）

| 维度 | 指标 | basic | lcm | 结论 |
|---|---|---|---|---|
| 等预算保真（516 tok，N=4） | 锚点命中 | 16.1% | **23.2%** | 不差 |
| 自然长度（N=4–5） | 锚点 / token | 5.0 / 2700 | 5.0 / **2182** | 同保真、少 19% |
| 生成期硬上限 516 | 锚点 | 2.5 | **3.5** | 同成本更高 |
| **类型分组逐字召回**（c2，24 锚点） | 命中 | 4/24 = 16.7% | **9/24 = 37.5%** | **2.25×**（天花板 10/24） |
| 可恢复性（生产 436k 跨度） | 模型可得 | 摘要 12.5% | **100%**，0 丢失 | 架构级 |
| 检索可达性（21 锚点） | recall@5 / MRR | —（无检索） | **0.952 / 0.793** | 新能力 |

## 已修的真 bug（都带回归测试）
1. `surfaceOp` 写成 `{op,start,end}` → harness 要 `{op,startSeq,endSeq}`；**插件此前从未成功压缩过一次**（0.2.2）
2. `compactNow` 引用越界 `spec` → `/compact` 必抛 ReferenceError 被伪装成 busy（0.2.2）
3. `session.events[seq]` 错位（持久化日志首条 header 无 seq）→ recall/search/deriveDag 全部查不到（0.2.3/0.2.4）
4. 锚点清单排在末节 → 截断时被砍光，等预算 0/14（原版 2/14）（0.2.7）
5. `retrieval.mjs` 把 rank 加了两遍 → recall@1 恒为 0，**排序结论一度是反的**（0.2.8）

## 仪器（bench/）
- `span.mjs` 取真实跨度；`anchors.mjs` 去嵌套+分层+去重；`recovery.mjs` 可恢复性
- `retrieval.mjs` 检索可达性（rank: seq/score/**density 默认**）
- `equal-budget.mjs` 纯打分 + `--score` 离线复算；`ab-one.mjs` 单臂运行（支持 `none` 不设上限）
- `qa-eval.mjs` 出题/判分；`qa-recall.mjs` **类型分组逐字召回（最可靠的端到端指标）**
- `llm.mjs` 直连 OpenAI 兼容 HTTP（**不要再用 MCP 通道**：60s 硬截止会杀掉整个臂）

## 已知的仪器/口径坑（别再踩）
- `deepseek-v4-flash-auto` **不执行 `max_tokens`**（要 40 得 654）；`balanced-lite`/`best` 执行
- 不同路由的数字**不可跨表比较**（deepseek vs agnes-3.0-flash）
- `qa-eval` 的"near \"提示语\""问法会让模型在摘要缺该提示语时答 UNKNOWN，即使答案在摘要里 → 用 `qa-recall.mjs` 的分组问法
- 三个 arm 的输出都撞 1500 token 上限，天花板 10/24 是**被 cap 压低**的

## 未完成
1. 把 qa-recall 结果写进 `bench/REPORT.md` §17（数字已在上面）
2. 提高到 3000 token 输出上限重跑 qa-recall，看天花板是否升到 ~18/24
3. `PROOF-BOUNDARIES.md` §6 的检索绝对值仍是 0.2.8 前旧仪器数字，需重出
4. G0 真装载（要重启 dsh，需用户同意）——当前**故意不做**，因为结论是"不切换"

## 下一步优先级
P0 写 §17 + 提高输出上限重测 ｜ P1 跨会话检索（`session_scope`）｜ P3 向量召回（现在不该做）
