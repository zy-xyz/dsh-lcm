# SESSION-STATE —— 交接/压缩锚点

> 写于 2026-11-08。**任何后续会话先读这个文件**，再读 `docs/ACCEPTANCE.md` 与 `bench/REPORT.md`。
> 每个数字都能用仓库内脚本复现，不要相信本文件以外的口头叙述。

## 目标
团队模式、领导者不做执行。优雅实现 / 上传 GitHub / **不能比原版 lcm 更差** / **比较方法参考原项目 METHODOLOGY.md** / **不能比 dsh 自带压缩更差** / 遵循验收标准 / **验收标准不能降低** / **插件要完美适配最新版 dsh**。

成本不测；先小规模验证再放大；不设 max token 上限；思考 token 不计入尺寸。（均为用户明确指示）

## 仓库
https://github.com/zy-xyz/dsh-lcm ｜ **0.6.0** ｜ **136 测试全绿**
关键文档：`docs/ACCEPTANCE.md`（门禁 + 校准更正）、`bench/REPORT.md`（28 节实测）、`bench/METHODOLOGY.md`（照原项目结构）、`RESEARCH-INDUSTRY.md`、`docs/G0-RUNBOOK.md`

## 一句话现状
**能换。** Layer 2 端到端：`lcm-agentic` 70% vs `basic-oneshot` 0%，天花板 75%。只压缩不给检索时两个后端都 0%，这一维打平。契约按 dsh 0.2.2-rc.1 修了 11 处。

## 判决性数字（Layer 2，n=20，LongMemEval_S，judge/answerer 分开披露）

| arm | 模型判分 | 字符串判分 |
|---|---|---|
| `full-context`（天花板） | 15/20 = **75%** | 8/20 = 40% |
| **`lcm-agentic`** | **14/20 = 70%** | **11/20 = 55%** |
| `basic-oneshot`（dsh 自带） | 0/19 = 0% | 1/19 = 5% |
| `lcm-oneshot` | 0/20 = 0% | 0/20 = 0% |

三条口径修正（必须一起读）：① agentic 答案 11/20 含中文，string 列被系统性低估 ② judge 对长答案更宽松（full-context 7 题 string 错但 judge 对）③ oneshot 的 0% 主因是锚点清单吃光输出预算（已改指令）

## 保真（唯一可采信口径）
类型分组逐字召回，输出上限 8000 全臂 stop：`s` 语料 basic 2/14 vs lcm **7/14**；`c2` basic 4/24 vs lcm **15/24**，天花板 20/24。

## 外部基准（LongMemEval_S Layer 1，500 题）
| 查询构造 | sR@5 | sR@10 | sNDCG@10 |
|---|---|---|---|
| 问题原文（METHODOLOGY 原样） | 0.002 | 0.002 | 0.001 |
| tokenOr（与 lcm-x `fts` 同构造） | **0.774** | **0.874** | **0.602** |
| lcm-x `fts` 臂 | 0.20 | 0.36 | 0.204 |

## 已装到 dsh 验证过（`lcmverify` profile，从 shipped 模板重建）
引擎组合后唯一（basic disabled）、`lcm_search`/`lcm_expand` 在请求头 27 个工具里、真压缩落地 0 失败、落盘 `maxTokens` 且无 `targetTokens`、`shadowedTokenCount` 是启发式价、checkpoint 含 `## 用户事实`、收缩重试生效、重试仍超长时**带两个数报错**、压缩后会话可恢复。

## 已修的致命 bug（都带回归测试）
1. `surfaceOp` 写成 `{op,start,end}` → 插件曾从未成功压缩过一次（0.2.2）
2. `session.events` 假设 → 真 Session 没有该属性，**真引擎里从未成功压缩过**；100 个测试全绿也拦不住（0.4.3）
3. `shadowedTokenCount` 用路由价 → token-meter 当影子价扣，**压力阈值永不触发**（0.6.0）
4. `compaction/summary` 写 `targetTokens` → released 校验器拒绝（0.6.0）
5. 摘要失败抛纯对象 → `instanceof LlmError` 判据失效（0.6.0）
6. 缺 `compaction/summary-error` waterfall → image-offload 恢复永不触发（0.6.0）
7. `Config.simplify` 静默丢 9 个键（0.6.0）
8. peer `^0.2.0` 不接受 `0.2.2-rc.1` 预发布（0.6.0）
9. 缺 `toolHistory` → 破坏前缀缓存（0.6.0）
10. 非 system 的 `surface[0]` 被当 system head → 该消息出现两次（0.6.0）
11. 阈值低于不可压缩基线时每步都报错 → 改为「无可压区间」诊断（0.6.0）

## 被实测否掉的方向
- 叙述节 ≤20 行上限 → `s` 语料 7/14 掉到 3/14，已回滚
- 「别压太狠」下限条款 → 1927 → 1881 token，无变化
- **分片摘要** → n=1 看似有效，n=3 复现后 A 1/3、B 1/3，承载 gold 那一片也只保住 0/5；贵 3.5 倍不更准

## 仪器事实
1. 同一 prompt 重跑 → 逐字节相同（网关缓存）。N≠重复。
2. **`--limit N` 不是分层抽样**（数据按题型成组），必须 `--sample N`。输出名带作用域。
3. `max_tokens` 是否执行取决于**路由**；`balanced-lite` 是别名，一次 run 可能落 5 个后端。
4. **`goldIn` 子串匹配对短数字 gold 不可靠**：`8` 命中 `$800`、`10` 命中 `$100`。判可答性要用「压缩→回答→判分」，不能只看子串。
5. 嵌入端点对特定文本稳定 400 `invalid_type expected number received nan`；已按单条降级。

## 未完成
1. **ACON 失败驱动优化的可答性测量**（跑到一半被叫停）——5 题已测：2 题改后可答（e47becba、0ea62687），3 题仍不可答。续跑：`node acon-run.mjs <余下 qid>`
2. 向量臂放大到 `--sample 100`（热缓存约 1.5 分钟）
3. 跨会话检索（`session_scope`，P1）
4. G2.4 净开销仍记 ❌（`basic` 同样 111%，门不区分后端）；G2.5 未测

## 网络
拉取优先 `https://git.acezy.top/`（clone 1.2s）。推送必须直连 + `-c http.version=HTTP/1.1`；`github.com:443` 偶发不可达，重试即可。

## 嵌入端点
`http://10.126.126.3:1234/v1`，`text-embedding-qwen3-vl-embedding-8b`，4096 维。
