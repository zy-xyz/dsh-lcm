# G2.4′ 的 lcm 臂：一次可辩护的**推算**，以及它不能关掉这个门

> 一句话结论：lcm 在 436 194 token 历史上 **R = 7.38**（basic 实测 1.65），是 basic 的 **4.47×**；
> 而且这个倍数**不随历史变长而收敛**，它收敛到 **5.01**。根因不是输出、不是跨度，是**固定前缀 P 被重复支付 19 次**：
> P = **96 355**（其中 98.6% 是系统提示），19 个叶里前缀占 C 的 **80.2%**。
> 这不关闭 G2.4′（门要求 `usage` 实测，本文全是推算），但它把「lcm 臂待测」变成了「lcm 臂有一个可被一次测量证伪的具体预测」。

本文只新建 `bench/COST-PROJECTION.md`，不改任何源码/测试/其他文档。**所有数字要么标 MEASURED（来自真实 `usage` 或真实代码/日志），要么标 PROJECTED（在 MEASURED 组件上做的算术）。两者不混。**

---

## 0. 标注约定

| 标记 | 含义 | 出处 |
|---|---|---|
| **MEASURED** | 真实 `usage` 记录、真实 session log、真实代码常量、真实 bench 结果文件 | 每处给出文件:行或日志路径 |
| **PROJECTED** | 只做加减乘除，输入全部是 MEASURED | 给出算式 |

**没有任何数字来自模型调用。** 本文不发起一次 LLM 请求；所有组件都从代码、日志、既有 bench 结果里读出来。

---

## 1. 一次摘要请求的固定前缀 P（MEASURED 组件 + 一处标定）

### 1.1 请求长什么样（读代码，不是读文档）

`src/summarize.js:301-360`（`summarizeLeaf`）：

```js
const messages = system === null ? [...regionMessages, instruction] : [system, ...regionMessages, instruction];
const options = {
  provider, model,
  maxTokens: Math.max(4096, budgetTokens * 2),
  messages,
  ...(typeof session.toolHistory === "function" ? { toolHistory: session.toolHistory() } : {}),
  ...(header?.tools === undefined ? {} : { tools: [...header.tools] }),
  sessionId, purpose: "compaction",
};
```

所以一个摘要请求的**全部**输入 =

```
  system/message（会话头，永不进 span）
+ regionMessages（被压掉的 span 原文）
+ instruction（buildInstruction 的输出，一条 user message）
+ tools 声明（header.tools 的投影）
```

前三项在 `messages` 里，第四项是请求信封的独立字段。**这四项都必须计入**，因为 provider 的 `inputTokens + cacheReadTokens` 包含它们全部。

### 1.2 用哪个估算器，为什么

**用 `chars/4 + 4`（token meter 的定价），不用 `estimateEntryTokens`。**

理由不是偏好，是**量纲一致性**，这一点可以验证：

- G2.4′ 的分子 `C` 与分母 `Δ = shadowedTokenCount − ceil(summaryChars/4)` 里都出现 `shadowedTokenCount`，而它是 `@deepseek-ai/dsh-token-meter` 按 `chars/4 + 4`（每个 text block 加 4）算出来的，不是 `estimateEntryTokens`。
- 我把 d45c83f5 那次压缩的 787 个 shadowed seq 逐个按 `chars/4+4` 重算，得到 **436 194**，与日志里的 `shadowedTokenCount` **逐 token 相等**（diff = 0）。换 `estimateEntryTokens` 算同一批节点是 **683 779**（1.567×）。**两个估算器对同一段原文差 57%，把前缀用另一个算就变成了混单位。**

所以：**前缀、span、摘要三者全部用 `chars/4 + 4` 定价**，与 `shadowedTokenCount` 同源。

（`estimateEntryTokens` 的数也一并给出，供对照：指令 693 → 1 374。全文判据不采用它。）

### 1.3 三个组件（MEASURED）

| 组件 | 来源 | 字符 | `chars/4+4` | 占 P |
|---|---|---|---|---|
| `system/message`（会话头） | 日志 `seq 13`，`d45c83f5…/session.v4.jsonl.zstd` | 380 120 | **95 034** | 98.63% |
| `header.tools`（1 个工具：`run_code`） | 日志 `request/header seq 4203` | 2 496 | **628** | 0.65% |
| `buildInstruction(2880, 24000, 0)` | 运行时构造（`src/summarize.js:124`） | 2 753 | **693** | 0.72% |
| **P（合计）** | | | **96 355** | 100% |

指令的 2 880 = `resolveSummaryBudget` 对一个 24 000 的叶给出的 target：`min(16384, max(512, floor(24000 × 0.12))) = 2880`（`src/config.js:360-364`，`summaryRatio=0.12`，`checkpointCap=16384`）。指令文本随 target 变化很小（target 512→2880，字符数 2 713→2 753）。

`RECALL_GUIDE`（567 字符）与 `CHECKPOINT_PREAMBLE`（300 字符）+ 标签（45 字符）**不在请求里**：它们是 `frameCheckpoint` 写进**替代用的 checkpoint**（`src/compiler.js:333-344`），属于输出侧的记账，不属于输入。它们对 Δ 的影响单独算在 §5.4（R 从 7.38 → 7.45）。

### 1.4 从 meter 价到 provider token 的标定 k（MEASURED）

meter 价与 provider 的 `inputTokens + cacheReadTokens` 不是同一个量：provider 有自己的 tokenizer。用**同一次实测事件**标定：

```
basic 事件 d45c83f5:  provider prompt = 593 319 + 114 176 = 707 495
同一请求的 meter 价   = 95 034（system）+ 436 194（span）+ 628（tools）+ 455（basic 指令）
                      = 532 311
k = 707 495 / 532 311 = 1.3291
```

**交叉验证**：把同一算式套到 4 个真实 lcm 事件上，k = 1.136 / 1.128 / 1.229 / 1.070。差异来自内容语种与工具集不同（那 4 个会话是 27 个工具、小系统提示）。所以 **k 的实测区间是 1.07–1.33**。

**这一步不是估计，是标定**：它用一次真实 `usage` 把 meter 价换算到 provider 口径。检验方式见 §6：用 k=1.3291 反算 basic 自己的 R，得 1.650，与实测 1.649 差 0.06%。

---

## 2. 一个叶的跨度上限到底是什么（读代码，纠正任务描述里的疑问）

**不是 24 000，也不是 48 000。24 000 是阈值，不是硬上限。**

`src/region.js:157-179`：

```js
let span = 0;
let endIdx = firstIdx;
for (let index = firstIdx; index < keepFromIdx; index += 1) {
  span += pricedNodes[index].tokens;
  endIdx = index;
  if (span >= maxSpanTokens) break;     // ← 越过就停，但这一节点已经计入
}
while (endIdx > firstIdx && !toolPairingBalancedAfter(session, surfaceNodes[endIdx])) endIdx -= 1;
```

累加到 **≥ 24 000 的那个节点为止**，所以一个叶的实际跨度 = 24 000 + 最后一个节点的余量 − 为了不切断 tool-pair 回退掉的部分。

- **MEASURED**（`bench/ASSEMBLY.md:161-167`，真选择器 + 真 `deriveDag` 的 40 轮重放）：实际跨度 **24 300 / 24 596 / 24 632 / 24 636 / 24 636 / 24 636 / 24 636**，均值 **24 582**（+2.4%）。
- 代码里唯一的「2×」是 `maxTokens = max(4096, 2 × target)`（`src/summarize.js:344`，那是**输出**上限）和 `spanTokens <= 2 * minTokens` 的拒绝阈值（`src/region.js:196`）。**没有 2×24 000 的跨度上限。**

本文主表用**名义 24 000**（19 个叶），§5.4 给按实测均值 24 582（18 个叶）的对照。

---

## 3. 每叶输出：用实测分布，不用猜测

### 3.1 任务描述里那个「300–1213 可见 token」的数在 §32 里找不到

`bench/REPORT.md` §32（:940-996）的叶输出是**字符**，不是 token：

| 叶 | 0-9 | 10-16 | 17-25 | 26-34 | 35-41 | 42-49 | 50-53 |
|---|---|---|---|---|---|---|---|
| 输出字符 | 4 130 | 5 187 | 5 621 | 4 526 | 6 023 | 7 726 | 4 425 |
| ÷4（token） | 1 033 | 1 297 | 1 406 | 1 132 | 1 506 | 1 932 | 1 107 |

**MEASURED**：7 个真实叶，字符 4 130–7 726，token（`chars/4`）**1 033–1 932**，中位 **1 297**。

**关于任务描述里的「300–1213 可见 token」**：我在 §32 全文、`bench/results/leaf-chunks-*.{json,md}`、以及全部 bench 结果文件里逐条查过，**没有这个区间**。§32 表里只有字符数（4 130–7 726），除以 4 是 1 033–1 932；leaf-chunks 的 15 个叶 `outputTokens` 是 154–3 276。**所以本文不采用 300–1213，改用实测的 1 033–1 932（Δ 侧）与 154–3 276 / 中位 1 172（C 侧）。**

### 3.2 C 侧的 output 用账单口径

G2.4′ 的 `C` 用 `usage.outputTokens`，它**含隐藏 reasoning**。所以 Δ 侧用 §32 的可见字符，C 侧用真实计费输出，两者**故意不同源**，因为门就是这么定义的。

**MEASURED**（`bench/results/leaf-chunks-20261108(-sample8).json`，15 个真实叶的 `outputTokens`）：
154 / 352 / 479 / 489 / 745 / 1012 / 1095 / **1172** / 1286 / 1412 / 1463 / 1538 / 1805 / 2400 / 3276
中位 **1 172**，均值 1 245，区间 **154–3 276**。

### 3.3 采用值

| 用途 | 值 | 依据 |
|---|---|---|
| Δ 侧的 `ceil(summaryChars/4)` | **1 297** | §32 七个真实叶 token 的中位数（MEASURED） |
| C 侧的 `outputTokens` | **1 172** | 15 个真实叶计费输出的中位数（MEASURED） |

---

## 4. 一个叶的成本（PROJECTED，输入全 MEASURED）

```
C_leaf = k × (P + S) + out
       = 1.3291 × (96 355 + 24 000) + 1 172
       = 1.3291 × 120 355 + 1 172
       = 159 964 + 1 172
       = 161 136

Δ_leaf = S − ceil(summaryChars/4) = 24 000 − 1 297 = 22 703

R_leaf = 161 136 / 22 703 = 7.10
```

**读法**：`P/S = 96 355/24 000 = 4.01`。也就是每读 1 token 的叶内容，要**先付 4 token 的前缀**。R_leaf 的下界是 `k × (1 + P/S) = 6.67`，叶本身再省也省不到 3.0 以下。

---

## 5. 436 194 token 历史：叶数、C、Δ、R（PROJECTED）

### 5.1 叶数

```
n = ceil(436 194 / 24 000) = 19
跨度 = 18 × 24 000 + 4 194
```

（MEASURED 的均值 24 582 下 n = 18，见 §5.4。）

### 5.2 总 C

```
前缀：19 × 1.3291 × 96 355 = 2 433 243
span：1.3291 × 436 194      =   579 745
输出：19 × 1 172            =    22 268
─────────────────────────────────────
C = 3 035 256   （逐叶相加 3 035 257，舍入差 1）
```

**C 的构成**：前缀 **80.2%**、span 19.1%、输出 **0.7%**。
**输出在成本里可以忽略** —— 这也解释了为什么「提高输出质量」不改变成本结论。

### 5.3 总 Δ（两种口径都给，结论不依赖选择）

G2.4′ 定义 `Δ = shadowed − ceil(summaryChars/4)`。整段历史压成 19 个叶时，Δ 有两种合理读法：

| 口径 | 算式 | Δ | R |
|---|---|---|---|
| **keep-all**（每个叶的摘要都常驻） | 436 194 − 19 × 1 297 | **411 551** | **7.38** |
| **reabsorb**（今天的实现：表面只留 1 个 checkpoint，`bench/ASSEMBLY.md` §3 实测） | 436 194 − 1 297 | 434 897 | 6.98 |

    R_lcm(436 194) = 3 035 256 / 411 551 = 7.38

**两个都 > 3.0，结论不依赖这个选择。** 主表取 keep-all（Δ 更大 = R 更小 = 对 lcm 更有利），仍不过门。

### 5.4 五个敏感性检查（全部不改变结论）

| 变体 | R | 说明 |
|---|---|---|
| 实测跨度均值 24 582（n = 18） | **7.04** | MEASURED 跨度，C = 2 906 019 |
| k = 1.0（**完全不算 provider 的 tokenizer 膨胀**） | **5.56** | C = 2 289 207，最保守下界 |
| k = 1.07（实测区间下限） | **5.95** | |
| Δ 里再扣掉 checkpoint 框架（912 字符 = 228 token/叶） | **7.45** | `RECALL_GUIDE` + `PREAMBLE` + 标签 |
| 输出按实测最大值 3 276（而不是中位 1 172） | **7.47** | 输出项对 R 几乎无影响：+1.2% |

**即使把 k 压到 1.0（假设 meter 价就是 provider 价），R = 5.56 > 3.0。结论不依赖标定。**

---

## 6. basic 单次到位（MEASURED）

`d45c83f5` 的 `compaction/summary`（`seq 4246`，`shadowedRange 14-3019`，787 个 seq）：

```
usage = { inputTokens 593 319, cacheReadTokens 114 176, outputTokens 5 480, totalTokens 712 975 }
C     = 593 319 + 114 176 + 5 480 = 712 975                    ← MEASURED
Δ     = 436 194 − ceil(15 272/4) = 436 194 − 3 818 = 432 376   ← MEASURED（摘要 15 272 字符）
R     = 712 975 / 432 376 = 1.649                               ← MEASURED
```

**模型自检**：用同一套 k/P 算式反算 basic —— `1.3291 × (96 355 + 436 194) + 5 480 = 713 291`，`R = 713 291 / 432 376 = 1.650`，与实测 `712 975 / 432 376 = 1.649` 差 **0.06%**（C 差 316 token，来源是 lcm 指令比 basic 指令长 238 meter token）。**模型对 basic 是准的，所以对 lcm 的推算不是凭空外推。**

### 两臂对照

| | 调用次数 | C | Δ | **R** | 前缀占 C |
|---|---|---|---|---|---|
| basic（MEASURED） | 1 | 712 975 | 432 376 | **1.65** | 17.9% |
| lcm（PROJECTED） | 19 | 3 035 256 | 411 551 | **7.38** | **80.2%** |

    R_lcm / R_basic = 7.38 / 1.65 = 4.47×

**关键对照**：basic 也付同一个 P（96 117，含它的指令），但**只付一次**，占它 C 的 17.9%。lcm 付 19 次，占 80.2%。**两臂的差别不是「谁压缩得更好」，是「同一个前缀被收了几次费」。**

---

## 7. 交叉点与门槛（PROJECTED）

### 7.1 为什么这个倍数不随历史变长而收敛

```
R_basic(H) → k = 1.33                              （H → ∞，前缀摊薄）
R_lcm(H)   → k × (1 + P/S) = 1.3291 × 5.01 = 6.67
R_lcm / R_basic → 1 + P/S = 1 + 96 355/24 000 = 5.01
```

**这个 5.01 只由 `P/S` 决定，与历史长度无关。** 它是叶设计的结构性常数，不是某个会话的偶然。

### 7.2 交叉点

| H (token) | 叶数 | R_basic | R_lcm | 倍数 |
|---|---|---|---|---|
| 24 000 | 1 | 8.20 | 7.10 | **0.87** |
| **24 001** | **2** | 8.20 | **13.56** | **1.65** |
| 48 000 | 2 | 4.47 | 7.10 | 1.59 |
| 100 000 | 5 | 2.77 | 8.33 | 3.01 |
| 200 000 | 9 | 2.04 | 7.59 | 3.73 |
| 436 194 | 19 | 1.65 | 7.38 | **4.47** |
| 1 000 000 | 42 | 1.47 | 7.15 | 4.87 |
| ∞ | — | 1.33 | 6.67 | 5.01 |

**答案（a）**：倍数跨过 1.5× 的位置是**第二个叶出现的瞬间，H ≈ 24 001**（1.65×），此后从未回到 1.5 以下（H > 24 583 区间内最小值 1.59，出现在 H = 47 834）。1 个叶时 lcm 甚至略优（0.87×）—— **叶化本身才是成本来源，不是 lcm 的实现。**

**答案（b）：在 `leafSpanTokens = 24 000` 下，lcm 的 R 在任何历史长度都进不了 3.0。** 因为它的下界是 `k(1 + P/S) = 6.67`，与 H 无关。要让 R_lcm ≤ 3.0，必须动 `S` 或 `P`：

| 手段 | 需要 | 依据 |
|---|---|---|
| 抬高 `leafSpanTokens` | S ≥ **79 675**（叶级 R ≤ 3）；或 S ≥ **76 645**（渐近 R ≤ 3） | `S ≥ (kP + out + 3·Δout)/(3 − k)` |
| 压缩前缀 | P ≤ **26 363**（S = 24 000 时） | 反解同一不等式 |
| 实测 436k 上聚合 R ≤ 3 | `leafSpanTokens ≥ 87 500`（n = 5，R = 2.85） | 逐档扫描 |

**`leafSpanTokens` 扫描（H = 436 194）**：

| S | 叶数 | C | R | 相对 basic |
|---|---|---|---|---|
| 24 000（默认） | 19 | 3 035 257 | **7.38** | 4.47× |
| 32 000 | 14 | 2 389 069 | 5.71 | 3.47× |
| 48 000 | 10 | 1 872 120 | 4.42 | 2.68× |
| 64 000 | 7 | 1 484 407 | 3.48 | 2.11× |
| 80 000 | 6 | 1 355 170 | 3.16 | 1.92× |
| **87 500** | **5** | **1 225 933** | **2.85** | 1.73× |
| 131 072 | 4 | 1 096 695 | 2.54 | 1.54× |
| 200 000 | 3 | 967 458 | 2.24 | 1.36× |
| 436 194（= 1 叶） | 1 | 708 983 | **1.63** | **0.99×** |

**最要紧的一行**：**把上限抬到「一次压完」时，R = 1.63，与 basic 的 1.65 相同。** 也就是说：**lcm 的成本问题 100% 来自「把一次压完切成了 19 次」，与它读同样的 span、写同样的摘要这件事本身无关。** 这句话同时是 §10 的判据。

### 7.3 P 是被谁撑大的

| 配置 | system | tools | 指令 | P | 436k 上的 R | 相对 basic |
|---|---|---|---|---|---|---|
| 本会话（实测） | 95 034 | 628（1 工具） | 693 | **96 355** | 7.38 | 4.47× |
| `--tmp--` 的 4 个 lcm 事件（实测） | 598 | 5 850（27 工具） | 693 | **7 141** | **1.90** | 1.15× |
| 理论下界（无 system、无 tools） | 0 | 0 | 693 | 693 | 1.51 | 0.91× |

**MEASURED 的 4 个 lcm 事件里，P 只有 7 141，因为它们没有那个 380 120 字符的系统提示。** 那一档推算的 R = 1.90，能过门。
**所以 G2.4′ 在 lcm 臂上的成败，主要取决于「被压缩的会话有多大的系统提示」，而不取决于 lcm 的算法。** 这一点必须在门里说清，否则同一个实现会在两档之间判出相反结论。

---

## 8. 这一节是本文最该被记住的：它**不关闭** G2.4′

G2.4′ 的样本要求是 **`usage` 实测、span ≥ 200 000**。本文：

- 有 `usage` 实测的 lcm 事件只有 4 个，最大 span **3 016**（`session-d0799728#55`）；
- 436k 上的 lcm 数**全部是推算**，一个 `usage` 记录都没有。

所以门的判据状态**不变**：basic 臂 PASS（1.30 / 1.45 / 1.65 / 1.75），lcm 臂 **待测**。
本文新增的是一条**可被证伪的预测**：

> 在一个 ≥200k 历史、系统提示量级 380k 字符的会话上跑 lcm，聚合 R 应当落在 **6.9–7.5**（k 取 1.07–1.33），且**调用次数应当约为 ceil(H/24 000)**。
> 若实测 R < 3.0，本文的 P 定价或叶切分模型有错，需要重做；若实测 R 在 6.9–7.5，则 §7 的结论成立。

### 关闭这个门的**确切命令**

```bash
# 1) 在 ≥200k 历史、且带真实 toolset 的会话上让 lcm 压一次（派生 profile，别碰 web profile）
dsh --profile lcmhead --session-id <SESSION_ID> "继续"     # 触发 pressure 路径

# 2) 逐事件算 R（只读 session log，与 G2.4′ 同口径）
node --input-type=module -e '
import fs from "node:fs"; import zlib from "node:zlib";
const dir = process.argv[1];
const ev = zlib.zstdDecompressSync(fs.readFileSync(dir + "/session.v4.jsonl.zstd"))
  .toString("utf8").split("\n").filter(Boolean)
  .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
let C = 0, D = 0, n = 0;
for (const e of ev.filter(x => x.type === "compaction/summary")) {
  const d = e.data, u = d.usage ?? {};
  const c = (u.inputTokens|0) + (u.cacheReadTokens|0) + (u.outputTokens|0);
  const s = Math.ceil((d.summary ?? []).reduce((m, b) => m + (b.text ?? "").length, 0) / 4);
  const delta = d.shadowedTokenCount - s;
  C += c; D += delta; n += 1;
  console.log("seq=" + e.seq + " span=" + d.shadowedTokenCount + " C=" + c
    + " delta=" + delta + " R=" + (c/delta).toFixed(2)
    + " isLcm=" + (d.maxTokens === undefined));
}
console.log("AGG n=" + n + " C=" + C + " delta=" + D + " R=" + (C/D).toFixed(2));
' <SESSION_DIR>
```

判据：`AGG R ≤ 3.0`。`isLcm=true`（即 `maxTokens` 缺失）是「该事件出自 lcm」的现成标记。

**必须同时记录的三项**（否则无法判断是 P 还是叶数造成的）：`P`（= `prompt − shadowed`）、调用次数、以及该会话的系统提示字符数。

---

## 9. 哪些组件**无法**从代码推出（不静默估算）

| 组件 | 状态 | 为什么 |
|---|---|---|
| provider 的 tokenizer 对**这段具体文本**的定价 | **无法推出**，只能用 k 标定 | meter 是 `chars/4` 启发式；provider 用自己的 BPE。本文用 1 次真实 `usage` 标定出 k = 1.3291，并给出实测区间 1.07–1.33 与 k=1.0 的保守下界 |
| 每叶实际写多少（模型行为） | **不能推**，只能用实测分布 | §32 的 7 个叶与 leaf-chunks 的 15 个叶是实测；模型换版本就会变。本文用中位数，并给出极值敏感性（输出项对 R 的影响 < 0.1） |
| 前缀缓存命中率对**价格**的影响 | **不在本文口径内** | G2.4′ 明确不做 cache 抵扣（`bench/OVERHEAD.md` §6）。若要算价格当量，乘 0.1 的 cacheRead 系数即可，但那是另一个量 |
| 19 个叶之间是否有 provider 侧前缀缓存复用 | **不确定** | `toolHistory` 存在时适配器只发 delta（`src/summarize.js:338-341` 注释），理论上叶 2..19 的 system+tools 可命中缓存。但 `C` 计的是 token 数不是钱，命中缓存也不减 token，所以**不影响 R** |
| 实测跨度 24 582 的精确叶数 | 取决于该会话的节点粒度 | 本文用 MEASURED 的均值做敏感性（n = 18，R = 7.04），主表用名义 24 000 |

---

## 10. 叶这个单位在生产规模上站不站得住

**结论：24 000 的叶单元在成本上站不住，在正确性上站得住；两者必须分开定价。**

- **成本侧站不住**：`P/S = 4.01` 意味着每叶 80% 的 token 花在重复的前缀上。这不是「略贵」，是把一次 O(H) 的成本变成 19 次 O(S + P) —— 量级不变，常数是 5 倍，且**不随上下文变长自愈**（§7.1）。
- **正确性侧站得住**：`bench/REPORT.md` §32 的 7/7 全 6 节齐全、finish 全 stop，对照整段一次压反复只剩 1 节；可答性 4/4 vs 0/4。叶化修掉的是**截断**，那是正确性问题。**不能因为成本把叶改回一次压完。**
- **因此正确的动作不是二选一，是解耦**：
  1. **降低 P**（把系统提示与工具声明从摘要请求里剥掉，或让同一批叶共用一个请求）：P 从 96 355 降到 **26 363 以下**即可在 S = 24 000 上过门。这是**唯一不动正确性的旋钮**。
  2. **抬高 S**：S ≥ **87 500** 在 436k 上给出 R = 2.85。代价是每叶更容易漏细节（§32 的结论：24k 是「不被打断」的区间；87.5k 是否仍不打断，**未测**）。
  3. **不动**：若维持 S = 24 000 且 P = 96 355，则 G2.4′ 在 lcm 臂上必然 FAIL（R ≈ 7.4）。这是设计的必然结果，不是缺陷 —— 应在门里写明，而不是等一次测量去发现。

**一句话给门用**：lcm 的成本问题等价于 `P/S`。当前 `P/S = 4.01`；要求 `k(1 + P/S) ≤ 3`，即 `P/S ≤ 1.26`。**在 24 000 的叶上，前缀必须压到 30 000 以下；或者叶抬到 80 000 以上。**

---

*证据来源（全部只读）：*
`src/summarize.js:124,301-360,344` · `src/compiler.js:280-301,333-344` · `src/config.js:52,62,72,95,360-364` · `src/region.js:157-179,196` ·
`@deepseek-ai/dsh-token-meter/lib/index.js`（`CHARS_PER_TOKEN=4`, `BLOCK_OVERHEAD=4`）·
`@deepseek-ai/dsh-compaction-basic/lib/index.js:234,243-278,290-330` ·
session log `/home/agent/.dsh/sessions/--home-agent-workspaces--/d45c83f5-e619-4b3a-96e7-5cb17e2f690b/session.v4.jsonl.zstd`（`seq 13` system、`seq 4203` header、`seq 4246` summary）·
`/home/agent/.dsh/sessions/--tmp--/session-{b02454ea,d0799728}-*/session.v4.jsonl.zstd`（4 个 lcm 事件）·
`bench/REPORT.md:940-996`（§32 叶输出字符）· `bench/ASSEMBLY.md:161-167`（实测跨度）·
`bench/results/leaf-chunks-20261108{,-sample8}.json`（15 个叶的计费输出）· `bench/OVERHEAD.md` §6（G2.4′ 定义）·
`docs/ACCEPTANCE.md:39,138-149`
