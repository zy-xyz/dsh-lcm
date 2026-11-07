# PROOF-BOUNDARIES — 七个互不混用的证明平面

> 本文件只写"读完代码、报告、测试、验收单之后能站住"的结论。每条结论后面是 `文件:行号`。
> 不引用 README 的定性描述当证据；README 的营销段与本文件的冲突处，以代码与本文件的复核记录为准（冲突清单见 §11）。
> 复核口径：一次性写清"这一层到底证了什么"，防止把下层的 PASS 借给上层用。

---

## 0. 一句话结论

当前**能**证明的是四件事：配置面与 basic 对等（单测级）、事务的 surfaceOp 形状与失败闭合正确（测试级）、给定 seq 能逐字取回（真实生产日志级）、给定一个字符串能定位到事件（真实生产日志级，但指标仪器有一处索引偏差，结论偏保守）。

当前**不能**证明的是四件事：摘要比 basic 更好、成本更低（已撤回）、引擎在运行中的 dsh 里跑过一次、可以上生产。

---

## 1. 平面总览

| # | 平面 | 它回答的问题 | 现状 | 一手证据 |
|---|---|---|---|---|
| ① | 配置对等 | 换成这个引擎，配置语义会不会漂 | **已证（单测级）** | `src/config.js` · `test/lcm.test.js` |
| ② | 事务正确 | 压缩真的能 commit 吗 | **已证（测试级）**；运行时未证 | `src/region.js` · `test/region.test.js` |
| ③ | 摘要质量 | 摘要比 basic 更好吗 | **未证**，且方向不稳定 | `bench/REPORT.md` §3–§4 |
| ④ | 可恢复性 | 被摘要丢掉的原文还能拿回来吗 | **已证（生产日志级）** | `bench/recovery.mjs` · `test/recovery.test.js` |
| ⑤ | 检索可达性 | 只记得字符串，能不能找到 | **已证**，但口径要按 §6.3 重读 | `bench/retrieval.mjs` · `bench/REPORT.md` §14 |
| ⑥ | 运行中的引擎（G0） | 它真的被加载、真的压过一次吗 | **未做（有意）** | `ACCEPTANCE-dsh-lcm.md` G0 |
| ⑦ | 生产切换 | 能不能改默认引擎 | **未证 / 明确不做** | `ACCEPTANCE-dsh-lcm.md` §0 · `bench/REPORT.md` §0/§5 |

---

## 2. 平面① 配置对等

### 2.1 它能证明什么

- **键面是 basic 的超集，且未知键直接报错。** 顶层键集合在 `src/config.js:59`（`CONFIG_KEYS = POLICY_KEYS ∪ LCM_KEYS ∪ {modelPolicies, auto}`）声明，`src/config.js:328-330` 对任何不在表里的键抛 `unknown key`。测试覆盖这条拒绝路径：`test/lcm.test.js:65-67`。
- **默认值逐项等同 basic。** 常量在 `src/config.js:30-40`（0.8 / 65536 / 0.16 / 0.12 / 512 / 16384），`src/config.js:90-96` 做继承（`maxTokens` 缺省取 `headroomTokens`），逐项断言在 `test/lcm.test.js:22-31`。
- **预算公式与 basic 同式。** `src/config.js:195-198`（`threshold = floor(min(W·ratio, W−O−B))`、`retain = floor(messageBudget·retainRatio)`）；点位断言 `test/lcm.test.js:85-100`、审计推导点 `test/lcm.test.js:410-427`（W=128000/O=8192 → 54272/19169 等三组）。
- **互斥与边界也照抄。** `retainRatio` 与 `retainTokens` 互斥、`retainRatio < thresholdRatio`（`src/config.js:287-289`、`src/config.js:321-325`；测试 `test/lcm.test.js:57-63`）。
- **静态 Config 声明了全部共享键**（否则严格 loader 会拒），断言在 `test/lcm.test.js:395-408`，实现见 `src/index.js:123-140`。

### 2.2 它不能证明什么

- **不证明"basic 现在就是这么算的"。** 所谓差分测试（`test/lcm.test.js:331-370`）并没有调用 basic 的预算函数（basic 不导出解析器，注释自陈：`test/lcm.test.js:325-330`），它断言的是**本仓库相信的公式**在矩阵上不漂。也就是说：这是"公式一致性"，不是"实现一致性"。
- **不证明跨版本稳定。** basic 升版改公式，这里不会红。
- **不证明 LCM 专有键的含义合理**：`summaryRatio/summaryFloorTokens/checkpointCap` 只有边界断言（`test/lcm.test.js:74-81`），没有"取这个值会得到那个压缩比"的对照。
- **依赖可解析才成立。** 差分测试在 profile 外会 skip（`test/lcm.test.js:332-337`）——换个目录跑，CI 依然全绿但覆盖面少一块。

### 2.3 现状与证据

状态：**已证（单测级）**，且今天在本机跑出 54 passed / 0 skipped（§10）。

证据文件：`src/config.js:83-140`（解析）、`src/config.js:173-217`（spec）、`src/config.js:237-241`（摘要预算）、`test/lcm.test.js:22-155,331-370,395-440`、`CHANGELOG.md:162-178`（审计 D1–D3 的修复记录）。

---

## 3. 平面② 事务正确（真的能 commit）

### 3.1 它能证明什么

- **surfaceOp 形状正确。** 契约要求"恰好三个自有键 `{op, startSeq, endSeq}`"，实现于 `src/region.js:351-355`，断言于 `test/region.test.js:134`（`Object.keys(...).sort() === ["endSeq","op","startSeq"]`）。
- **surface 真的缩小。** `test/region.test.js:129`（替身前后的节点数比较）；测试夹具在每次 append 后把整条日志重放给 harness 自己的 `foldSurface`（`test/region.test.js:58-65`），所以形状写错会在这里炸而不是在生产炸。
- **summary 与替身相邻、start/end 各一次且成对。** `test/region.test.js:137-148`。
- **不缩小就抛，且抛后仍闭合。** 闸门在 `src/region.js:275-276`，测试 `test/region.test.js:153-174`（还断言失败记为字符串 error、只写一条 `compaction/end`）。
- **编译失败会释放锁、不留孤儿 summary。** 失败路径 `src/region.js:137-157`，测试 `test/region.test.js:178-192`。
- **手动 `/compact` 能真跑。** 实现 `src/index.js:391-420`（`retainTokens = 0`，见 `src/index.js:399-401`），往返测试 `test/region.test.js:251-289`。
- **自动触发的阈值与重试语义。** `src/index.js:342-366`（阈值判定、prune 后再测、重试到 `compactionRetries`，超限抛"still above threshold"）。

### 3.2 它不能证明什么

- **不证明真实 harness 的持久化、flush、崩溃恢复。** 夹具的 `session.append` 是测试自己写的（`test/region.test.js:58-65`），它证明"事件序列满足 foldSurface"，不证明真实 session 的落盘与重放。`flush` 在测试里是空函数（`src/index.js:407-409` 的 flush 只在 `compactNow` 链路里，测试桩见 `test/region.test.js:265`）。
- **不证明锁在并发下正确。** `assertCompactionInactive`（`src/region.js:188-201`）是读日志判定的，没有跨进程/跨 turn 的互斥测试。
- **不证明这条结论在 0.2.2 之前也成立——恰恰相反。** `CHANGELOG.md:126-127` 记载："引擎从未成功压缩过任何东西"；`src/region.js:346-350` 的注释更直接：错误的 shape 会在 start/summary 落盘之后才被 foldSurface 拒掉，留下孤儿 summary 并使 surface 无法收缩。所以"事务正确"是 2026-11-07 才成立的结论。
- **工具对安全闸只测了"必须抛"，没测"不该抛时不会抛"**（G1.3 的"不误触"需要 k=1..5 连续压缩，`ACCEPTANCE-dsh-lcm.md:20` 标的是"单测级"）。

### 3.3 现状与证据

状态：**测试级已证，运行时未证**（进 G0 才谈运行）。

证据文件：`src/region.js:99-172`（事务主体）、`src/region.js:248-288`（编译+shrink 定价）、`src/region.js:327-375`（commit）、`test/region.test.js:119-192,251-289`、`CHANGELOG.md:131-142`。

---

## 4. 平面③ 摘要质量

### 4.1 它能证明什么

- **三个臂在两个语料上的点估计存在，且方向相反。** c2（8 065 tok，24 锚点）：basic 38.5%、lcm 51.0%、basicplus 全超时（`bench/REPORT.md:31-37`）；s（4 302 tok，14 锚点）：basic 35.7%、lcm 32.1%、basicplus 50.0%/n=1（`bench/REPORT.md:39-45`）。
- **lcm 在这两个语料上更贵。** c2 上 completion 7 912 vs 5 741，+38%（`bench/REPORT.md:36`，同 `bench/REPORT.md:58`）；原始行数据在 `bench/results/ablation-20261107.json`（`c2`/`s` 两个键，含 `{"arm":"basicplus","error":"timeout"}` 行）。
- **强制枚举锚点会把输出顶到 7–10k、超 60s 工具上限**，这是产品层结论，不是模型偶发（`bench/REPORT.md:60`）。
- **报告自己下了裁决：不换**（`bench/REPORT.md:5-9`、`bench/REPORT.md:62-65`）。

### 4.2 它不能证明什么

- **不能证明"更好"。** n=4/n=2 撑不起结论（`bench/REPORT.md:57`）；basicplus 只有 n=1 却是最高（`bench/REPORT.md:45`、`bench/REPORT.md:59`）。
- **不是引擎级对比。** 三臂喂的是三条**字符串 prompt**，没有跑任何引擎代码（`bench/REPORT.md:20`、`bench/REPORT.md:74-76`；同结论写在 `CHANGELOG.md:187-188`）。所以这一节测的是"prompt 加上枚举指令会不会多抄锚点"，不是"这个 backend 的 compile() 产出的摘要更好"。
- **不能证明压缩比更优或成本持平。** v1 的 0.98×/同样成本已撤回（`bench/REPORT.md:18-19`）。
- **不能外推到别的语料/别的模型。** 语料规模被 basicplus 的超时反向决定（`bench/REPORT.md:39`）。

### 4.3 现状与证据

状态：**未证**；v1 的六项全部作废（`bench/REPORT.md:11-22`）；README 也把这条标成 `not established`（`README.md:34-35`），验收单标 ❌（`ACCEPTANCE-dsh-lcm.md:26-27`）。

证据文件：`bench/REPORT.md:11-22,29-60,67-68`、`bench/results/ablation-20261107.json`、`bench/anchors.mjs:21-24,43-57`（锚点仪器的去嵌套/分层/去重三个修法）、`README.md:34-35`。

---

## 5. 平面④ 可恢复性

### 5.1 它能证明什么

- **生产跨度上，摘要漏掉的锚点全部能从日志逐字取回。** 787 节点 / 436 194 token 的跨度，生产摘要实际携带 3/24（12.5%），`recall` 取回 21/21，可获合计 24/24，彻底丢失 0（`bench/REPORT.md:84-92`；脚本 `bench/recovery.mjs:72-110`；同数据的测试版本 `test/recovery.test.js:95-146`）。
- **取回走的是真投影，不是 JSON 兜底。** 两条路都设了防空过断言：`test/recovery.test.js:137-140`（禁止出现 `{"content"`）与 `bench/REPORT.md:120-121` 的文字说明。
- **seq 寻址本身被修正确了。** 持久化日志首条是无 `seq` 的 header，直接下标会整体错位一格；修复为 `resolveEventAt`（`src/events.js:40-49`，优先 `session.eventAt`，否则按事件自身 `seq` 建缓存索引），回归在 `test/recovery.test.js:33-60`，DAG 侧同 bug 见 `src/summarize.js:240-246` 与 `test/recovery.test.js:149-162`。
- **指针是"可发现"的，不只是"存在"。** checkpoint 文本头带 `seqs a-b` 与 "restore with lcm_expand"（`src/index.js:274`），正文首段是 `RECALL_GUIDE` 常量（`src/compiler.js:231-232`，经 `src/compiler.js:264-274` 的 `frameCheckpoint` 落到每条 checkpoint）。

### 5.2 它不能证明什么

- **不证明模型会去用。** 这是行为问题；平面④只证"指针在、取回对"。报告自己划了这条界（`bench/REPORT.md:123-131`）。
- **不证明 basic 找不回。** 准确表述是"可发现的可恢复性 12.5% → 100%"；dsh 本身有 `session_search`，差别是 basic 的 checkpoint 不指路（`bench/REPORT.md:125-131`）。
- **不证明任意日志都成立。** 生产样本只有两份日志：`d45c83f5`（`bench/REPORT.md:147`）与 `session-65bd`（`bench/REPORT.md:156`）；不是 held-out 集（`bench/REPORT.md:169`）。
- **不证明预算内的完整性。** `recall` 有 `maxRecallTokens` 上限（`src/recall.js:198-231`，默认 16 000 见 `src/recall.js:21`），超了会截断并记 `skipped`（`src/recall.js:229-231`）；"21/21 取回"是在 20 000 token 预算下（`bench/recovery.mjs:86`）成立的，不是无界。
- **不证明跨会话可查。** 工具只读 `exec.agent.session`（`src/tool.js:79-83`、`src/tool.js:144-149`），换会话就查不到。

### 5.3 现状与证据

状态：**已证（这一门最硬，也是唯一"架构级"的结论）**；验收单标 ✅ 并注明这是"唯一真正赢的一门"（`ACCEPTANCE-dsh-lcm.md:28`、`ACCEPTANCE-dsh-lcm.md:32`）。

证据文件：`bench/recovery.mjs:56-111`、`test/recovery.test.js:95-146`、`src/recall.js:197-241`、`src/events.js:40-49`、`bench/REPORT.md:84-92,113-121`。

---

## 6. 平面⑤ 检索可达性

### 6.1 它能证明什么

- **从一个字符串出发，时间序排序能定位到含该锚点的事件。** 21 条被生产摘要丢掉的锚点：seq 排序 recall@5 0.905 / @10 0.952 / MRR 0.335（`bench/REPORT.md:149-154`）；第二份日志 22 条：@5 0.955 / @10 1.000 / MRR 0.426（`bench/REPORT.md:156`）。
- **"相关性排序"输了，且这是可记录的负结果。** score（命中行数）@5 0.762、density（长度归一）@5 0.857 但 MRR 0.414（`bench/REPORT.md:153-154`、`bench/REPORT.md:158-165`）；默认因此保持 `seq`（`src/search.js:34`、`src/search.js:104`），并被测试钉住（`test/search-rank.test.js:33-61`，尤其 `:53-57`）。
- **三种排序不改变命中集合本身。** `test/search-rank.test.js:59-61`。
- **本节不调模型**（`bench/retrieval.mjs:10-13`），所以是纯排序质量，不是"模型会不会搜"。

### 6.2 它不能证明什么

- **不能证明自然语言查询可用。** 查询是锚点本身、转义成字面正则（`bench/retrieval.mjs:81-82,94`）；自然语言显著更难，报告明说未测（`bench/REPORT.md:171`）。
- **不能证明 agentic 二次展开下的表现。** 结论限"只读一次 payload"的调用形态（`bench/REPORT.md:165`）。
- **不是 held-out。** 标签来自两次真实压缩的"被丢锚点"（`bench/REPORT.md:141-145`、`bench/REPORT.md:169`）。
- **不能证明生产可用性：@1 与 MRR 的口径被仪器带偏（见 §6.3）。**

### 6.3 必须一起读的仪器偏差（本文件新增，已复算）

- **偏差本身**：`bench/retrieval.mjs:100` 已把 `hitIndex` 换成 1-based（`rank = hitIndex + 1`），`:105` 落盘时又 `+1`，于是存的是 `index + 2`。所有 `at(k)`（`:110`）与 MRR（`:111`）都基于这个偏移值。
- **后果一**：报告里"recall@1 在所有模式下都是 0"（`bench/REPORT.md:170`）不是数据性质，而是**构造性质**——最小可能值是 2。归因（"首个命中总在跨度外"）不成立：实测 21 条里 **8 条的 gold 就是首个命中**（index 0）。
- **后果二**：报告数字整体保守一格。用同一批 rows 复算真实 1-based 指标为 recall@1 0.381 / @5 0.952 / @10 0.952 / MRR **0.581**（报告 0.337）；`bench/REPORT.md:149-154` 的 "recall@5 0.905" 实际对应"前 4 位命中"。
- **后果三**：`bench/retrieval.mjs:112` 的 `ndcgAt10` 与 `recall@10` 恒等（实际输出 0.952 / 0.952）——它算的是 `1/log2(2)=1` 乘以 `rank<=10`，不是 NDCG。报告没有引用这个数（`bench/REPORT.md:149-156` 只列 recall 与 MRR），但脚本会输出，别当成第二个指标。
- **方向结论不受影响**：三个模式在同一偏差下比较，seq 仍优于 score/density（`bench/REPORT.md:153-154`）。受影响的是绝对值，不是排序结论。
- **口径提醒**：本节所有数字来自**未发布的脚本**——`package.json:37-41` 的 `files` 只含 `src`、`cordis.patch.yml`、`README.md`，`bench/` 与 `test/` 不随包发布。外部读者只能在本仓库里复现。

### 6.4 现状与证据

状态：**已证（排序方向 + 可达性量级）**；绝对值按 §6.3 重读。验收单 `ACCEPTANCE-dsh-lcm.md:29`（G2.8 PASS）、`ACCEPTANCE-dsh-lcm.md:30`（G2.8b 负结果已记录）。

证据文件：`bench/retrieval.mjs:91-132`、`bench/REPORT.md:135-171`、`test/search-rank.test.js:33-61`、`src/search.js:100-179`。

---

## 7. 平面⑥ 运行中的引擎（G0）

### 7.1 它能证明什么

- **组合层面只有一个 active compaction 引擎，且是本 backend。** `test/compose.test.js:42-65`：用 boot 的同一纯函数 `composeEntries` 叠 bundle patch，断言 active 引擎数 = 1、`name === "dsh-compaction-lcm"`、`compaction-basic` 被 disabled、`/compact` 保留、`tool-lcm-expand`/`command-lcm-search` 挂载。对应验收 G0.1 PASS（`ACCEPTANCE-dsh-lcm.md:15`）。
- **patch 的内容就是这些行**：`cordis.patch.yml:11-19`（disable basic、insert 引擎 / tool / command）。

### 7.2 它不能证明什么

- **不证明引擎被真的加载**（`require.resolve` 指向 alias 目标，`ACCEPTANCE-dsh-lcm.md:103`）。
- **不证明发生过一次真实压缩**（G0.2）、**不证明 `/compact` 在运行时可点**（G0.3）、**不证明压缩后重启会话不崩**（G0.4）——三条全部 ⬜（`ACCEPTANCE-dsh-lcm.md:16`、`ACCEPTANCE-dsh-lcm.md:33-34`）。
- **不证明与 `bili-compaction-gate` 共存**（G5.1 说 gate 会递归 disable 同名行，`ACCEPTANCE-dsh-lcm.md:188`）。
- **compose 测试也会 skip**：`@deepseek-ai/dsh-app-boot` 不可解析时直接跳过（`test/compose.test.js:23-29`）——"PASS"与"没跑"在 CI 里都是绿的。

### 7.3 现状与证据

状态：**G0.1 通过，G0 其余未做，且是"有意不做"**——装进 profile 就等于切换，与"不换"的裁决矛盾（`ACCEPTANCE-dsh-lcm.md:36-52`，明确写"G0 不是被跳过，是结论不需要它"）。

证据文件：`test/compose.test.js:20-65`、`cordis.patch.yml:1-19`、`ACCEPTANCE-dsh-lcm.md:13-16,33-52,99-107`。

---

## 8. 平面⑦ 生产切换

### 8.1 它能证明什么

- **切换动作是可枚举的**：装包 → bundle patch 关掉 basic → 只剩 lcm（`cordis.patch.yml:1-19`；`package.json:75-79` 声明 `dsh.bundle.patch`）。
- **装与不装的边界是清楚的**：装 = 切换（因为 patch 会 disable basic），所以"留在仓库里当可选 backend"与"装载"是互斥决定（`ACCEPTANCE-dsh-lcm.md:48-50`）。

### 8.2 它不能证明什么

- **不证明切换安全**：G1.2（双挂必须报错）、G2.1/G2.2（触发点与降幅）、G4（热路径阻塞）、G5（共存与升版漂移）、G6（可观测）全部没有运行态数据（`ACCEPTANCE-dsh-lcm.md:23,33-34,174-201`）。
- **不证明开销可接受**：唯一有生产数字的指标是净开销 111.1%（`ACCEPTANCE-dsh-lcm.md:69`、`ACCEPTANCE-dsh-lcm.md:133`，阈值 ≤30%），这一门是 ❌。
- **不证明摘要质量达标**：G2.5/G2.6 ❌（`ACCEPTANCE-dsh-lcm.md:26-27`）。
- **反向也不成立**：不能因为"④可恢复性大幅领先"就推出"该换"。裁决明确按摘要维度否决（`ACCEPTANCE-dsh-lcm.md:46-48`）。

### 8.3 现状与证据

状态：**未证 / 明确不做**。三处文档口径一致：`ACCEPTANCE-dsh-lcm.md:10-11`（裁决：不装载）、`bench/REPORT.md:62-65`（保持 basic 为默认）、`README.md:16-22`（opt-in, not a replacement，并写明 basic 仍是默认引擎）。

证据文件：`ACCEPTANCE-dsh-lcm.md:6-52,57-80,124-156`、`bench/REPORT.md:1-9,62-68`、`README.md:16-35,56-58`、`cordis.patch.yml:11-19`。

---

## 9. 三件已知的跨平面误用风险

### (i) 单测级 PASS ≠ 运行时 PASS

- **史实**：0.2.2 之前引擎"从未成功压缩过任何东西"（`CHANGELOG.md:126-127`），两处致命 bug（surfaceOp 形状、`compactNow` 引用了作用域外的 `spec`，见 `CHANGELOG.md:131-142`）。当时也不缺"看起来绿"的测试——缺的是**测到事务的**测试，这正是 `test/region.test.js:1-12` 的注释动机。
- **机制**：本项目里"PASS"有一半取决于 profile 依赖是否可解析，否则静默 skip：`test/region.test.js:18-25`（`foldSurface`）、`test/compose.test.js:23-29`（`composeEntries`）、`test/lcm.test.js:332-337`（`basic`）、`test/recovery.test.js:95`（生产日志存在与否）。今天 54 passed / 0 skipped 是因为在本机 profile 里跑；换台机器同一份代码会少掉 6 条最关键的断言且仍是绿。
- **规矩**：引用平面②/⑥ 的结论时必须带上"在本机 profile 内、54 tests、0 skipped"这三个限定词，否则它退化成"语法能过"。

### (ii) prompt 级消融不是引擎级对比

- 平面③的全部数据来自三臂**裸 prompt**（`bench/REPORT.md:20`、`bench/REPORT.md:74-76`），一次 `compile()` 都没跑。把这组数字说成"这个引擎的摘要更好"是跨平面的偷换。
- 唯一真正跑过 shipped 代码的是 `bench/recovery.mjs`（它 import 了 `src/recall.js`，见 `bench/recovery.mjs:22`），但它在文件头就写明 `No model is called`（`bench/recovery.mjs:12`）——它测的是召回管线，不是摘要质量。
- 因此"引擎级指标"目前**只有一个**：可恢复性。报告要求的真正引擎级实验（用真实 `compile()` 跑 787 节点、压缩后继续原任务、记完成步数与重读次数）**没做**（`bench/REPORT.md:67-68`）。

### (iii) v1 曾把 prompt 技巧当引擎优势，已撤回

- v1 的核心错误是"两臂都是裸 prompt 调用，没跑任何引擎代码"（`bench/REPORT.md:20`），却写成"换引擎"。撤回表六项全部作废（`bench/REPORT.md:13-21`），其中三项与仪器有关：锚点集 100% 是路径、抽样本是确定性的、嵌套让 9 条字面量打满 24/24（`bench/REPORT.md:15-17`）。
- 修法落在 `bench/anchors.mjs:10-15,53-56`（只留极大元素、单类 ≤35% 见 `:22`、按事实去重），并在 `CHANGELOG.md:183-188` 留档。
- **仍未消解的部分**：v3 的 basicplus（只给 basic 加那段锚点指令）在 s 语料上最高（`bench/REPORT.md:45`），这仍然指向"收益跟 prompt 指令走，不跟引擎走"（`bench/REPORT.md:7-9`）。也就是说：**本仓库的摘要增益归因问题没有解决，只是被诚实地标注为未解决**。
- **使用纪律**：任何"这个 backend 摘要更好"的说法，只要拿不出"同 prompt、同预算、跑真实 compile()、跨语料双向稳定"的数据，就属于重复 v1 的错误。

---

## 10. 复核命令与本次实测记录

在 `dsh-compaction-lcm/` 下执行，全部只读：

```bash
node --test
# 本次结果：tests 54 / pass 54 / fail 0 / skipped 0 / duration ≈ 0.6s

node bench/retrieval.mjs "$HOME/.dsh/sessions/--home-agent-workspaces--/d45c83f5-e619-4b3a-96e7-5cb17e2f690b/session.v4.jsonl.zstd"
# 本次结果：droppedAnchors 21, recall {at1:0, at5:0.905, at10:0.952, at50:0.952}, mrr 0.337, ndcgAt10 0.952
# 注：ndcgAt10 与 at10 数值相同，即 §6.3 的退化；at1 恒 0 即 §6.3 的构造偏移
```

复算（同一批 21 条 gold 的 0-based 命中位置，重算 1-based 指标）：

```
hitIndex(0-based): [2,0,2,4,3,1,2,0,2,2,3,0,0,0,0,2,1,0,-1,0,1]
min index = 0，其中 8 条为 0（gold 就是首个命中）
→ recall@1 0.381 / @3 0.810 / @5 0.952 / @10 0.952 / MRR 0.581
```

结论：`bench/REPORT.md:149-156` 的绝对值整体保守一格，方向结论不变；`bench/REPORT.md:170` 的边界解释不成立（见 §6.3）。

---

## 11. 现存文档与代码的不一致（读证据前先看这一节）

| 位置 | 不一致 | 以什么为准 |
|---|---|---|
| `README.md:31` | 写"43 tests"，实际 54 | `node --test` 的实际输出；`CHANGELOG.md:39` 的 54 是对的 |
| `src/index.js:87-96` | 类注释仍在描述 instant 的"确定性编译器、不路由模型请求"，与本实现相反 | 实现：`src/index.js:259-302`（`compile()` 走 LLM） |
| `src/index.js:174` | 日志文案 "with the instant compiler" | 实现同上 |
| `src/region.js:1-17` | 模块头注释写"instant backend / 确定性编译器 / 永不 await 模型" | 实际 `src/region.js:128` 会 `await` 一个可能是 LLM 的 compile |
| `ACCEPTANCE-dsh-lcm.md:134-135` | G2.5 写 1.02× ✅、G2.6 写 +22.5pp ✅ | 同文件 `ACCEPTANCE-dsh-lcm.md:26-27` 与 `ACCEPTANCE-dsh-lcm.md:143-154` 已判作废 |
| `ACCEPTANCE-dsh-lcm.md:130` | G2.1 公式写 `min(0.75W, W−O−B)` | 实现与 `ACCEPTANCE-dsh-lcm.md:115` 都是 0.8（`src/config.js:30`、`src/config.js:195`） |
| `CHANGELOG.md:41-42,59-60,82-83,123-124,157-158,200-207` | 版本标题重复出现两次 | 内容本身有效，只是标题行重复 |

这几条不影响 §2–§8 的判定，但会让"读注释当证据"的复核跑偏；本文件所有结论都只引实现行号，不引这类注释。
