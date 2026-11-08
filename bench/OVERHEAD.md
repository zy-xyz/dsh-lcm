# G2.4「净开销」：这个门测的是什么，111% 又是谁的数

> 结论（一句话）：**G2.4 现在的写法不是一个门** —— 它把「一次性成本 ÷ 被压 token 数」和 ≤30% 比较，而这个比值对任何"读 span 再写摘要"的压缩器恒 ≥100%，所以它必然判所有后端 FAIL、零区分力；而记录在案的 111.1% 根本不是本插件的数，它是 `dsh-compaction-basic` 一次生产事件的数（4 个 basic 事件实测 129.6%–173.0%，同一口径下 lcm 的最大事件 span 只有 8 232 token，从未在生产规模上被测过）。正确答案是 (a)+(c)：**仪器测错了量、门槛设在了数学上不可达的位置**；不是 (b)。

本文只写结论与证据，不改任何源码/测试/其他文档。所有数字要么是**实测**（标出处），要么明确标 **推算**。

---

## 1. 111.1% 的实际出处（provenance）

| 问题 | 结论 | 证据 |
|---|---|---|
| 111% 是哪个脚本产出的？ | **不在 `bench/` 里**。唯一产物是仓库**外层**的 `../verify-lcm.mjs`（只读 session log 的探针），D2 段 | `verify-lcm.mjs:217-240`；`grep -rn '111' bench/*.mjs` 无命中 |
| 它读的是哪个会话？ | `d45c83f5-e619-4b3a-96e7-5cb17e2f690b`，`--home-agent-workspaces--` profile 的生产会话，**只有 1 个 `compaction/summary`** | 实测：该 log 4 796 事件，start/summary/end 各 1，prune 15 |
| 那次压缩是谁做的？ | **`dsh-compaction-basic`**，不是 lcm | 三条独立判据见下 |
| `bench/REPORT.md` 有 G2.4 吗？ | **没有**。`grep 'G2\.4\|111\|overhead\|净开销'` 零命中 | 撤回只写在 `docs/ACCEPTANCE.md` §0（:98-135），REPORT 从未收录此门 |

**判定该事件属于 basic 的三条独立判据**：

1. 摘要正文的 8 个二级标题与 basic 指令逐字相同：`## Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context`（实测取自 log）＝ `dsh-compaction-basic/lib/index.js:243-278` 的 `COMPACTION_INSTRUCTION`。
2. 事件带 `maxTokens: 65536`（＝basic 的 `headroomTokens` 默认，`lib/index.js:63-64,318`）。本插件**不发** `maxTokens`，也**不记录**它（`src/summarize.js:315-353,418-431`，注释原文 "none was sent"）。
3. lcm 的可见事件一律是 5 段指令、`heads8=false`（实测 28 个 lcm 事件全部如此，basic 4 个全部 `heads8=true`）。

所以 `docs/ACCEPTANCE.md:39` 的批注「`basic` 同样 111%」在事实层面是反的：**不是两个后端都 111%，而是唯一被测量的那个后端就是 basic**。

---

## 2. 这个口径在算术上不可达（门槛错的证明）

现有口径（`verify-lcm.mjs:231-234`，与 `docs/ACCEPTANCE.md:311` 表头一致）：

    net   = (inputTokens + outputTokens) − cacheReadTokens
    ratio = net / shadowedTokenCount          门槛 ≤ 0.30

要让 `ratio ≤ 0.30`，必须 `net ≤ 0.3 × span`。而任何摘要压缩器都得**把 span 读给模型**，即 `input ≥ span`（去掉 cache 抵扣也一样，成本 ≥ span）。于是

    ratio ≥ span / span = 100%   >  30%

**无解。** 更完整的写法（带真实固定前缀 P 和输出 S）：

    ratio_min = (P + span + S) / span = 1 + (P + S)/span  >  100%

`docs/ACCEPTANCE.md:115` 给的 "101.3%" 是 P＝0 的特例，方向对但偏乐观（真实 P 见 §3）。唯一能过 ≤30% 的实现是**不读 span 的压缩器**（截断/去重/语法裁剪），那是另一个产品，不是 LLM 摘要压缩。

## 3. 这个 "net" 连单位都是混的（仪器错的证明）

provider `usage` 的字段关系是 `totalTokens = inputTokens + outputTokens + cacheReadTokens`（实测 32/32 个 `compaction/summary` 全部成立），即 **`inputTokens` 是 cache-miss 部分，不含 `cacheReadTokens`**。

于是：

- 真实 **token 消耗** ＝ `input + cacheRead + output`；
- `verify-lcm.mjs` 的 "net" ＝ `input + output − cacheRead`，它把**命中缓存的 token 当负数扣**，既不是 token 数、也不是价格（价格抵扣应 ~0.1×，不是 1×）；
- 后果实测可见：`d7951a68#6172` 的 net ＝ **−128.1%**（cache 712 192 > input+output）。一个"开销占比"能是负数，说明它不是一个比例。

顺带纠正一处文档算术：`docs/ACCEPTANCE.md:104` 写「摘要输入 593 319（含 span + system/tools 前缀 157 125）」。计入 cacheRead 后真实 prompt ＝ 707 495，固定前缀 ＝ **271 301**（`712 975 − 436 194 − 5 480`）。157 125 是把 cacheRead 漏在 prompt 外算出来的。

---

## 4. 实测：这个比值由 span 决定，不由实现决定

从全部 203 个 session log 里扫出 32 个 `compaction/summary`，分布在 18 个会话。按 §1 的判据分成两臂，逐个算 gross（全 token）/ net（探针口径）/ price（cache 按 0.1×）：

**basic（8 段指令，`maxTokens=65536`，4 个事件）**

| 事件 | span | prompt(in+cache) | out | gross | gross 比 | net 比（探针） | price 比 | 固定前缀 P | 回本(轮, gross) |
|---|---|---|---|---|---|---|---|---|---|
| d45c83f5 | 436 194 | 707 495 | 5 480 | 712 975 | **163.5%** | 111.1% | 139.9% | 271 301 | 1.65 |
| 65bd8898 | 520 822 | 892 708 | 8 258 | 900 966 | **173.0%** | 170.6% | 171.9% | 371 886 | 1.75 |
| d7951a68#6172 | 552 618 | 713 297 | 3 057 | 716 354 | **129.6%** | **−128.1%** | 13.6% | 160 679 | 1.30 |
| d7951a68#19106 | 533 961 | 765 606 | 3 635 | 769 241 | **144.1%** | 141.8% | 143.0% | 231 645 | 1.45 |

**lcm（5 段指令，28 个事件，下表列 7 个代表；span 全部 ≤8 232，因为 leaf 上限是 24 000）**

| 事件 | span | gross 比 | net 比 | price 比 | P | 回本(轮, gross) |
|---|---|---|---|---|---|---|
| 6d77a9a0 | 8 232 | 204.9% | 105.4% | 160.1% | 8 070 | 2.19 |
| d0799728#55 | 3 016 | 381.5% | 109.8% | 259.2% | 7 851 | 4.65 |
| d0799728#31 | 1 039 | 1018.1% | 1018.1% | 1018.1% | 9 013 | 16.55 |
| c775f1d5 | 2 061 | 643.5% | 246.0% | 464.6% | 10 612 | 8.89 |
| dd78fcfd#78 | 2 163 | 611.2% | 232.5% | 440.8% | 10 441 | 7.44 |
| f3e7d283#58 | 1 691 | 636.3% | 151.9% | 418.3% | 8 759 | 7.67 |
| b02454ea#23 | 918 | 2458.9% | 548.7% | 1599.3% | 8 238 | 56.15 |

（`gross 比 = (in+cache+out)/span`；`回本 = (in+cache+out)/(span − ceil(chars/4))`。`ceil(chars/4)` 是探针 D1 的摘要 token 口径。）

**读法**：

1. **两臂都在 100% 以上，无一例外**（basic 129.6–173.0%，lcm 204.9–2458.9%）。现门 0/15 通过 —— 不是后端差，是门恒假。
2. **同一实现内部跨 span 的离散度 > 两臂之间的差**：lcm 从 span 918 → 8 232 时比值从 2458.9% → 204.9%（12×）；basic 从 436k → 553k 时 129.6% → 173.0%。因为 `比值 ≈ 1 + P/span` —— 它测的是 P 与 span 的比，不是压缩器好坏。
3. **lcm 从未在生产规模上被测过**：它最大的事件 span 8 232，basic 是 436k–553k。这两个数放在同一张表里比较，本身没有意义。

**所以答案是 (a)+(c)，不是 (b)**：既没有"两个后端都 111%"这回事（只有 basic 有 111%），也不存在"两个后端开销相近"的可比测量；存在的是一个把固定前缀除到 span 上的比值，和一条低于任何读-span 压缩器下界的门槛。

---

## 5. 引擎每请求到底加了什么（回答任务的第 4 点）

- 五个监听器与 basic **同形**：`agent/pre-step`（压力）、`agent/status`（idle 清状态）、`agent/request`（模型切换闸）、`session/event`（溢出簿记）、`agent/request-error`（溢出恢复）—— `src/index.js:322-424` vs `dsh-compaction-basic/lib/index.js:834-906`。
- **无压缩发生时**每 step 的实际开销：`routedTarget()` + `tokenMeter.measure(session, header)` + `llm.resolveModelInfo()` + 一次阈值比较（`src/index.js:590-656`）。**与 basic 逐行同构**（`lib/index.js:932-960`）。lcm 多出来的只有：stall 表查一次（`index.js:677-682`）、`engineDebug` 一行（debug 关闭时是空操作）、以及 `selectCompactableRange` 多传三个守卫参数（只在**越过阈值之后**才调用）。
- `agent/request` 只在 provider/model 变了时做测量（`index.js:359-368`），同模型请求直接返回。
- 结论：**没有任何"每请求净开销"是多出来的**；111% 全部来自那一次摘要调用本身。门叫 "overhead"，量的却是"摘要一次性成本 ÷ span" —— 名字与口径错配，也是把它当"热路径税"读会得出错误结论的原因。

**一个真实的结构差异（修好门之后才会显形）**：lcm 把每次压缩的 span 上限钉在 `leafSpanTokens = 24 000`（`src/config.js:62`，`src/region.js:130-152`，从最老节点起算、按 tool-pair 平衡回退），所以同一个 436k 历史需要 **19 个 leaf**，而每个 leaf 的摘要请求都要**重发一次固定前缀**（`src/summarize.js:301-360`：`[system, ...regionMessages, instruction]` + `header.tools`）。basic 只发一次。

| 同一 436 194 token 历史 | 调用次数 | token 计数（gross） | 相对 basic |
|---|---|---|---|
| basic（1 次压缩到位） | 1 | 712 975 | 1.00× |
| lcm（19 × 24k leaf，P＝271 301） | 19 | 5 665 439 | **7.95×（推算）** |

缓存吃掉大部分钱但吃不掉 token 计数：若 leaf 2..19 的 P 全命中（0.1×），价格当量 ≈ 298 181 + 18×54 010 ≈ 1 270 361，仍是 basic（610 217 价格当量）的 **2.08×（推算）**。这不是本次要判的结论，但它是"leaf 设计 vs 前缀成本"的真实取舍，必须在门里有位置，否则会被 §2 那种恒假门槛整个遮住。

---

## 6. 正确的门措辞（可判、可复现、不降标准）

**G2.4′（替换现 G2.4）净开销：摊销回本 ≤ 3 轮**

| 项 | 定义 |
|---|---|
| 成本 C | `inputTokens + cacheReadTokens + outputTokens`（provider `usage` 实测；**不做 cache 抵扣** —— 抵扣是价格效应，不是 token 数） |
| 收益 Δ | `shadowedTokenCount − ceil(summaryChars/4)`（该次压缩在**之后每一轮**都生效的常驻缩减） |
| 判据 | `R = C / Δ ≤ 3.0`，逐 `compaction/summary` 事件算，取同一后端的加权值 `ΣC / ΣΔ`，不是单事件最大值 |
| 样本要求 | 必须在 **span ≥ 200 000 token** 的真实历史上测（低于这个量级 P/span 主导结果；实测：span 1 039 时同一实现给出 16.55 轮） |
| 同表记录（不作判据） | `gross 比 = C/span`、`price 当量 = input + 0.1·cacheRead + output`、`P/C`（固定前缀占比）、leaf 数 |
| 对照臂 | 同一历史、同一模型、**同一条 prefix**：basic 与 lcm 各出一组 (C, Δ, R)，两臂都报 |
| 附条（可选硬门） | `R_lcm ≤ 1.5 × R_basic` —— "不比自带压缩差"在成本侧的等价物，对应质量侧 G2.10 的做法 |
| 明确弃用 | `(input+output−cacheRead)/shadowed ≤ 30%` |

**为什么这不是降标准**：

- 旧门对**任何**读 span 的摘要器恒判 FAIL（§2 的不等式无解），信息量 = 0；它不是"严"，是"错"。
- 新门在**同一批实测数据**上两端都能触发：basic 的 4 个事件 R ＝ 1.30 / 1.45 / 1.65 / 1.75 → **PASS**；lcm 在 span 1 039 的事件 R ＝ 16.55、span 918 的 R ＝ 56.15 → **FAIL**。能过能不过，才是门。
- 它保住原意（压缩必须回本），去掉不可达的尺度（成本不可能小于它读掉的 token），并把"leaf 化会重复付前缀"这个真实成本暴露成可测量，而不是埋在 111% 里。

**还要一起改的两处（都在 `docs/ACCEPTANCE.md`，本文件不改）**：

1. :104 的「前缀 157 125」→ 计入 cacheRead 后是 **271 301**（或明确写出 `inputTokens` 不含 cacheRead）。
2. :126 的「回本 ≈ 1.12 轮」是 net 口径；按全 token 成本是 **1.65 轮**，按价格当量是 **1.41 轮**。三者都该列，判据取 gross。

**还缺的那次测量（lcm 在生产规模上从未被测）**——不在这里跑，命令如下：

    # 1) 让 lcm 在一个 ≥200k、自带真实 toolset 的会话上压一次（headless 派生 profile，别碰 web profile）
    dsh --profile lcmhead --session-id <SESSION_ID> "继续"    # 触发 pressure 路径

    # 2) 逐事件算 R（只读 session log；等同 verify-lcm.mjs D2 的修正口径）
    node --input-type=module -e '
    import fs from "node:fs"; import zlib from "node:zlib";
    const f = process.argv[1] + "/session.v4.jsonl.zstd";
    const ev = zlib.zstdDecompressSync(fs.readFileSync(f)).toString("utf8")
      .split("\n").filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
    for (const e of ev.filter(x => x.type === "compaction/summary")) {
      const d = e.data, u = d.usage ?? {};
      const C = (u.inputTokens|0) + (u.cacheReadTokens|0) + (u.outputTokens|0);
      const st = Math.ceil((d.summary ?? []).reduce((n, b) => n + (b.text ?? "").length, 0) / 4);
      const delta = d.shadowedTokenCount - st;
      console.log("seq=" + e.seq + " span=" + d.shadowedTokenCount + " C=" + C
        + " delta=" + delta + " R=" + (C/delta).toFixed(2)
        + " gross=" + (C/d.shadowedTokenCount*100).toFixed(1) + "%"
        + " hasMaxTokens=" + (d.maxTokens !== undefined));
    }' <SESSION_DIR>

`hasMaxTokens=false` 是"这一事件出自 lcm"的现成标记（§1 判据 2）。

---

## 7. 落地清单（给上游，按优先级）

1. 把 G2.4 换成 G2.4′（§6 表），并把 `docs/ACCEPTANCE.md:39,311` 的「`basic` 同样不达标」改成事实版：**111.1% 是 basic 的单事件实测，lcm 在生产规模上未测**。
2. `verify-lcm.mjs:231-234` 的 D2 换成 §6 的 C/Δ 口径（否则任何按它复现的人都拿不到可比数）。
3. 补测 §6 末尾那一次（lcm × ≥200k 历史），把 (C, Δ, R, P, leaf 数) 记进 `bench/REPORT.md`。
4. 若要压 leaf 的前缀成本：让同一次 compaction 内的多个 leaf 共用一个请求（多 leaf 批处理），或把 `leafSpanTokens` 提到与 P 同量级。前者改实现，后者改配置 —— 但先有 §6 的数再决定。

---

*证据来源：`/home/agent/.dsh/sessions/**/session.v4.jsonl.zstd`（203 个会话，32 个 `compaction/summary`）；`docs/ACCEPTANCE.md:39,88,98-135,311`；`../verify-lcm.mjs:217-240`；`src/index.js:322-424,590-656,677-682`；`src/config.js:49,51,62,71,234`；`src/region.js:130-152`；`src/summarize.js:301-360,418-431`；`@deepseek-ai/dsh-compaction-basic@0.2.2-rc.1/lib/index.js:63-64,243-278,318,834-906,932-978`。*

