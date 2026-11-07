# LCM-X 功能族盘点 × dsh 版对比

> 2026-11-07 · 读的是 `/home/agent/workspaces/lcmx-study/lcm-x`（stable **v0.29.1**，不是 v0.27.0 —— `plugin.yaml:2`、`README.md:144`、`docs/project-status.md:21` 三处一致）
> 对比对象：本仓 `dsh-compaction-lcm` 0.2.5（2452 行 JS）
> 标 ▲ = 我读原文/看图确认；标 ● = 子代理核过合同细节

---

## 0. 规模差（先看这个，后面所有差异都从这来）

| | lcm-x v0.29.1 | dsh 版 0.2.5 |
|---|---|---|
| 代码 | 1251 个 py；`compaction.py` 3 820 + `engine.py` 12 179 + `tools.py` 6 075 + `config.py` 1 793 = **23 867 行** | **2 452 行** |
| 配置面 | **119** 个 `LCM_*` 环境字段（全量文档面 148、两张行为表 98）+ 代码认 **11** 个 YAML 键（文档只说 5） ▲● | **16** 个顶层键（9 POLICY + 5 LCM + modelPolicies + auto）；加 provider/model 叶子算 18 ▲ |
| 功能开关 | **25** 个 `*_ENABLED` ▲ | `auto`、`legacyNames` 两个 |
| 工具 | 16 声明 / 13 默认可视 ● | 2（+2 别名） |
| 存储 | 自有 SQLite + FTS5 + 向量 | 不建库，吃宿主 append-only log |
| 外部依赖 | sqlite、fastembed(可选)、numpy(可选)、provider key | 无（peer 只有 dsh 包） |

---

## 1. 代理配置配置文件 ▲

**是什么**：`docs/agent-config-profiles.md`，5 个可复制粘贴的预设 ——
①default chat assistant（啥都不配）②heavy tool-use coding agent ③long-horizon personal/companion agent ④fully local / air-gapped ⑤cost-guarded cloud embeddings。

**为什么存在**：lcm-x 的开关有 25 个，任意组合极多；没有一个"面向用法而不是面向参数"的入口，用户必然配错。预设把「你是什么类型的 agent」翻译成「哪几个开关该开」。

**但真相是：这些 profile 里绝大多数 export 就是出厂默认值。** 逐项对表（profile 行 vs operator-guide 默认）：
`EXTERNALIZATION_ENABLED=true`(默认 true) / `STUBBING=true`(true) / `STUB_THRESHOLD=10000`(10000) / `AGED=2000`(2000) / `FRESH_TAIL_MAX_TOKENS=24000`(24000) / `FULL_SWEEP=true`(true) / `TEMPORAL_ROLLUPS=true`(true) / `PROVIDER=fastembed`(本来就是)。

**真 delta 只有 4 处**：`LCM_STUB_FIRST_EXIT_TARGET_RATIO=0.2`(默认 0)、`LCM_ENABLE_SLASH_COMMAND=1`(默认 false)、`LCM_EMBEDDING_PROVIDER=voyage`+`MODEL`(默认空)、`LCM_RECALL_DELIVERY_UNIT=session`(默认 hits)。

所以这个文档的真实定位是**「默认姿态说明书」**，不是 delta 补丁 —— 对新手有用，对调参没用。

**陷阱一处**：cost-guarded profile 里 `LCM_SENSITIVE_PATTERNS` 那行是**空操作**（该值本身已是默认）。真正开关是 `LCM_SENSITIVE_PATTERNS_ENABLED`，默认 **false**，两者自 v0.23.2 起独立。

**机器可读的真 preset 不在这个文档里**：`presets.py:38-48` 只有 6 个字段（threshold / fresh_tail_count / leaf_chunk_tokens / leaf_target_max_tokens / condensation_fanin / incremental_max_depth），两份按**模型族**而非用途划分：`codex_gpt_long_context`、`codex_spark_context`(fresh_tail_count=16)。用法 `/lcm preset show|suggest|apply --dry-run`，dry-run 只打印 env、绝不写文件。

**dsh 版**：半有。唯一的"预设"机制是 `modelPolicies` 按精确 provider/model 覆盖；按用途分的三档（long-horizon / local / cost）在 dsh 里无从落地，因为对应功能（embeddings/rollups）本身不存在。

---

## 2. 操作指南 ▲

**是什么**：`docs/operator-guide.md` —— 安装、激活（`plugins.enabled` + `context.engine: lcm-x`）、完整配置参考、诊断。

**为什么存在**：lcm-x 是**替换宿主的上下文引擎**，装错=会话读不出来。诊断（`/lcm status` 报配置来源、`/lcm doctor` 报被忽略的 YAML 键与误配）是把"配了但没生效"从玄学变成清单。

**开关**：`LCM_ENABLE_SLASH_COMMAND=1` 才出 `/lcm` 命令面。

**规模**：1828 行。doctor 有 **12 类检查**（database_integrity、schema_core_tables、messages_fts、nodes_fts、cleanup_candidates、payload_storage、sensitive_pattern_handling、source_lineage_hygiene、lifecycle_fragmentation、survival_fit、inactive_process、embedding_provider_health）。

**失败分三层**：①单检查 status ∈ {fail, warn}，unchecked 降为 warn ②每个 warn/fail 映射三种 operator action：**safe/ignore | inspect | backup-first cleanup**，带 `warning_only` 标记 ③渲染分 issues 与 recommended_actions 两栏，JSON 里 guidance 一项不漏。破坏性 apply 由 `LCM_DOCTOR_CLEAN_APPLY_ENABLED`(默认 **false**) 把守，斜杠面 `LCM_ENABLE_SLASH_COMMAND`(默认 false) 把守。

**坏值不崩**：非法配置留默认 + 进 `config_source_warnings`，由 doctor 报出来。

**两处文档/代码不一致（值得记）**：
- profiles 页与 guide 都说 YAML 只支持 **5** 个 `lcm:` 键，代码接受 **11** 个（多出 embedding prefix ×2、recall_adjacent_reply、stub threshold ×2、recall_summary_event_time…），被忽略的键靠 doctor 报。
- **operator-guide 是 main 平面文档**：它已写了 v0.30.0 才移除的 Transcript GC、v0.31.0 才移除的 `LCM_DEFERRED_MAINTENANCE_ENABLED`，而宣称的稳定版是 v0.29.1。**这违反了它自己"双平面不混用"的纪律。**

**dsh 版**：安装=一行 `dsh plugin add`（bundle patch 自动 disable basic），诊断=0（只有 `debug`/`debugLogPath` 写文件日志）。可观测门 G6 在验收里只是"建议"级，G4–G6 全列待办。

---

## 3. 检索工具参考 ●

**是什么**：`docs/retrieval-tools.md` + `tools.py`。16 个声明 schema，13 默认可见：

`lcm_grep` `lcm_recall` `lcm_compute` `lcm_compile_evidence` `lcm_evidence_pack` `lcm_recent` `lcm_load_session` `lcm_describe` `lcm_expand` `lcm_expand_query` `lcm_status` `lcm_inspect` `lcm_doctor`，
+ 三个 flag 门控：`lcm_query_state`(assertions) / `lcm_retrieve`(adaptive) / `lcm_memory`(entities)。

**为什么存在**：摘要必然有损，所以合同的重心是**"怎么在预算内把原文取回来"**。每个工具都带硬预算（64k 字符信封、limit 硬顶、RRF k=60）、降级枚举（`coverage ∈ {full, full_approx, bounded, none}` + `degraded_reason`）、失败语义（血缘不可验证 → fail closed）。这是把"检索"当**数据库 API** 设计，不是当 helper。

**开关**：`LCM_DISABLED_TOOLS` 压倒一切；三个功能 flag 各自解锁一个工具。

**dsh 版**：`lcm_expand` + `lcm_search`（+ `recall`/`search` 别名）。缺的全部：跨会话检索、semantic/hybrid、摘要节点作为可检索对象、role/time/source 过滤、compute/evidence_pack、recent 时间窗、load_session 翻页、外置负载检索、status/doctor/inspect。
**dsh 独有**：`/lcm-search` 把命中**追加为持久 user message**，人侧注入路径（lcm-x 没有等价物）。

---

## 4. 当前项目状态 ▲

**是什么**：`docs/project-status.md`。四件事：
- **稳定基线**：v0.29.1 @`3a4a08ff`，从 `release/v0.29.x` 维护分支切出，**不是 main**
- **身份分离**：stable 与 main 是"不同证明平面"，禁止拿 main checkout 冒充已安装的稳定版
- **主动工作**（文档里没这个标题，对应三处实体）：①压缩此刻全在 turn 线程上、用户要等 → `LCM_BACKGROUND_LEAF_PREP_ENABLED`(默认 **false**，8 calls / 600s) 把预生成挪到 off-turn ②`LCM_PROACTIVE_RECALL_ENABLED`(默认 **false**，500 tok 预算)—— 模型没问就把证据推到眼前 ③Current program 在飞清单（离线重建、当前请求逐字保留、sender provenance、重复命中折叠、continuity instrument）
- **证明边界**：source/tag 身份、PR/CI/评审状态、基准候选与投递指标、答案准确率、已发布产品、单 profile 运行时安全、fleet/客户就绪 —— **七个平面，一个通过的 clone/benchmark 只证明它自己那个平面**

**为什么存在**：这个项目做过对抗性评审、有 17 条 release gauntlet 行、会公开写"某行 UNRUN、不是 green"。**证明边界是为了让"通过"不被滥用。**

**dsh 版**：**无**。这也是 dsh 版最该抄的一条（不是功能，是纪律）。

---

## 5. 基准方法论与结果 ▲●（用户重点）

**两层合同**：

| 层 | 测什么 | 怎么判 | 关键隔离 |
|---|---|---|---|
| L1 检索质量 | session/turn 级 recall@k、NDCG@10 | 离线 harness，**不需要 LLM 裁判** | 每题一个 `tempfile` 里的全新 SQLite store —— 这是明写的 *fairness contract* |
| L2 判分 QA | 端到端答案正确率 | fork 的 memorybench + bridge 进程；judge 用 **LongMemEval 官方 per-question-type prompt**，不自造 | ingest 每题一个新 `lcm.db` |

**三条公平规则**：①adapter 只看到 harness 给每个 provider 的同样东西 ②**fresh dataset-disjoint session id**（否则生产工具里的 scope prior 会把证据会话"顺走"，等于作弊）③单发检索、不二次扩展（禁止用 agentic 重查把答案喂胖）。

**臂的设计**：7 个臂（fts / summary_vectors / hybrid_rrf / hybrid_rerank / chunk_vectors / hybrid_rrf3 / lcm_recall），其中 `lcm_recall` **设计上**直接调生产工具本体而非重写。

**但落地物与文档不对应（我核到的，最重要的一条）**：

| 文档承诺 | 落地物实际 |
|---|---|
| METHODOLOGY 描述的是 in-tree 两层 harness | `RESULTS.md` 六个头条分数**全部来自第三方 OmniMemEval 的 pinned harness commit**，不是 in-tree harness 跑出来的 |
| M 的 Results index 有质量层（QA accuracy）一行 | 该行状态 **pending** —— 质量层对外**零落地** |
| `lcm_recall` 是生产臂 | 500q 结果里 **没有 lcm_recall 臂**，只有 6 个 primitive 臂；仅 50q 有一组 R@1 0.42/R@5 0.98/R@10 1.00，且无对应 JSON |
| `hybrid_rerank` 是真 cross-encoder | 落地结果 `rerank.mode=placeholder-cosine`、`real_count=0`，其六位有效数字与 `summary_vectors` **完全相同** —— 占位余弦被当成"rerank 无效"的证据 |
| turn 级指标独立 | 三个含摘要的臂 **tR≈sR**（rrf3: sR@5 .771 / tR@5 .778），因为 turn keys 由 `summary_turn_keys(fused session ranking)` 投影而来 —— 宣称的 0.28→0.78 是**把 turn 指标换成了 session 指标的副本**，不是检索变好 |

**结果**（`RESULTS.md`，claim class = contributor-run, accepted upstream）：LoCoMo 78.83(5/15)、LongMemEval 87.00(2/13)、BEAM 100K 71.84(1/12)、BEAM 10M 63.32(1/12, ±40.02 单 run)、PersonaMem v2 33.96(8/13)、HaluMem 81.68(5/13)。**全部质量指标，零压缩比** —— 而且这是 doctrine：`ROADMAP.md:50` 明写 **"Token cost is not a gate"**。

**判分合同的五个洞**：
1. **没有 answerer≠judge 分离** —— 文档自己写 `-j gpt-4o -m gpt-4o`；CLI 路径下 `-j/-m` 只是标签
2. codex 路径披露的模型 id 是**硬编码字符串默认值**，不是实测 served model
3. CLI 后端下 `CliJudge.getModel()` 直接抛错 → **一条评分路径被静默跳过**
4. search 返回 degraded 只写 `logger.debug`，结果文件无 degraded 字段，而 release spec 要求 degraded rate 达标
5. vendored adapter 硬编码本机路径 `/Volumes/LEXAR/hermes-work/hermes-lcm`，与它自己 AGENTS.md 的 "Never cite machine-local paths" 冲突

**「复制和落地结果索引」**= 四件事：①M 的登记表（运行→文件映射，`landed/pending`）②复现路径（fetch→run；QA 层 clone/env/bun run/-r 续跑）③发布链 `public-results.json → render_results.py → RESULTS + README highlights + plugin.yaml`，带同源硬校验 ④pin 清单（dataset revision + harness commit + adapter commit + per-run judge id）。

**注意**：真正"预注册 + 配对检验 + placebo"的那套（McNemar p<0.05、A/A′ placebo、permutation seed 1607、cluster bootstrap 10k、held-out split）在 `bench/specs/RELEASE-READINESS-V1.md`，**METHODOLOGY 一个字都没引用**。

**dsh 版差在哪**（按重要性）：
1. **没有检索质量层**（recall@k/NDCG）—— 我们只测"摘要带了多少锚点"
2. **没有端到端判分**—— 从没让模型压缩后真去答题
3. **没有 fresh-store 隔离 / held-out / 预注册**——三臂消融是临时定的，事后才补的防伪
4. **没有 claim class 与披露规范**
5. 有而 lcm-x 没有的：引擎级**可恢复性**测量（12.5%→100%），以及会主动撤回自己结论的习惯

---

## 6. 嵌入设置 ●

**是什么**：4 个 provider —— Voyage（200M 免费额度）/ fastembed（进程内 ONNX，$0，模型 90–130MB 首次下载）/ Ollama（loopback 才算本地）/ openai-compatible。

**为什么存在**：`lcm_recall` 三臂里两臂是向量；`lcm_grep` 的 semantic/hybrid 全靠它。没有嵌入 = 退回 FTS，长会话跨时间检索直接塌。

**开关**：`LCM_EMBEDDINGS_ENABLED`（关了就退 FTS-only，行与向量保留）；`LCM_EMBEDDING_PROVIDER/MODEL/BASE_URL/API_KEY_ENV`；`LCM_EMBEDDING_PRIVACY_ENABLED`（云 provider 副本默认保护）；热量/warmup 只在后台，**绝不在查询或回合路径下载模型**；backfill 有 dry-run 与身份元组（provider,model,revision,dim,dtype,byteorder,task），切回旧 provider 零重嵌。

**dsh 版**：**完全无**。`src/` 里 embed|vector 的命中全是注释。

**该不该补**：先别补。理由（子代理结论我认同）：可发现可恢复性已 12.5%→100%、丢失 0，瓶颈不在召回率而在**呈现**；dsh 只有当前会话，语义收益的跨会话跨时间部分被吃掉；每身份一套向量的持续成本 vs prompt 级增益方向不稳（c2 +12.5pp、s −3.6pp）。**正确的顺序是先补检索质量仪器，再谈向量。**

---

## 7. LCM 论文

**是什么**：Ehrlich & Blackman, *Lossless Context Management*, Voltropy PBC, 2026-02。核心两件：①递归上下文压缩（层级摘要 DAG + 指向每条原文的无损指针）②递归任务分区（engine 管的 LLM-Map 并行原语）。

**为什么存在**：给"上下文管理可以是被动压缩之外的东西"一个形式化论证，并对标 RLM（模型自己写循环）走"引擎确定性管理"这一端。

**开关**：无（学术）。

**状态：文件是坏的，不是空的。**
`LCM-paper.md` 首字节 `%PDF-1.7`，327 198 B，但 `startxref` 指向 **943 906** —— 比文件长度大 3 倍，**下载被截断**；`paper.html` 同样是 PDF 二进制。全文 0 个 `FlateDecode` 流、0 个 `/Title` 书签，zlib 解不出任何文本。

所以本报告**不含任何论文内容**。关于论文的说法只有两处二次引用：`README.md:12-13`（Ehrlich & Blackman, 2026-02）与 `src/summarize.js:5-6`（"the LCM paper's recursive context compression leaf step"）。

需要论文级定义（leaf / rollup / 查询类型的形式化）时，**必须重新取原文**，不能从这两个文件里读。

---

## 8. 架构图 ▲（我读了图）+ ● 代码锚点

**图面（我实际看到的三段）**：
- 左 **ACTIVE CONTEXT（模型当下看到的）**：System Prompt + LCM 检索提示 → Highest-Depth Summaries（D2 级）→ Fresh Tail（图上写 "last **64** messages, never compacted"）
- 右 **SUMMARY DAG**：D2(weeks) → D1(hours) → D0(minutes)，越往下越具体
- 下 **IMMUTABLE STORE（SQLite + FTS5）**：逐字保留、全文+元数据可搜、append-only 防篡改；右下贴一条真实行 `{"turn_id":8124,"role":"user","content":"We will use integer[] for the user_events.column_type with a GIN index."}`
- 回路：store → `lcm_grep`/`lcm_expand` → 精确 turn → 回 active context
- 页脚：**"Summaries guide the model. Raw turns remain recoverable."**

**代码锚点（把图上的层钉成不变量）**：

| 层 | 实现 | 不变量 |
|---|---|---|
| L0 store | `messages` 表 + `messages_fts` + `messages_fts_stem`，WAL 耐久 | I1 exactly-once、I2 lossless（"Compaction and survival fit never delete or alter a stored row"） |
| L1 DAG | `summary_nodes` + `summary_node_provenance`，边 = `source_ids` | I14 节点/血缘/frontier 同事务；I7 升级只改文本不改行；I9 叶/尾切割不拆 assistant-tool 组 |
| L2 externalize | `lcm-large-outputs` 目录 + ref 占位 | fail-open（写失败仍给原 payload）；回读有界 ≤256 文件/≤512KB 每文件 |
| L3 retrieval | 16 schema / 13 广告 | 血缘过滤 fail closed；语义不满足过滤时**降级**不近似，带 `degraded_to_fts` |

**跨层铁律**："Raw messages remain source truth. Summaries, FTS indexes, embeddings, temporal rollups, query views, and assertions are derived layers and must retain explicit source/provenance relationships."（`docs/architecture.md:63-65`）—— **派生层不得成为唯一副本**。

**⚠️ 图与代码不一致**：图上 fresh tail = **64** messages，`config.py:1071` 是 `fresh_tail_count = 24`。图是宣传口径，代码是 24。

---

## 9. 标准压缩图 vs LCM 压缩图 ▲●（技术路线核心）

**standard_compression.png** —— *"The topic survived. The answer did not."*
① 早先：`We decided user_events.column_type should be integer[].` → ② 压缩后：`Discussed database schema changes and deployment plans. …Decisive detail lost` → ③ 后来问：`What column type did we decide…` → ④ 答：`Probably JSONB. ✗ WRONG`（原决定 `integer[]`）。页脚：**"Lossy compression preserved the topic, but dropped the decisive detail."**

**lcm_compression.png** —— *"The summary narrows the search. The raw turn provides the answer."*
① DAG 三层 → ② Fresh tail 常驻 → ③ 同一提问 → ④ `lcm_grep("user_events column_type") → original turn recovered` → ⑤ `integer[] with GIN index ✓ FOUND`。页脚：**"Compact the context. Keep the evidence."**

**两张图 = 技术路线的完整表述**：标准压缩把压缩当**替换**（产物是唯一副本），LCM 把压缩当**索引化**（摘要降级为"缩小搜索范围"，答案永远从 raw turn 取）。

**代码侧的四条实质差异**：

| 维度 | 标准压缩 | LCM |
|---|---|---|
| 替换粒度 | 一次毁掉整段中段 → 每次付全中段重放成本 | 每次只动最老一个 24k 叶块，图慢慢长 |
| 组织轴 | 时间顺序（旧的先死） | 覆盖区间（DAG 边），depth = 覆盖多少历史 |
| 可回钻 | 纯文本，只能靠宿主 `session_search` | `store_id`/`node_id` 指针，回钻是一等能力 |
| 失效形态 | 压一次亏一次且不可逆 | 可以不压到装不下为止（`select_prefix` + `survival_fit` + I3 不得静默超窗） |

**dsh 版被结构钉死在哪（子代理逐条核过契约）**：

`{op:"replace", startSeq, endSeq}` 三键结构只表达**"某段历史被一段摘要覆盖"**，不能表达"被多个节点分层覆盖"。因此：

| lcm-x 机制 | dsh 能否做到 | 原因 |
|---|---|---|
| 多节点跨区间分层并列 | **不能** | 任何新压缩会把区间内 checkpoint 一起吸收（`region.js:218` 不排除 checkpoint），父节点只能把子节点吃进自己文本 |
| fresh tail 双界（24 条 + 24k tok + 工具组扩展 + pressure yield） | **半** | 只有一个 `retainTokens` 预算；没有计数维度、没有组扩展、没有 yield |
| 一次阈值清扫 12 片叶 | **不能** | 一次事务一段连续区间；每片要付一次全量前缀重放 + LLM 调用 |
| 组装期二次取舍（`select_prefix` 丢低价值节点） | **不能** | 落盘即定死（shrink 闸在 commit 时定价），组装期无取舍点 |
| escalation L1/L2/L3 | **半** | checkpoint 只有一段文本；depth 只用于 prompt 一句话 |
| 外置 payload + ref 回读 | **不能** | 只借 harness 的 `toolResultPruner`，裁掉不可回读 |

**唯一真正的"回注"通道**是 `/lcm-search` 把命中 append 成一条 user/message 塞回对话 —— 它占真实上下文、不受压缩事务保护、下次压缩会被当普通消息吸收。这是**近似**，不是等价。

**结论**：dsh 版剩下的近似手段（priorDepth 折叠提示、deriveDag、footer、RECALL 指南）都是把结构信息塞进**文本**，不是塞进**结构**。这也是 `bench/REPORT.md` 敢说"架构差异"只到"可发现的可恢复性 12.5%→100%"、而不敢说摘要更密的原因。

---

## 10. 贡献指南 / 行为准则 / 安全政策 / 标签 ▲

**是什么**：`CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` / `SECURITY.md` + 仓库 topics。
**为什么存在**：这是个**会动宿主上下文**的插件，安全政策必须写；贡献指南+release gauntlet 是"改一行要跑哪几行验证"的台账。
**开关**：无。
**dsh 版**：只有 LICENSE。缺 SECURITY（我们的插件会读整段会话日志，值得写）。

---

## 11. 我要给 dsh 版补的（按性价比，不是按功能多）

| 优先 | 补什么 | 为什么 | 代价 |
|---|---|---|---|
| **P0** | **证明边界一节** | 我们已经在三个平面之间来回说（prompt 级 / 引擎级 / 生产观测），没有明写"这证明不了那个" | 半天，纯文档 |
| **P0** | **检索质量仪器**（recall@k / NDCG，用现成 105 个 session 造 labeled evidence） | 现在只有"锚点命中"，是自制指标，没有 held-out | 1–2 天 |
| P1 | **端到端判分**：压缩后真答题，judge 用现成 prompt 不自造 | 唯一能证明"压缩没害到任务"的层 | 2–3 天 |
| P1 | **claim class + pin 清单**（语料 commit / 模型 id / n / seed） | 我们固化的 JSON 里**没有模型名、没有温度、没有 seed**，而 REPORT 的复现块声称 temperature 0 —— 落地物不携带它声称的配置 | 半天 |
| P1 | **配对检验**（McNemar / permutation / bootstrap），别再用 Welch | 上一轮唯一统计是被自己推翻的 Welch CI；v3 无任何区间 | 1 天 |
| P1 | `SECURITY.md` + `CONTRIBUTING` 的"改这块要跑那几条" | 插件读全量会话 | 半天 |
| P2 | 跨会话检索（`session_scope`） | dsh 有多 session，现在只扫当前 | 1 天 |
| P3 | 向量召回 | 见 §6：现在不该做 | 一周起 |

**不补**：25 个开关、5 个预设、rollup、entities/assertions —— 那是"记忆系统"的野心；dsh 版的定位是**压缩引擎**，不是记忆库。补了就是重复造 lcm-x。

---

## 12. 交叉验证：文档 vs 代码（我核出来的漂移）

| # | 文档说 | 代码是 | 影响 |
|---|---|---|---|
| 1 | 架构图/压缩图：fresh tail **64** messages | `config.py:1071` `fresh_tail_count = 24` | 看图的人会以为留 64 条，实际 24 条 |
| 2 | profiles 页 + guide：YAML `lcm:` 只支持 **5** 键 | `config.py:484-495` 接受 **11** 键 | 6 个键能配但"文档说不许"，靠 doctor 兜 |
| 3 | README/status：稳定版 **v0.29.1** | operator-guide 已写 v0.30.0/v0.31.0 才移除的功能 | **违反它自己的"双平面不混用"** —— guide 是 main 平面文档 |
| 4 | 你给我的清单写 **v0.27.0** | `plugin.yaml:2` = 0.29.1；v0.27.x 现在只是"12 小时参考代理门"与 low-water 标记 | 清单来自旧快照 |
| 5 | cost-guarded profile 里 `LCM_SENSITIVE_PATTERNS` | 该值已是默认，**空操作**；真开关是 `..._ENABLED`(默认 false) | 照着抄会以为开了脱敏，其实没开 |
| 6 | 「5 个 profile」暗示是 5 套 delta | 绝大多数 export = 出厂默认，**真 delta 只有 4 处** | 文档定位其实是"默认姿态说明书" |
| 7 | METHODOLOGY 描述 in-tree 两层 harness | 六个头条分数来自第三方 OmniMemEval；质量层在 M 的索引里仍 **pending** | 文档化的方法**不是**产生头条数字的方法 |
| 8 | 7 臂含生产 `lcm_recall` | 500q 落地只有 6 个 primitive 臂，`lcm_recall` 无 500q 数字 | "跑的是用户真调的代码"这句在落地物里不成立 |
| 9 | `hybrid_rerank` 是真 cross-encoder | `rerank.mode=placeholder-cosine`、`real_count=0`，数值与 `summary_vectors` 全同 | 用占位余弦得出"rerank 无效"的结论 |
| 10 | turn 级指标独立 | 三臂 `tR≈sR`，turn keys 由 session ranking 投影 | 0.28→0.78 是**换了指标**，不是检索变好 |
| 11 | `n` 每 run 披露（M:184-186） | BEAM 10M 以 "1st of 12" 上头条，未给 n | 头条与自己的披露承诺冲突 |
| 12 | AGENTS.md "Never cite machine-local paths" | vendored adapter 硬编码 `/Volumes/LEXAR/hermes-work/hermes-lcm` | 自己的规矩自己破 |

**这一节的意义**：lcm-x 是自己写"证明边界"的项目，但它的**文档层**仍然出现了 6 处漂移。这说明纪律要落到**生成**上（他们确实在做：148 键的生成式参考就在 skill 里），而不是靠人写。

对 dsh 版的启示：我这份对比文档里的每个数字都应带 `文件:行号`，否则半年后同样是漂移源。

---

## 13. 结论：该抄什么、不该抄什么

### 该抄（三条，都与功能无关，与纪律有关）

1. **证明边界写成七条互不混用的平面** —— 我们已经在 prompt 级 / 引擎级 / 生产观测之间来回说，没有明写"这证明不了那个"。
2. **结果索引四件套**：运行→文件映射、pin 清单（dataset/harness/adapter 三个 commit + per-run judge id）、发布链同源校验、claim class。
3. **两层测法**（检索质量 + 端到端判分）—— 哪怕只做第一层。

### 不该抄（三条）

1. **25 个开关 + 5 个预设**：lcm-x 的预设本身 90% 是默认值，真 delta 只有 4 处。复杂度换来的不是清晰。
2. **"Token cost is not a gate"**（ROADMAP:50）：这是 doctrine，不是发现。dsh 侧 cost 是一等指标，这条不能跟。
3. **禁止 agentic 再展开**（METHODOLOGY:86-89）：lcm-x 用这条保证可比性，代价是**把自家"nothing is ever lost"的核心主张排除在测量之外**。dsh 的 recovery.mjs 恰好测了这一项 —— 这是我们唯一比它强的地方，不能为了对齐口径把它删掉。

### 一句话

**lcm-x 的方法论**比 dsh 版厚两个数量级，但**它的头条数字不是它文档里的方法产出的**，且质量层至今 pending。
**dsh 版的方法论**薄，但**每一个数字都能顺着 §12 的行号回到代码**。

所以正确的动作不是"补齐它有的"，而是：**先把自己的证明边界写清（半天空闲），再补检索质量层（1–2 天），最后才谈端到端判分。**