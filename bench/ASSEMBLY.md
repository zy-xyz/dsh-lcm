# ASSEMBLY — lcm-x 第 5 步（Assemble）在 dsh 契约下能做到什么

结论先行，证据在后。

## 0. 裁决

1. **单条替换是硬约束，不是本插件的保守实现。** 契约层把一个 replace 事件的 surfaceOp 定义成**恰好三个自有序键** `{op, startSeq, endSeq}`，校验器用 `Object.keys(op).length === 3` 封闭它，fold 用 `splice(i, n, seq)` 把整段换成**一个** seq，投影层一条事件只产出一条 message。任何"一个事件带多条 message"的写法在 commit 时抛错，且抛在 `compaction/start` / `compaction/summary` 已经落盘之后。
2. **但这个约束不是第 5 步的瓶颈。** 实测（§3）：今天这条流水线在自动压力路径上**表面上永远只有 1 个 checkpoint**（40 轮 → 7 次压缩 → 表面 1 个 checkpoint，depth 7）。有 1 个节点时，"最高层优先、再低层、再新鲜尾"没有可排序的对象。
3. **真正的瓶颈是第 2 步的 breadth（叶不累积）**，而第 5 步的排序在 dsh 上是**免费的**：surface 位置就是模型看到的 message 顺序，只要表面真有 N 个 checkpoint，且新节点总是出现在被吸收区间的位置上（现在的合并规则保证了这一点，§5），位置序天然等于深度序。实测 breadth 修好后表面是 `[CP depth2, CP depth1, CP depth1, …raw…]`。

因此：**"把 entries 按 depth 排序"是可做但收益极小的杠杆（今天 entries 只有 1 条）；"留着多个 checkpoint 并断言表面真有 N 个"才是该做的那件事，而它的成本不在第 5 步，在选段（第 2/3 步）。**

---

## 1. 契约：一个事件 = 一个 surface 节点 = 一条 message

行号取自写作时的**工作树**（`src/config.js` 与 `src/index.js` 上有与本主题无关的未提交注释改动，行号会漂；契约引用的行号属于 npm 包，稳定）。

被测版本：`@deepseek-ai/dsh-compaction@0.2.2-rc.1`、`@deepseek-ai/dsh-session@0.2.2-rc.1`
（安装前缀 `…/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`，下文路径相对该前缀；`node_modules/@deepseek-ai/dsh-session` 是指向同一份代码的软链。）

### 1.1 SurfaceOp 只有两个形状

`dsh-session/lib/types/types.d.ts:453-470`：

```ts
 * - `{ op: 'replace', startSeq, endSeq }`: replaces surface nodes from `startSeq`
 *   (inclusive) through `endSeq` (inclusive) with this node. Both must exist as
 *   surface nodes in the current surface. `startSeq === endSeq` replaces a single
 *   node. The node's {@link SessionEvent.sourceEventSeqs} must include every
 *   shadowed surface node. Used by compaction; any surface-replacing producer
 *   may use it.
 */
export type SurfaceOp = 'append' | {
    op: 'replace';
    startSeq: SessionSeq;
    endSeq: SessionSeq;
};
```

"with **this node**"，单数。`append` 与 `replace` 是互斥的两个 union 分支（`dsh-session/lib/types/types.d.ts:466-470`），一条事件只能带其中一个，**不存在"append 同时 shadow 一段"的第三形状**。

### 1.2 校验器：这就是任务要找的 validator，它在运行期封闭了三个键

`dsh-session/lib/types/surface.js:189-199`：

```js
/** Whether a runtime value is the exact positional-replacement shape. */
function isReplaceOp(value) {
    const op = value;
    return Object.keys(op).length === 3
        && Object.hasOwn(op, 'op')
        && Object.hasOwn(op, 'startSeq')
        && Object.hasOwn(op, 'endSeq')
        && op['op'] === 'replace'
        && isEventSeq(op['startSeq'])
        && isEventSeq(op['endSeq']);
}
```

入口在 `surfaceOpOf`（`surface.js:200-228`），非 surface 事件带 surfaceOp 抛错、surface 事件缺 surfaceOp 抛错、形状不对抛 `carries an invalid replace surfaceOp`（`surface.js:224-226`）。对外导出的校验函数是 `validateSurfaceMetadata`（`surface.d.ts:133` 声明，`surface.js:299-308` 实现），它另外要求 `startSeq/endSeq < event.seq`。

**这一段就是"能不能一个事件换多条 message"的判据：不能。多一个键就非法，而"多条 message"必然要多带一个键或一个数组。**

### 1.3 fold：把一段换成"一个"节点

`dsh-session/lib/types/surface.js:435-439`：

```js
else if (plan?.kind === 'replace') {
    state.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq);
    state.replaceGeneration += 1;
    state.contentGeneration += 1;
}
```

`splice(start, deleteCount, item)` —— 插回的 item 是**单个** `plan.seq`。即使把 op 写成数组，这里也没有展开的位置。

### 1.4 一条事件只投影一条 message

`dsh-session/lib/types/surface.d.ts:76-88`："Project a single event into the LLM message it derives to, or **null** when it produces none"。签名 `deriveEventMessage(event, projectedMessages?): Message | null`。

所以"一条 replace 事件在表面上抵 N 条 message"要在两层同时成立才行：节点层（1.3 不允许）和 message 层（1.4 不允许）。

### 1.5 两条看起来像后门、实际不是的路

- **`append`**：只往尾部加一个节点，`sourceEventSeqs` 只是引用，不 shadow（`types.d.ts:471-483`）。想用 append 冒充替换，结果是旧节点仍然可见。
- **`SessionMessageProjection`**（`surface.d.ts:25-37`）：插件可以重写**已存在**节点的 message 内容，返回 `ReadonlyMap<SessionSeq, Message>` 以**原 seq 为键**。它不能新增节点、不能改变节点数量，只能改内容。想靠它把一条 checkpoint 展开成多条 message，键空间不允许。

### 1.6 实测（不是推断）

```js
// node /tmp/probe-fold.mjs，直接调用真实 foldSurface
foldSurface([sys, u(1),u(2),u(3), {replace 1..3}])   → nodes = [0,4]      // 3 个节点换 1 个
foldSurface([... , {op:'replace',startSeq:1,endSeq:3,nodes:[1,2,3]}])
  → THROW: session event "user/message" carries an invalid replace surfaceOp
```

---

## 2. 代码：一条 checkpoint **内部**能装什么

### 2.1 `entries` 是数组，架构上允许多条，但 `compile()` 只返回一条

`src/compiler.js:312-322` `joinCompiledEntries(entries)` 接受任意长度数组（字符串或 `{seq,text,kind}`），`src/compiler.js:333-344` `frameCheckpoint(entries, headerLine, introLine, footerLine)` 把它 `body.push(...entries)` 摊平。

而 `src/index.js:545-555` 是：

```js
const entries = [
  {
    seq: prepared.shadowedSeqs[0],
    text: `[lcm leaf summary…]\n${text}`,
    kind: "checkpoint"
  }
];
```

并且 `src/index.js:561` 自报 `entries: 1`。**所以"按 depth 排序 entries"今天没有对象可排**——一条 checkpoint 里只有一个 entry。

### 2.2 落盘顺序（任务描述里的顺序需要纠正）

`src/compiler.js:333-344`：

```js
const body = [RECALL_GUIDE];
if (introLine !== undefined) body.push(introLine);
if (headerLine !== undefined) body.push(headerLine);
body.push(...entries);
if (footerLine !== undefined) body.push(footerLine);
return [
  { type: "text", text: `${CHECKPOINT_PREAMBLE}\n\n${CHECKPOINT_OPEN_TAG}` },
  { type: "text", text: joinCompiledEntries(body) },
  { type: "text", text: CHECKPOINT_CLOSE_TAG }
];
```

真实顺序是 **三个 content block**：① `CHECKPOINT_PREAMBLE`（`compiler.js:280-281`）+ `<compacted-checkpoint>`（`compiler.js:284`）；② 一个 block 里依次 `RECALL_GUIDE`（`compiler.js:293-301`）→ intro → header → entries → footer；③ 闭合标签（`compiler.js:287`）。**不是 header 在 RECALL_GUIDE 之前**，也不是每条 entry 一个 block。

这三个 block 是**一条 user message 的 content**（`src/region.js:409-412` `createUserMessage({ content: frameCheckpoint(...) })`），模型看到的是 1 条 message / 3 个 block。

### 2.3 `deriveDag` 算 depth，但表面不用它排序

`src/summarize.js:620-664`：checkpoint 节点 = 紧随 `compaction/summary` 的、`source.kind === "compact-checkpoint"` 的 `user/message`；`children` 取该 summary 的 `shadowedSeqs`；depth = 1 + max(children depth)。纯推导、无侧存。

它有两个消费者：`maxAbsorbedDepth`（`summarize.js:595-603`，只用来给摘要指令加一句 "This span already absorbed a depth-N checkpoint…"，`summarize.js:155-157`）和 `selectCompactableRange` 的 fanin 分支（`src/region.js:116-128`）。**没有任何一处用它给表面排序。**

---

## 3. 实测：今天表面上到底有几个 checkpoint

这是本节最该被记住的数字。用真实 `selectCompactableRange` + 真实 `deriveDag` 跑离线模拟（无模型调用，`node` 秒级，脚本见 §6），配置取默认值（`leafSpanTokens = 24000`、`condensationFanin = 4`、retain 16000、floor 512；`src/config.js:63,72,52`）。

| | 压缩次数 | 表面节点 | 表面 tokens | 日志里的 checkpoint | **表面上的 checkpoint** | 表面上的 depth |
|---|---|---|---|---|---|---|
| 今天的选段 | 7 | 71 | 65 156 | 7 | **1** | `[7]` |

每一次压缩的跨度构成：

```
round=14 span=24300 nodes=27 absorbedCheckpoints=0 theirDepths=[]      -> newDepth=1
round=18 span=24596 nodes=25 absorbedCheckpoints=1 theirDepths=[1]     -> newDepth=2
round=22 span=24632 nodes=25 absorbedCheckpoints=1 theirDepths=[2]     -> newDepth=3
round=26 span=24636 nodes=25 absorbedCheckpoints=1 theirDepths=[3]     -> newDepth=4
round=30 span=24636 nodes=25 absorbedCheckpoints=1 theirDepths=[4]     -> newDepth=5
round=34 span=24636 nodes=25 absorbedCheckpoints=1 theirDepths=[5]     -> newDepth=6
round=38 span=24636 nodes=25 absorbedCheckpoints=1 theirDepths=[6]     -> newDepth=7
```

原因在选段规则本身：叶从**最老的表面节点**开始切（`src/region.js:141-147`，并被 `test/leaf-span.test.js:65` 显式钉住 "the leaf starts at the OLDEST node"），而最老的节点就是上一个 checkpoint。于是每个新叶都把上一个 checkpoint 再吸收一次：**depth 涨、breadth 恒为 1**。

连带后果：fanin 分支（`region.js:105-129`）要求"开头有一段**同深度**连续 checkpoint 且长度 ≥ fanin"，表面只有 1 个 checkpoint 时这个条件**永远不成立**——它目前只被 `test/fanin.test.js` 的合成会话覆盖，自动路径上不可达。

`src/config.js:53-62` 的注释其实已经写对了这件事（"the surface never holds more than one"），但下一句 "lcm-x … keeps every leaf" 与本仓库的实际选段规则矛盾：叶块**没有**被保留，它被下一个叶吸收了。

---

## 4. 三个候选逐条判定

| 候选 | 契约允许? | 代码今天做什么 | 可观察差异 | 成本 |
|---|---|---|---|---|
| A. 一条 checkpoint 内 entries 按 depth 排（深→浅→新叶） | ✅ 允许。content 是自由文本 block，`SurfaceOp` 管的是**节点位置**不是 block 顺序 | `compile()` 只产 1 条 entry（`index.js:545-555`）；被吸收的 checkpoint 内容由摘要模型重写进各节，不保留原文（`summarize.js:155-157`） | **0**（一条 entry 无可排序）；只有让 `compile()` 吐出子摘要原文时才非零 | 让子摘要逐字重发：depth-k 节点从"rollup ≈ 跨度的 12%"变成"≈ 子节点之和"。实测子节点 3 036 tokens、4 个就是 ~12k，同一位置原本只需 3k → 表面增长快约 4×，抵掉压缩收益 |
| B. 表面留多个 checkpoint / 断言真有 N 个 | ✅ 允许。每个 checkpoint 是独立 append-origin/replace 节点，实测 `nodes = [0,6,3,4,7]` 两个 checkpoint 并存 | **表面只有 1 个**（§3 实测）。没有任何测试断言自动路径上表面 ≥2 个 checkpoint（`test/real-session-shape.test.js:212` 断言的正是 `1`） | 巨大：N>1 时位置序天然就是 lcm-x 的组装序（见 §5 实测） | **不在第 5 步**。要改第 2/3 步的选段：新叶不能从"最老节点"起，必须从"最后一个非合并 checkpoint 之后"起 |
| C. append 事件带多条 message | ❌ 契约禁止。三键封闭（`surface.js:190-199`）+ 一个 splice item（`surface.js:436`）+ 单 message 投影（`surface.d.ts:88`） | 不存在这条路 | 无（不可实现） | — |

一个容易被误判的点：**契约只约束"一个事件 = 一个节点"，不约束"一条 checkpoint 里有多少文字"**。所以 A 在契约上完全合法 —— 它不受限的地方恰恰不是限制所在。

---

## 5. 推荐

### 推荐做法：不碰第 5 步，改第 2 步的叶起点，让位置序承担组装序

理由由三段实测拼成：

1. 深度序 ≠ 位置序的情形，只在"新压出的节点落在比它浅的节点之后"时出现。
2. 本仓库的合并规则**只合并开头那一段**（`src/region.js:116-128`，注释写明 "Only a LEADING run at one depth qualifies"），所以任何更深的新节点**总是**出现在最早的位置。
3. 于是 N>1 时位置序自动等于"深→浅→尾部"。实测（把叶起点改到"最后一个 checkpoint 之后"，其余全不变，同样 40 轮）：

| | 压缩次数 | 表面节点 | 表面 tokens | 表面上的 checkpoint | **位置序 depth** |
|---|---|---|---|---|---|
| 今天 | 7 | 71 | 65 156 | 1 | `[7]` |
| 叶起点后移 | 7 | 82 | 77 730 | **3** | `[2,1,1]` |

叶起点后移后的表面（位置序，前 6 个节点）：

```
pos=0 system                          tokens=20
pos=1 CP depth=2                     tokens=1518
pos=2 CP depth=1                     tokens=2996
pos=3 CP depth=1                     tokens=2996
pos=4.. raw 尾                        tokens=900 each  (76 个)
```

**这就是 lcm-x 的 `[highest-depth first, then lower]` + `[fresh tail]`，一行排序代码都不需要写。** 契约把"顺序"这件事交给了 surface 位置，而位置是 replace 的目标区间决定的——合并只在开头发生，深度自然单调递减。

### "最好的近似"排序（按性价比）

1. **（真正的下一步）让表面真的有 N 个 checkpoint。** 改 `selectCompactableRange` 的叶起点：开头是 checkpoint 且其同深度 run < fanin 时，叶从它**之后**起切；同深度 run ≥ fanin 时仍走合并分支。这是第 2/3 步的改动，但它同时解锁第 5 步**和** fanin（fanin 今天在自动路径上不可达，见 §3）。
2. **（可选，第 5 步内唯一合法的排序杠杆）** 合并落地时，让被合并的子摘要**以独立 entry 逐字保留、按 depth 降序排在前**，新写的 rollup 放最后。契约允许（entries 是数组，`compiler.js:312-344`），代价见 §4 表 A：depth-k 节点从"≈ 跨度的 12%"涨到"≈ 子节点之和"，实测子节点 3k → 4 个约 12k，同一位置原本只需 3k，表面增长快约 4×。**只有在第 1 条做完、且实测"rollup 真丢了子摘要里的事实"之后才值得付。**
3. **（不做）** 让一个事件携带多条 message。契约不允许，收益为 0。

---

## 6. 最便宜的确证实验

**离线回放，零模型调用，约 1 秒**。它一次回答三个问题：表面到底有几个 checkpoint、depth 分布、以及"排序"是否有对象。

存成任意路径的 `.mjs`（**不要放进仓库**），在仓库根执行：

```js
import { pathToFileURL } from "node:url";
const root = process.env.LCM_ROOT ?? process.cwd();   // 在仓库根运行
const { selectCompactableRange } = await import(pathToFileURL(root + "/src/region.js").href);
const { deriveDag } = await import(pathToFileURL(root + "/src/summarize.js").href);
const LEAF=24000,FANIN=4,RETAIN=16000,FLOOR=512,THRESHOLD=80000,OVH=80;
const breadthFix = process.argv[2] === "fix";
const events=[];let seq=0;const prices=new Map();
const push=(t,d)=>{const e={seq:seq++,type:t,data:d};events.push(e);return e;};
const view={nodes:[],replaceGeneration:0};
const session={events,get surface(){return view;},eventAt:(s)=>events.find(e=>e.seq===s)};
push("system/message",{message:{role:"system",content:[{type:"text",text:"sys"}]}});
view.nodes.push(0);prices.set(0,20);
const measure=(ns)=>{const n=ns.map(s=>({seq:s,tokens:prices.get(s)??100,heuristicTokens:prices.get(s)??100}));
  return{nodes:n,totalTokens:n.reduce((t,x)=>t+x.tokens,0)};};
let cid=1, commits=0;
for(let r=0;r<40;r+=1){
  for(let k=0;k<6;k+=1){const e=push("user/message",{content:[{type:"text",text:"raw"}]});
    view.nodes.push(e.seq);prices.set(e.seq,900);}
  let g=0;
  for(;;){ if(g++>20)break;
    if(measure(view.nodes).totalTokens<=THRESHOLD)break;
    const dag=deriveDag(session);
    let ns=view.nodes;
    if(breadthFix){                        // 提案：叶不从最老的 checkpoint 起切
      let i=1,run=0;
      while(i<view.nodes.length&&dag.nodeBySeq.has(view.nodes[i])){run+=1;i+=1;}
      if(run>0&&run<FANIN) ns=view.nodes.slice(i);
    }
    if(ns.length===0)break;
    const sub={events,surface:{nodes:ns,replaceGeneration:view.replaceGeneration},eventAt:session.eventAt};
    const range=selectCompactableRange(sub,measure(ns),RETAIN,FLOOR,LEAF,FANIN);
    if(range===null)break;
    const nodes=view.nodes;const i0=nodes.indexOf(range.start),i1=nodes.indexOf(range.end);
    const shadowed=nodes.slice(i0,i1+1);
    const span=shadowed.reduce((t,s)=>t+(prices.get(s)??100),0);
    const body=Math.min(16384,Math.max(FLOOR,Math.round(span*0.12)))+OVH;   // 模拟 commit 的摘要体量
    push("compaction/summary",{compactionId:"c"+cid,shadowedSeqs:shadowed,shadowedTokenCount:span});
    const msg=push("user/message",{content:[{type:"text",text:"cp"}],
      source:{kind:"compact-checkpoint",compactionId:"c"+cid}});
    cid+=1;nodes.splice(i0,i1-i0+1,msg.seq);view.replaceGeneration+=1;prices.set(msg.seq,body);commits+=1;
  }
}
const dag=deriveDag(session);
const onSurface=view.nodes.filter(s=>dag.nodeBySeq.has(s));
console.log(JSON.stringify({mode:breadthFix?"fix":"today",commits,
  surfaceNodes:view.nodes.length,
  checkpointsOnSurface:onSurface.length,
  positionalDepths:view.nodes.map(s=>dag.nodeBySeq.get(s)?.depth??null).filter(d=>d!==null)}));
```

实际输出（本机 Node 24）：

```
$ node /tmp/sim-assembly.mjs
{"mode":"today","commits":7,"surfaceNodes":71,"checkpointsOnSurface":1,"positionalDepths":[7]}
$ node /tmp/sim-assembly.mjs fix
{"mode":"fix","commits":7,"surfaceNodes":82,"checkpointsOnSurface":3,"positionalDepths":[2,1,1]}
```

注：脚本里的提案用**最简形式**（开头连续 checkpoint 个数 < fanin 就整段跳过，不比较深度），所以得到 3 个 checkpoint / `[2,1,1]`。§5 第 1 条推荐的是**带深度判断**的版本（只有"同深度 run < fanin"才跳过），同一条轨迹上它给 `checkpointsOnSurface=2, positionalDepths=[2,2]`。两种形式都证明 breadth > 1，且都满足"位置序 depth 非递增"；选哪一种取决于是否要保留"混合深度前缀也能合并"的空间。

判定规则：

- `checkpointsOnSurface === 1` → 第 5 步没有排序对象，任何"按 depth 排序 entries"的改动**不可观测**。这是今天的现状；这一条跑一遍就够，不必再花模型调用。
- `checkpointsOnSurface > 1` 且 `positionalDepths` **非递增** → 位置序已等于组装序，第 5 步无需改动，只需在真实会话里把这一点断言下来（今天没有任何测试断言自动路径上表面 ≥2 个 checkpoint：`test/real-session-shape.test.js:212` 断言的正是 `1`）。
- `positionalDepths` **出现递增**（浅节点排在深节点之前）→ 才需要讨论 §4 的 A 方案。

为什么这是最便宜的：零模型调用、零仓库内新增文件、约 1 秒可复现；任何 A/B 质量对比（`bench/layer2-qa.mjs`）是每题一次摘要 + 一次判分，按 `bench/REPORT.md` §21 的口径是分钟到小时级，且 n<20 不足以排序方案。

---

## 7. 顺带该修正的两处文档陈述

1. `bench/REPORT.md:1076` 与 `SESSION-STATE.md:26` 都把"单条替换约束"指向 **§21**，但 `bench/REPORT.md:432` 的 §21 是向量臂。这条约束在仓库里**没有任何契约引用**——本文 §1 是它的第一份出处。
2. `src/config.js:56-62` 说 lcm-x "keeps every leaf"，而本仓库的叶块从最老节点起切，叶**不被保留**（§3 实测：表面恒为 1 个 checkpoint，depth 线性增长）。这句话描述的是目标而非现状。

---
*仅新建本文件；未修改源码、测试或其它文件。*