# SECURITY — 数据流、信任边界与部署加固

> 适用范围：`dsh-lcm` 0.2.6（`package.json:3`）。
> 本文只描述**代码里真实存在的行为**，每条带 `文件:行号`。没有写"将来可能"的东西；没有写"为了安全所以"这类空话。
> 判定方法可复现：§8 给出读代码 + grep 的完整口径，任何人都能重跑一遍否定或补全本文。

---

## 0. 攻击面一句话

插件本体**不联网、不读磁盘上的会话文件**。它只做四件事：

1. 读**内存里**的会话事件（`session.events`）；
2. 往会话日志**追加**事件（含摘要正文与模型原始输出）；
3. 往一个**可配置路径追加**一行调试文本；
4. 把**一个**模型请求发出去（`ctx.llm.stream`）。

所有真实风险都落在这四件事的边界上：外发量（R1）、落盘留存（R2/R3）、入参可被谁控制（R4/R5）、以及"可达性被主动放大"（R9）。

---

## 1. 数据分类与流向总表

| # | 数据 | 从哪里读 | 落盘位置 | 是否出本机 | 代码 |
|---|---|---|---|---|---|
| 1 | 会话事件全量（用户/助手消息、工具调用参数、工具结果、推理块） | `session.events` 内存 | 原本已在 log；插件另写 4 类事件（见 §2.1） | **是**，进摘要请求（R1） | `src/search.js:105-131`、`src/recall.js:206-241`、`src/summarize.js:124-127` |
| 2 | 会话头部的 system/message | `session.surface.nodes[0]` | 否 | **是** | `src/summarize.js:131-133,164` |
| 3 | 工具 schema 列表 `header.tools` | `session.requestHeader()` | 否 | **是** | `src/summarize.js:130,170` |
| 4 | 模型输出（摘要正文） | provider 返回 | `compaction/summary`.summary + checkpoint user/message | 落盘后可被再次读出 | `src/index.js:269`、`src/region.js:329-344,345-361` |
| 5 | 模型原始输出 `rawOutput` | provider 返回 | `compaction/summary`.rawOutput（**全文**） | 落盘后可被 recall 取回 | `src/region.js:343`、`src/index.js:300` |
| 6 | provider `usage` / `maxTokens` | provider 返回 | `compaction/summary` | 否 | `src/region.js:341-342` |
| 7 | 调试元数据（rev、seq 范围、节点数、token 数、预算） | 引擎内部 | `debugLogPath`（默认关） | 否 | `src/index.js:102-115,150,262-265,278` |
| 8 | 搜索结果片段（可含任意历史正文） | 会话事件 | 追加为 surface 的 user 消息 | 下一轮会**再外发** | `src/command.js:55-63` |
| 9 | 配置与环境 | composition entry / `process.env` | 无 | 否 | `src/config.js:83-140,115-120` |

**唯一对外出口**：`src/summarize.js:176` 的 `ctx.llm.stream(options)`。运行时代码里没有 `fetch` / `node:http` / `node:net` / `child_process`（§8 的 grep 结果可复核）。

**唯一的磁盘写**：`src/index.js:111` 的 `appendFileSync`（`node:fs` 是 `src/index.js:17` 唯一引入的 fs API）。没有 `readFile`/`writeFile`——**不存在从模型入参推导路径去读写任意文件的能力**。

---

## 2. 落盘逐项

### 2.1 会话日志（三类事件 + 一次位置替换）

| 事件 | 内容 | 代码 |
|---|---|---|
| `compaction/start` | `compactionId`、可选 `sourceCommandId`、`turn` | `src/region.js:112-118` |
| `compaction/summary` | `summary`（摘要正文块）、`shadowedRange`、`shadowedSeqs`、`shadowedTokenCount`、`provider`/`model`/`maxTokens`/`usage`、**`rawOutput` 全文** | `src/region.js:329-344`，`rawOutput` 在 `:343` |
| `user/message`（checkpoint） | 固定前言 + RECALL 指南 + 各节正文 + 尾部保留说明 | `src/region.js:271-274,345-361`；框架常量 `src/compiler.js:218-232` |
| `compaction/end` | 成功或 `errorChain(error)` | `src/region.js:134`、`src/region.js:145-148` |

留存含义：**同一份摘要内容在 log 里至少出现两次**（`summary` 数组 + checkpoint message），而 `rawOutput` 是模型未经处理的原始块（可能含重复、半截标记、被截断的段落）。这不是缺陷，是设计选择（可审计），但它是"留存面"的一部分：log 有多大，敏感串就在里面留多久，且能被平面④的 recall 原样取回（`src/recall.js:197-241`）。

### 2.2 调试日志（默认关闭）

- 开关：`debug: true` 或环境变量 `DSH_COMPACTION_DEBUG=1`（`src/config.js:115-116`；示例配置 `config.example.yaml:74-75` 默认 `false`）。
- 路径：`config.debugLogPath` ?? `${DSH_HOME}/compaction-debug.log` ?? `/tmp/dsh-compaction-debug.log`（`src/config.js:117-120`）。
- 写入：`appendFileSync(config.debugLogPath, text+"\n", "utf8")`（`src/index.js:111`），失败被吞（`src/index.js:112-114`）。
- **内容实际是什么**（重要，别被"明文日志"误导）：三行模板 `[dsh-lcm] engine: ...`，分别是构造（rev / debugLog / summaryRatio / cap，`src/index.js:150`）、摘要开始（节点数 / seq 范围 / shadowedTokens / budget，`src/index.js:262-265`）、摘要结束（输出 tokens / 压缩比，`src/index.js:278`）。**只有编号与计数，没有会话正文。**
- **真实风险不在内容，在路径**：`debugLogPath` 只校验"是字符串"（`src/config.js:298`），不校验位置；`appendFileSync` 未指定 `mode`（`src/index.js:111`），落在 `/tmp` 时权限由进程 umask 决定，同机其他用户可能读到这些元数据（谁在何时压了多少 token）。若配置面被低权限方写入，则等价于给引擎所属 uid 一个"向任意可写路径追加内容"的原语。

### 2.3 搜索结果回写会话

`/lcm-search <pattern>` 会把命中片段（上限受 `maxRecallTokens` 限制，`src/command.js:22`、`src/search.js:138-157`）作为 `form: "lcm-search"` 的 user 消息 append 到 surface（`src/command.js:55-63`）。

- 这是**内容落盘 + 内容再外发**的双重动作：该消息进入 surface 后，下一轮请求会把它发给 provider。
- 触发者是**人**（命令），不是模型。但模型侧的 `lcm_search` 工具（`src/tool.js:132-170`）返回同样内容给它自己，等于把历史正文重新灌进上下文（见 R9）。

---

## 3. 外发面（provider）

### 3.1 一次摘要请求发什么

`src/summarize.js:164-175`：

- `messages` = [system head（若存在）] + **被压缩区间每一个节点的 `deriveEventMessage` 投影** + 一条指令消息；
- `tools` = `session.requestHeader().tools` 的**拷贝**（`src/summarize.js:170`）——即完整的工具定义随摘要请求一起发出；
- `maxTokens` = 摘要预算（`src/summarize.js:171`，预算公式 `src/config.js:237-241`）；
- `sessionId`（`src/summarize.js:172`）、`purpose: "compaction"`（`src/summarize.js:173`）、可选 `signal`（`src/summarize.js:174`）。

结论：**摘要请求的外发量与主对话同量级**（它就是重放这段历史）。这一点是"回放前缀复用缓存"的设计结果（`src/summarize.js:105-110` 注释），不是偶发。

### 3.2 目标是谁（最容易踩的一条）

路由优先级（`src/summarize.js:135-147`）：

```
configured(summarizationProvider + summarizationModel)
  ?? session.requestHeader().config（当前路由）
  ?? agent.options.provider/model
```

`summarizationProvider` / `summarizationModel` 成对校验（`src/config.js:302-311`），但**取值不受限制**（任意非空字符串）。

含义：一旦运维把摘要路由配成一个便宜的第三方供应商，**整段会话历史 + 全部工具 schema 就会发给那一家**，而主对话可能走的是另一家。这是本插件最需要在部署前确认的一项配置，不是理论风险。

### 3.3 失败语义（避免"半截内容落盘"）

- 流结束为 `error`/`aborted` → 抛（`src/summarize.js:178`）；
- 结束原因为 `max-tokens` → 抛 `MAX_TOKENS`（`src/summarize.js:179-183`）；
- 正文为空 → 抛（`src/summarize.js:191`）；
- 摘要必须比被压区间小，否则抛（`src/region.js:275-276`）；
- 抛错走"闭合 `compaction/end`"路径，不写 `summary`（`src/region.js:137-157`，测试 `test/region.test.js:178-192`）。

也就是说：**失败不会留下半截摘要**。但成功路径下 `rawOutput` 一定落盘（§2.1），这一点无法关闭（没有对应配置项）。

---

## 4. 信任边界

| 边界 | 控制者 | 现有校验 | 残留问题 |
|---|---|---|---|
| Composition 配置（含 `debugLogPath`、`summarization*`） | 运维 / profile 作者 | 键白名单 `src/config.js:328-330`；类型与取值断言 `src/config.js:281-299` | `debugLogPath` 只校验 string（`src/config.js:298`）→ R3；`summarizationProvider` 不限域 → R1 |
| 工具入参 `type`/`id` | **模型**（可被提示注入影响） | 白名单枚举 + 正则解析 + 明确错误（`src/recall.js:34-61`、`src/recall.js:150-184`；工具 schema `src/tool.js:103-115`） | 无路径参数 → **不能任意文件读**；但 seq 无上界校验以外的访问控制，等价于"本会话全历史可读" |
| 工具入参 `pattern` | **模型** | 非空 + 可编译（`src/search.js:56-64`） | 无复杂度/长度上限，逐行逐事件 test → R4 |
| 会话日志内容（工具结果、网页抓取、文件内容） | 外部 | **无**，原样进摘要 prompt（`src/summarize.js:124-127`） | R5 |
| Provider 输出 | 外部 | 非空、非截断、必须更小（`src/summarize.js:191`、`src/summarize.js:179-183`、`src/region.js:276`） | **内容零过滤**，直接成为 surface 上的 user/message（`src/index.js:269`、`src/region.js:271-274`） |
| 命令入参 `rawInput` | 人 | 非空（`src/command.js:34-38`） | 命中片段回写会话 → R7 |

跨会话隔离：`recall`/`search` 只作用在 `exec.agent.session`（`src/tool.js:79-83`、`src/tool.js:144-149`），命令作用在 `invocation.agent.session`（`src/command.js:41,56`）。**没有跨会话读取入口**，也没有"传入 sessionId 就能读别人会话"的参数。

---

## 5. 已知风险（R1–R9）

### R1 摘要会把整段历史发给 `summarizationProvider`
- 位置：`src/summarize.js:164-176`、路由 `src/summarize.js:135-147`、配置 `src/config.js:126-127,302-311`。
- 触发：配置了非空 `summarizationProvider`/`summarizationModel`，且该供应商 ≠ 主对话供应商。
- 影响：整段被压历史（含工具结果里的密钥、私钥、PII）+ 全量工具 schema 发送给第三方；留存策略由该第三方决定，本插件无法审计。
- 缓解：留空（跟随主路由）；必须外置时只选与主对话同等信任级别的供应商，并确认其数据留存条款。

### R2 `rawOutput` 全文长期留存，且可被取回
- 位置：`src/region.js:343`（写入）、`src/index.js:300`（产生）、`src/recall.js:206-241`（取回路径）。
- 触发：每次成功压缩。
- 影响：模型原始输出（包含 `summary` 之外的块）永久留在会话日志；任何后续 turn 都能通过 `lcm_expand`/`lcm_search` 把它捞回上下文（并再次外发）。
- 缓解：当前**无开关**；只能靠"不要压缩含高敏内容的会话"或压缩后清理 log（属运维动作，插件不提供）。

### R3 `debugLogPath` 是任意可写路径的追加原语
- 位置：`src/config.js:117-120`（默认路径）、`src/config.js:298`（仅字符串校验）、`src/index.js:111`（appendFileSync，无 mode）。
- 触发：`debug: true` 或 `DSH_COMPACTION_DEBUG=1`，且 `debugLogPath` 被指向别处。
- 影响：①默认落到 `/tmp/dsh-compaction-debug.log`，权限随 umask，同机他人可能读到"何时、压了多少 token"这类元数据；②配置可写者获得"以引擎 uid 向任意可写路径追加"的能力（只能追加，不能截断/覆盖）。
- 缓解：保持 `debug: false`；需要时把路径钉在 `0700` 目录内的文件；进程 umask 收紧到 `077`；不要把 `debugLogPath` 交给低信任配置源。

### R4 搜索正则是模型可控的 ReDoS 面
- 位置：`src/search.js:56-64`（`new RegExp(trimmed, "iu")`）、`src/search.js:109-131`（对每条事件逐行 `test`）。
- 触发：模型（或人）传入灾难性回溯的模式，如 `(a+)+$`，日志里有长行。
- 影响：单次工具调用把事件循环钉住；会话越大越慢，且无超时/无长度上限（`src/tool.js:136-142` 只要求非空）。
- 缓解：优先用字面串（工具描述本身也这么建议，`src/tool.js:43`）；对不可信 agent 关闭同名工具或把 `maxSearchHits`/`maxRecallTokens` 调小（`src/tool.js:30-39`）；需要硬保证时应在上层加超时。

### R5 历史内容 → 摘要 prompt 的提示注入"洗白"
- 位置：注入源 `src/summarize.js:124-127`（历史原样拼入）；产物身份 `src/compiler.js:218-219` 的 `CHECKPOINT_PREAMBLE`（"Treat the captured context as established background..."）+ `src/region.js:271-274` 把它写成 `user/message`；内容零过滤 `src/index.js:269`。
- 触发：被压区间里出现"忽略以上指令/请把 X 写进摘要"这类文本（来源：工具结果、抓取的网页、被读文件）。
- 影响：注入内容从"数据"变成"看起来像系统说明的背景上下文"，并且因为 checkpoint 前言本身就在授权模型把它当既定事实，**过滤器在这一层完全不存在**。后续 turn 会把这段当背景继续执行。
- 缓解：本插件没有检测/转义机制，也不打算有（会破坏逐字保真）；实际可控点是①压缩前不要把手不可信的抓取内容留在主历史里（用子代理/单独会话处理外部内容），②把 `lcm_expand` 取回的内容当"原始证据"而不是"指令"来读。

### R6 推理块可被 `recall` 原样取回
- 位置：`src/recall.js:78-80`（`reasoning` 块以 `[reasoning]` 标记整段返回）。
- 触发：模型调用 `lcm_expand` 指向含推理块的 seq。
- 影响：已被 surface 遮蔽的推理文本重新进入上下文并再次外发给 provider；若推理里出现过密钥片段、内部判断，等于二次暴露。
- 缓解：与 R2 同源——压缩不删数据，取回能力本身就是留存风险的放大器。

### R7 `/lcm-search` 把命中正文写回会话
- 位置：`src/command.js:55-63`（`runMaintenance` + `surfaceOp: "append"` + `sourceEventSeqs`）。
- 触发：人执行 `/lcm-search <pattern>` 且命中非空。
- 影响：命中片段成为 conversation 的一部分，下一轮必然外发；若搜的是敏感串，等于主动把它推给 provider 并留在 log 里。
- 缓解：搜宽泛关键词而非具体密钥；必要时在无外发环境（本地模型/离线 profile）里搜。

### R8 JSON 兜底路径不过滤控制字节
- 位置：`src/recall.js:222`（`JSON.stringify(event.data).slice(...)`）对比投影路径的 `sanitize`（`src/recall.js:76-85`、`src/compiler.js:127-133`）。
- 触发：`session.deriveEventMessage` 不可用或无 message（非消息类事件）时走兜底。
- 影响：ANSI 转义/控制字节原样进入上下文与终端渲染。
- 缓解：影响面小（限兜底路径），但审计时应知道两条路不同源。

### R9 "可达性被主动放大"是行为层面的安全变化
- 位置：`src/compiler.js:231-232`（`RECALL_GUIDE` 被写进每条 checkpoint）、`src/index.js:274`（每条摘要头带 seq 范围）、工具注册 `src/tool.js:181-190`（默认注册 4 个名字：`lcm_expand`/`lcm_search`/`recall`/`search`）。
- 触发：任何压缩发生后。
- 影响：与"摘要型 backend"相比，模型不再需要"自己想到去搜"——checkpoint 主动告诉它怎么做、指向哪里（这正是平面④ 的收益）。安全含义是：**注入者只要能让模型调一次 `lcm_search`，就能把历史里任意曾经出现过的串重新拉进上下文并外发**。可达面变大是设计意图，不是漏洞，但它改变了"历史里出现过的东西"的暴露概率。
- 缓解：`legacyNames: false` 收窄工具面（`src/tool.js:187-190`、`src/command.js:100`）；`maxRecallTokens` 调小（`src/tool.js:31`、`src/command.js:22`）；对不可信工作流优先不装本 backend。

---

## 6. 部署加固清单

按代价从低到高，全部有代码依据：

1. **保持 `debug: false`**，不要设 `DSH_COMPACTION_DEBUG`（`src/config.js:115-116`、`config.example.yaml:74-75`）。
2. **要开 debug 就把 `debugLogPath` 钉在 `0700` 目录内的文件**，别用默认的 `/tmp`（`src/config.js:117-120`）；进程 umask 设 `077`（`src/index.js:111` 未指定 mode）。
3. **`summarizationProvider`/`summarizationModel` 要么留空，要么钉在与主对话同级的供应商**（`src/summarize.js:135-147`、`src/config.js:302-311`）。这是唯一能把整段历史送往"第二家"的开关。
4. **`maxRecallTokens` 调小**（默认 16000，`src/tool.js:31`、`src/command.js:22`、`src/recall.js:21`）：它同时限制单次把历史灌回上下文的量与 `/lcm-search` 回写量（`src/command.js:22`）。
5. **`legacyNames: false`**：默认会注册 4 个工具名（`src/tool.js:181-190`）与 2 个命令名（`src/command.js:98-100`），翻倍的是模型误调概率与提示面。
6. **按会话决定装不装**：装 = 切换（`cordis.patch.yml:11-19` 会 disable basic），所以"临时装来看看"不是无副作用操作；README 的默认立场是 opt-in（`README.md:16-22`）。
7. **把"历史里出现过的东西"当已泄露处理**：一旦进 log，`lcm_search`/`lcm_expand` 都能取回（R2/R6/R9）。密钥应走环境变量/密钥服务，不要出现在工具结果里——这一条是威胁模型，不是代码缺陷。

**不可控项（明确不在本文范围）**：dsh host 持有的 provider 凭据与网络路径、会话日志文件自身的权限与轮转（本机观察为 `drwx------`，见 §8）、provider 侧的留存与训练策略、任何时序/流量侧信道。

---

## 7. 漏洞报告方式

- **渠道**：仓库的 GitHub Security Advisory（私有报告）。仓库地址见 `ACCEPTANCE-dsh-lcm.md:8`（`github.com/zy-xyz/dsh-lcm`）。本仓库没有单独的 SECURITY/CONTRIBUTING 文件，也没有邮件列表或 CVE 流程——不要假设有 SLA。
- **报告必须带**：
  1. 版本（`package.json:3`，当前 `0.2.6`）；
  2. 命中的 `文件:行号`（本文的风格就是模板）；
  3. 最小复现。优先给**离线可跑**的：`recall`/`search`/`config`/`anchors` 都是纯函数，不需要运行中的 harness（`src/recall.js:197`、`src/search.js:100`、`src/config.js:83`、`bench/anchors.mjs:64`）；
  4. 影响判定：属于本文 R1–R9 哪一条，或新增。
- **不要**：附真实会话日志原文（其中含完整历史）；需要样本时用脱敏片段或 `test/` 里的合成夹具（`test/region.test.js:70-93`、`test/recovery.test.js:25-31`）。
- **不构成安全问题的几类**（先看这几条再报，省一轮）：
  - "插件能读到会话内容"——设计如此，且只读本文会话（§4）；
  - "摘要可能漏信息"——这是平面③的功能问题，见 `bench/REPORT.md`；
  - "debug 日志含内容"——它只有计数与编号（§2.2），若你看到正文才是真问题，请带上样本行。

---

## 8. 判定方法与可复现的观察

在仓库根目录执行（只读）：

```bash
grep -n "node:fs\|node:net\|node:http\|child_process\|fetch(\|process\.env\|appendFile\|writeFile\|readFile" src/*.js
# 实测输出（全文）：
#   src/config.js:116:    (typeof process !== "undefined" && process.env?.DSH_COMPACTION_DEBUG === "1");
#   src/config.js:118:    (typeof process !== "undefined" && process.env?.DSH_HOME
#   src/config.js:119:      ? `${process.env.DSH_HOME}/compaction-debug.log`
#   src/index.js:17:import { appendFileSync } from "node:fs";
#   src/index.js:111:    appendFileSync(config.debugLogPath, `${text}\n`, "utf8");
# → 结论：唯一磁盘写是 debug 追加；没有 fetch/net/http/child_process；没有会话日志的磁盘读。

grep -n "llm.stream\|tools.register\|commands.register\|inject =" src/*.js
# → 唯一外发是 src/summarize.js:176；工具 4 个注册点 src/tool.js:182-189；命令 2 个 src/command.js:98-100。
```

其他可复核事实：

- 会话日志文件权限（本机观察）：`~/.dsh/sessions/<slug>/<id>/session.v4.jsonl.zstd` 为 `-rwx------`，目录 `drwx------`——日志本身没暴露给同机其他用户，R3 的 `/tmp` 默认路径没有这层保护。
- `bench/` 与 `test/` **不随 npm 包发布**（`package.json:37-41` 的 `files` 只有 `src`、`cordis.patch.yml`、`README.md`）。所以"用脚本复现某项数据"只在本仓库内成立；装了包的人拿不到 bench 脚本。
- 本插件没有 `postinstall` 类脚本（`package.json:42-45` 只有 `check`/`test`），安装期不执行代码。
