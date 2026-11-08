# ACON 失败驱动指引优化 —— 交接（2026-11-08，子代理 lcm-acons）

## 0. 状态：**已停，未做任何新的模型调用**

主控在 05:00Z 左右要求停一切模型调用（网关被两个进程并发打到 502）。下面是停之前的全部产出，以及停在哪里。

| 步骤 | 状态 | 落盘 |
|---|---|---|
| 第 1 步 机械表 | **完成**（15/15 题的 gold 定位与形态；7 题的 checkpoint 分节实测） | `bench/results/acon-step1-20261108.json`、`acon-before-20261108.json.jsonl`（7 行） |
| 第 2 步 强模型分析 | **未执行**（需要 1 次模型调用，被叫停）。提示词已生成并落盘，可直接发 | `bench/results/acon-analysis-prompt-before.txt`（22798 字符，7 组配对） |
| 第 3 步 改指引 + 测量 | **未执行**（改文件按主控要求不做；before/after 15 题测量由主控跑） | — |

**所以：我这边没有「模型的结论原文」可以交**。第 2 步的输入我准备到了可直接打一枪的程度，但结论是模型给的，不是我给的，我不会替它编。

---

## 1. 第 1 步：机械表（ACON 的输入）

配对判据 `full-context.judge.verdict === "CORRECT" && lcm-oneshot.judge.verdict !== "CORRECT"`，实测 **15 组**（与主控一致）。haystack 每组 452–564 条消息（`longmemeval_s.json`，sha256 `08d8dad4…7894`）。

"HEAD 指令下" 一列，指 `git show HEAD:src/summarize.js`（commit `accfa79`，即锚点分类改动之前的原文），快照在 `bench/snapshots/summarize-head.mjs`；用 balanced-lite 重压、`budget = min(16384, max(512, floor(tokens*0.12)))`（本题组一律 16384）。

| # | qid | type | gold | form | gold 在 haystack（首次出现） | 出现次数 | HEAD 指令下 gold 在 checkpoint | ck 字符 / 锚点占比 / 叙述字符 | 旧跑 ck 字符 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | e47becba | single-session-user | `Business Administration` | prose-short | s52 answer_280352e9 seq 530 | 2 | **NO** | 7247 / 85% / 1090 | 4839 |
| 2 | 95bcc1c8 | single-session-user | `10` | numeric/time | s2 sharegpt_J3KJuOr_0 seq 29 | 53 | YES | 14446 / 66% / 4964 | 19124 |
| 3 | 76d63226 | single-session-user | `55-inch` | prose-short | s8 answer_bbdc7b0a seq 76 | 1 | **NO** | 4474 / 73% / 1216 | 3298 |
| 4 | 00ca467f | multi-session | `2` | numeric/time | s0 sharegpt_3cVjZ2b_16 seq 0 | 189 | YES | 9277 / 90% / 964 | 4840 |
| 5 | 81507db6 | multi-session | `3` | numeric/time | s0 ultrachat_491631 seq 1 | 184 | — | — | 3820 |
| 6 | 505af2f5 | single-session-preference | `The user would prefer responses th…` | prose-long | **逐字未命中** | 0 | **NO** | 20552 / 78% / 4464 | 4048 |
| 7 | 6456829e | multi-session | `8` | numeric/time | s1 5bed6828 seq 5 | 59 | YES | 10816 / 84% / 1699 | 3931 |
| 8 | 0ea62687 | multi-session | `2` | numeric/time | s0 answer_dc5e537d_1 seq 1 | 179 | — | — | 11060 |
| 9 | efc3f7c2 | multi-session | `30 minutes` | prose-short | s16 88a7faa7_1 seq 166 | 10 | **NO** | 17515 / 100% / 0 | 14335 |
| 10 | gpt4_18c2b244 | temporal-reasoning | `First, I used a Buy One Get One Fr…` | prose-long | **逐字未命中** | 0 | — | — | 14578 |
| 11 | gpt4_98f46fc6 | temporal-reasoning | `I participated in the charity bake…` | prose-short | **逐字未命中** | 0 | — | — | 4910 |
| 12 | 6613b389 | temporal-reasoning | `2` | numeric/time | s0 c0c929d0 seq 1 | 195 | — | — | 6732 |
| 13 | 06db6396 | knowledge-update | `5` | numeric/time | s0 6be54739_2 seq 9 | 114 | — | — | 9804 |
| 14 | 7e00a6cb | single-session-assistant | `International Budget Hostel` | prose-short | s37 answer_ultrachat_370515 seq 340 | 1 | — | — | 14994 |
| 15 | e3fc4d6e | single-session-assistant | `Dr. Arati Prabhakar` | prose-short | s32 answer_sharegpt_5m7gg5F_0 seq 322 | 2 | — | — | 11758 |

形态分布（按纯数字 / 长度 / 句数机械判定，判据写在 `bench/acon-loop.mjs` 的 `goldForm()`）：**numeric/time 7、prose-short 6、prose-long 2、identifier 0** —— 与主控给的表逐项一致。

### 1.1 已重压的 7 题的 checkpoint 实测（HEAD 指令）

| qid | ck 字符 | 锚点占比 | 叙述字符 | gold 在 ck | 答出 | 判分 |
|---|---|---|---|---|---|---|
| e47becba | 7247 | 85% | 1090 | NO | UNKNOWN | WRONG |
| 76d63226 | 4474 | 73% | 1216 | NO | UNKNOWN | WRONG |
| 505af2f5 | 20552 | 78% | 4464 | NO | UNKNOWN | WRONG |
| efc3f7c2 | 17515 | **100%** | **0** | NO | UNKNOWN | WRONG |
| 95bcc1c8 | 14446 | 66% | 4964 | YES | UNKNOWN | WRONG |
| 6456829e | 10816 | 84% | 1699 | YES | UNKNOWN | WRONG |
| 00ca467f | 9277 | 90% | 964 | YES | Two appointments. | **CORRECT** |

（7 题里 1 题答对；这 7 题的 gold 命中率 3/7。注意这一栏是 HEAD 指令，**不是**主控正在测的改动后文本，也不是 20261108 那次跑的旧文本——三者要分开看。）

### 1.2 表里没写、但很关键的三件事（全部来自已落盘文本，可直接核对）

**A. 叙述四节写的是「话题清单」，不是「事实」。** e47becba 的 `## 已完成` 是「解答了狐狸、鸡、谷物的经典逻辑谜题 / 提供了健身、瑜伽…建议 / 为流感疫苗预约提供了准备技巧」——用户说过「我拿的是 Business Administration 学位」这件事，一句都没有。四节在描述**这段历史里发生过哪些对话**，不是**用户说过哪些关于自己的事实**。

**B. 有一题把指令本身当成内容压缩了。** 00ca467f 的 `## 目标与约束` 开头是「用户要求对包含多个独立会话片段的长文本进行压缩（从 151708 个 token 压缩至约 16384 个 token，约 9.3:1）。压缩内容需严格包含五个特定章节…」——它在复述 instruction，把指令的约束当成会话的约束。这一节等于零信息。

**C.「值在、事实不在」可答性失败，比「值不在」更多。** 95bcc1c8 的 gold `10` 确实在锚点表里（`10` 一行），但锚点表是 550 个 session 的杂项清单，没有「说唱开放麦看了 10 个业余喜剧演员」这句；答 UNKNOWN。efc3f7c2 同理：`30` 与 `minutes` 都在锚点表里，但不成句，仍是 UNKNOWN。**这两题把「锚点定义太窄」和「缺装事实的小节」两个假设区分开了**：单纯把数字塞进锚点表**不足以**让它们可答。

**D. 三题的 gold 在 haystack 里逐字不存在**（505af2f5 偏好、gpt4_18c2b244 事件序、gpt4_98f46fc6 「谁先」）。它们的答案是**推断出来的**，任何「原样抄写」型指令都拿不到，必须由摘要里保留**可推断的原料**（偏好表述、两件事各自的日期、A 与 B 发生的先后）。这是第 2 步该问的第三个维度。

---

## 2. 第 2 步：提示词已就绪，未发

```bash
# 单个模型调用；模型 best（网关解析为 glm-5.3），max_tokens 16000，温度 0
cd /home/agent/workspaces/lcmx-study/dsh-lcm
node bench/acon-analyze.mjs --tag=before --input=acon-before-20261108.json.jsonl --augment=acon-step1-20261108.json
```

产出 `bench/results/acon-analysis-before-<date>.md`（模型回复原文，一字不改）+ `.json`（模型名、finish_reason、usage、输入快照）。

现在这份提示词里装的是：**完整指令原文**（`buildInstruction(16384,150000,0)` 展开后的 1314 字符）+ 主控给的 7/6/2/0 形态分布 + **7 组**配对的证据块（问题、gold、gold 在 haystack 的位置与原文句、分节字符、锚点前 12 行、叙述四节原文、给出的答案与判分）。它要求模型输出四节：`## 失败模式`（归并，不是每题一条）、`## 责任条款与改法`（引原句 → 给替换句）、`## 未决判断`（锚点太窄 / 缺小节 / 别的，并指出是表里哪条证据定的）、`## 可证伪条件`。

想凑满 15 组再发：把缺的 8 题补进同一个 journal 的路径下（`--concurrency=2`，别 3 以上），或用 `--input=<你的合并文件>`。

---

## 3. 三个脚本（留在仓库，未改 `src/`）

| 文件 | 作用 | 关键参数 |
|---|---|---|
| `bench/acon-loop.mjs` | 配对选择 → 重压 → 回答 → 判分 → 机械表；每题一行 journal，可断点续跑 | `--tag=before|after` `--instruction-module=<模块路径>`（把指令文本钉死，防并发编辑污染 A/B） `--no-model=1`（只做 gold 定位与形态，零模型调用） `--concurrency=2` `--pairs=id,id` |
| `bench/acon-analyze.mjs` | 第 2 步：拼证据 + 问模型 + **原文落盘** | `--model=best` `--max-tokens=16000` `--input=<json|jsonl>` `--augment=<step1.json>` `--dry-run=1`（只写提示词，不调用） |
| `bench/acon-table.mjs` | 把一次 run 的 JSON 渲染成 Markdown 表 | `node bench/acon-table.mjs bench/results/acon-before-20261108.json` |

设计上为这次事故准备的两处：`--instruction-module` 让 before/after 各自绑定一份不变的指令文本（`bench/snapshots/summarize-head.mjs` = HEAD 原文，可直接当 before）；每题 journal + 自动续跑，进程被杀只丢在飞的那几题。

**并发纪律**：这次 502 是两个进程同时打网关造成的。`--concurrency` 保持 2，且同一时刻只有一个 agent 在跑。

---

## 4. 合并时去重

已落盘、可被主控合并的原始数据：
- `bench/results/acon-before-20261108.json.jsonl` —— 7 行，键 `question_id`，指令 = HEAD 快照，模型 = agnes-3.0-flash（balanced-lite 的解析结果）。**与主控的改动后数据不是同一指令，不能混入同一列。**
- `bench/results/acon-step1-20261108.json` —— 15 行，纯机械（无模型），gold 定位/形态可无条件复用。
- `bench/results/acon-smoke-20261108.json` —— 1 行（e47becba），同 HEAD 指令，早于上面的 journal，可丢。

去重键：`(question_id, tag, instruction-module)`。
