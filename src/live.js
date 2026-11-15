/**
 * Live (restart-free) tuning for the two config surfaces this plugin has.
 *
 * The engine row and the tool/command rows are separate Cordis rows with separate
 * configs, and both resolve their config ONCE at load. Resolved configs are read
 * as `cfg.key` at decision time everywhere, never destructured at construction —
 * which is what makes a swap-in-place sufficient: assign the new resolved object
 * onto the row's field (engine) or Object.assign it onto the row's live resolved
 * record (tool/command) and the next decision sees it.
 *
 * The overlay file is what makes it survive a restart: every row merges its
 * surface's slice in before resolving, so a value set from the panel is also the
 * value a freshly booted process starts with.
 *
 * The key list is a WHITELIST on purpose. `modelPolicies` and
 * `summarizationProvider/Model` change which route a pending request would use,
 * and a config edit mid-turn would silently re-target a request already priced
 * against the old route.
 *
 * @module dsh-lcm/live
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where the panel's edits are persisted. */
function overlayPath() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
  return path.join(home, "lcm-live.json");
}

/**
 * 面板可以修改的每一项配置。
 *
 * `surface` 说明这一项归哪一行所有：引擎行读 `compaction`，工具行与命令行读
 * `vector`。`label` 是中文名，`desc` 是这一项到底做什么（面板上直接显示），
 * `risk` 只在"运行时改它会有副作用"时出现——它不阻止修改，只是把后果写在
 * 字段旁边，让人在点之前就知道。
 *
 * 没有 `risk` 的是纯决策型参数：阈值、token 预算、并发度这类值在每次使用时
 * 重新读取，改完下一次决策就生效，没有留下半套状态。带 `risk` 的也照样可改，
 * 因为这一栏存在的意义就是把整张配置表摊开。
 */
export const HOT_KEYS = Object.freeze([
  // ── 压缩：纯决策，改完即生效 ────────────────────────────────────────
  {
    key: "thresholdRatio",
    surface: "compaction",
    type: "number",
    min: 0,
    exclusiveMax: 1,
    label: "压缩触发比例",
    desc: "上下文用到窗口的多少比例时开始压缩。默认 0.75，也就是 100 万窗口在 75 万 token 时触发。调低会压缩得更早、更频繁，但留出更多请求余量；调高会用到更满，压缩次数更少。"
  },
  {
    key: "retainRatio",
    surface: "compaction",
    type: "number",
    min: 0,
    exclusiveMax: 1,
    label: "保留原文比例",
    desc: "压缩后保留多少比例的最新原文不动。默认 0.05，100 万窗口约保留 5 万 token。这部分是最新的对话，保持原样以保证连续性；调大更连贯但每次压缩能腾出的空间更少。"
  },
  {
    key: "summaryRatio",
    surface: "compaction",
    type: "number",
    min: 0,
    exclusiveMax: 1,
    label: "摘要目标比例",
    desc: "一条 checkpoint 的摘要目标大小，按被压缩区间的比例算，再被下面的下限和上限夹住。默认 0.2，但与下限、上限同为 2000 时比例实际不起作用，每条摘要固定 2000 token。"
  },
  {
    key: "summaryFloorTokens",
    surface: "compaction",
    type: "integer",
    min: 1,
    label: "摘要下限（token）",
    desc: "摘要大小不得低于这个值。默认 2000，与上限相等，所以每条摘要就是 2000 token，不随源区间变化。想按比例缩放就把这个值调小、让比例说话。"
  },
  {
    key: "checkpointCap",
    surface: "compaction",
    type: "integer",
    min: 1,
    label: "摘要上限（token）",
    desc: "摘要大小不得高于这个值。默认 2000。调大会让每条 checkpoint 保留更多细节、压缩比降低，后续每一步的提示词也更大。"
  },
  {
    key: "leafSpanTokens",
    surface: "compaction",
    type: "integer",
    min: 1,
    label: "单叶跨度（token）",
    desc: "一次压缩最少吞掉多少 token 的原文。默认 24000。调小压缩更细、次数更多；调大一次处理更多，但单次摘要会丢掉更多细节。"
  },
  {
    key: "condensationFanin",
    surface: "compaction",
    type: "integer",
    min: 2,
    label: "凝聚扇入",
    desc: "多少个同级 checkpoint 合并成一个上层节点。默认 4，也就是四层结构每层收窄四倍。这是多层压缩的开关，最小为 2。"
  },
  {
    key: "thresholdFullSweep",
    surface: "compaction",
    type: "boolean",
    label: "越阈值时连续扫多个叶",
    desc: "打开后，一次越过阈值会连续压缩多个叶，直到回到阈值以下；关闭则每次只压一个叶，恢复得更慢但每一步更轻。默认打开。"
  },
  {
    key: "fullSweepMaxPasses",
    surface: "compaction",
    type: "integer",
    min: 1,
    label: "单次扫描最多几个叶",
    desc: "一次 sweep 最多释放多少个叶。默认 12，按每叶 24000 token 算是 28.8 万 token，足够把一次越界拉回阈值内。这是花费上限，不是必须用完的额度。"
  },
  {
    key: "fullSweepMaxSeconds",
    surface: "compaction",
    type: "integer",
    min: 1,
    label: "单次扫描硬上限（秒）",
    desc: "一次 sweep 的墙钟硬上限。默认 120 秒。到点就停，剩下的欠账由下一次越阈值或空闲续跑接手。"
  },
  {
    key: "fullSweepSoftSeconds",
    surface: "compaction",
    type: "integer",
    min: 1,
    label: "单次扫描软上限（秒）",
    desc: "更早结束 sweep 的软时钟。默认 0 表示不启用。设成比目标所需时间还短会变成真正的约束，让 sweep 每次都半途而废，所以只在想主动收紧时才填。"
  },
  {
    key: "fullSweepTargetShare",
    surface: "compaction",
    type: "number",
    min: 0,
    exclusiveMax: 1,
    label: "单次扫描目标份额",
    desc: "一次 sweep 想回收多少比例的阈值。默认 0.08，配合 120 秒硬时钟，让目标能在一次越界内达成——这样 sweep 是因为做完了才停，而不是被时钟截断。"
  },
  {
    key: "fullSweepReserveSeconds",
    surface: "compaction",
    type: "number",
    min: 0,
    label: "扫描预留时间（秒）",
    desc: "从硬上限里预留出来的余量，避免最后一个叶刚好卡在时钟边界上。默认 10 秒。"
  },
  {
    key: "leafEstimateFloorSeconds",
    surface: "compaction",
    type: "number",
    min: 0,
    label: "单叶耗时估算下限（秒）",
    desc: "估算下一个叶要多久时用的地板值。默认 15 秒。地板的作用是防止一次很快的压缩让系统误判后续也快，从而放进过多的叶。"
  },
  {
    key: "stallCooldownMs",
    surface: "compaction",
    type: "integer",
    min: 0,
    label: "无进展冷却（毫秒）",
    desc: "一次压缩没取得进展后，等多久再试。默认 60000，也就是一分钟。避免每一步都重新判断同一个无法压缩的区间，同时又能自己恢复。"
  },
  {
    key: "anchorPointers",
    surface: "compaction",
    type: "boolean",
    label: "摘要里保留 seq 锚点",
    desc: "打开后每条摘要都带 (seq N) 指针，指向被折叠的原始事件，lcm_expand 靠它精确恢复。默认打开。关掉会失去按 seq 恢复的能力，不建议。"
  },
  {
    key: "emptySummaryRetries",
    surface: "compaction",
    type: "integer",
    min: 0,
    label: "空摘要重试次数",
    desc: "模型返回零文本时的额外重试次数。默认 2，也就是同一提示词最多试三次。这是采样偶发问题，重试通常就出文本了；换路由不试，因为那样失败就不可复现。"
  },
  {
    key: "backgroundLeafPrep",
    surface: "compaction",
    type: "boolean",
    label: "后台预生成摘要",
    desc: "打开后在空闲时提前为下一个叶写好摘要，真正压缩时直接用。默认关闭。打开能缩短压缩停顿，代价是空闲时也在花模型调用。"
  },
  {
    key: "auto",
    surface: "compaction",
    type: "boolean",
    label: "自动压缩",
    desc: "总开关。关闭后只有手动 /compact 才会压缩，上下文会一直涨到上游拒绝为止。默认关闭，打开后按上面的阈值自动触发。"
  },
  {
    key: "maxTokens",
    surface: "compaction",
    type: "integer",
    min: 1,
    label: "上下文上限（token）",
    desc: "这个引擎认定的上下文上限。默认 65536，但更常见的是按实际模型窗口走 modelPolicies。这个值直接决定阈值算出来是多少。"
  },
  {
    key: "headroomTokens",
    surface: "compaction",
    type: "integer",
    min: 1,
    label: "预留余量（token）",
    desc: "从上限里预先扣掉、不参与压缩计算的空间。默认 65536。留出来给回复和工具结果，防止刚压完就又被撑满。"
  },
  {
    key: "compactionRetries",
    surface: "compaction",
    type: "integer",
    min: 0,
    label: "压缩失败重试次数",
    desc: "一次压缩事务失败后的重试次数。默认 1。压缩失败通常是路由或校验问题，重试能救活偶发的传输失败。"
  },
  {
    key: "maxOverflowRetries",
    surface: "compaction",
    type: "integer",
    min: 0,
    label: "溢出重试次数",
    desc: "上游报上下文溢出后，再压缩一轮并重发请求的次数。默认 1。调大会在真的超窗时多试几次，但每次都要重新压缩。"
  },
  // ── 压缩：会改变进行中决策的输入 ──────────────────────────────────
  {
    key: "retainTokens",
    surface: "compaction",
    type: "integer",
    min: 1,
    label: "保留原文 token 数",
    desc: "用绝对 token 数代替上面的保留比例。两者互斥：填这个就会自动丢掉 retainRatio，反之亦然。默认不填，走比例。适合想固定一个「最近多少 token 原文绝不动」的场景，比如 24000 对应 lcm-x 的 fresh_tail_max_tokens。",
    risk: "与「保留原文比例」互斥。改这一项会清掉那一项；已经按比例定价过的压缩会沿用旧边界。"
  },
  {
    key: "summarizationProvider",
    surface: "compaction",
    type: "string",
    label: "摘要模型提供商",
    desc: "写摘要用的提供商，与下面一项成对出现。留空表示跟会话本身走。填了之后摘要不再消耗主模型的额度。",
    risk: "会改变摘要路由。下一个叶用新路由；已经在流式返回的请求仍在旧路由上跑完。必须与摘要模型一起设。"
  },
  {
    key: "summarizationModel",
    surface: "compaction",
    type: "string",
    label: "摘要模型",
    desc: "写摘要用的模型名，例如 mistral-proxy/codestral-embed 或某个便宜的小模型。必须与上面的提供商成对填写，只填一个不生效；留空则摘要跟会话本身用同一个模型。",
    risk: "同上：要么两个都填，要么都不填。"
  },
  {
    key: "temporalRollups",
    surface: "compaction",
    type: "boolean",
    label: "按天时间线",
    desc: "空闲时把每天发生的事汇总成一条时间线，让「11 号做了什么」这类问题不用扫全量日志。默认打开，因为成本被下面的预算和条数双重限制。",
    risk: "关掉不会删除已经生成的时间线，只是不再生成新的。"
  },
  {
    key: "rollupBuildsPerPass",
    surface: "compaction",
    type: "integer",
    min: 1,
    label: "每次生成几条时间线",
    desc: "一次空闲维护最多生成几条日时间线。默认 2。调大能在一次空闲里补完更多天，代价是这一趟占用的模型调用更多；时间线只在打开「按天时间线」时才会生成。"
  },
  {
    key: "rollupMaintenanceBudgetMs",
    surface: "compaction",
    type: "integer",
    min: 1,
    label: "时间线维护预算（毫秒）",
    desc: "一次空闲维护最多占用多少毫秒。默认 5000。调大能在一趟里做完更多时间线，但空闲槽位被占用的时间也更长。"
  },
  {
    key: "rollupDailyTargetTokens",
    surface: "compaction",
    type: "integer",
    min: 1,
    label: "日时间线目标长度（token）",
    desc: "要求模型把一天的汇总写到多大。默认 5000 token。这是给模型的长度指令，不是硬限制；真正封顶的是下面的上限。"
  },
  {
    key: "rollupDailyMaxTokens",
    surface: "compaction",
    type: "integer",
    min: 1,
    label: "日时间线上限（token）",
    desc: "一天的汇总不得超过这个值。默认 15000。设得比目标还小会让目标永远达不成。"
  },
  {
    key: "assertionExtraction",
    surface: "compaction",
    type: "boolean",
    label: "断言抽取",
    desc: "一天的汇总不得超过这个值。默认 15000。设得比上面的目标还小会让目标永远达不成，那样模型会一直被要求写更长却写不出来。",
    risk: "关掉不会删除已抽取的断言，只是不再新增。"
  },
  {
    key: "assertionMaxSourcesPerPass",
    surface: "compaction",
    type: "integer",
    min: 1,
    label: "每次抽取几条来源",
    desc: "一次抽取最多读几条 checkpoint。默认 4，这个数字同时也是这一趟的花费。"
  },
  {
    key: "assertionTimeoutSeconds",
    surface: "compaction",
    type: "integer",
    min: 1,
    label: "抽取超时（秒）",
    desc: "一趟抽取的时限。默认 30 秒。模型慢的时候要给得更大，否则这一趟直接跳过。"
  },
  {
    key: "rollupDir",
    surface: "compaction",
    type: "string",
    label: "时间线目录",
    desc: "时间线文件放在哪。默认 .lcm-rollups，相对进程工作目录。",
    risk: "改这一项会让已有时间线全部看起来不存在，文件仍在原处，不会迁移。"
  },
  {
    key: "assertionDir",
    surface: "compaction",
    type: "string",
    label: "断言目录",
    desc: "断言文件放在哪。默认 .lcm-assertions，相对进程工作目录。断言是 checkpoint 里的事实三元组，按天分文件。",
    risk: "同时间线目录：改了旧文件就看不见了。"
  },
  {
    key: "debug",
    surface: "compaction",
    type: "boolean",
    label: "诊断日志",
    desc: "打开后每次决策都往下面的路径追加一行。默认关闭。排查压缩为什么不触发时先开这个。",
    risk: "打开会持续写文件，长期开着要注意磁盘占用。"
  },
  {
    key: "debugLogPath",
    surface: "compaction",
    type: "string",
    label: "诊断日志路径",
    desc: "诊断日志写到哪个文件。默认 /tmp/dsh-compaction-debug.log。只在诊断日志打开时被读取。"
  },
  {
    key: "modelPolicies",
    surface: "compaction",
    type: "json",
    label: "按模型覆盖参数",
    desc: "为指定 provider/model 单独设一套阈值与预算，填一个 JSON 数组，每项是 {provider, model, ...}，其余字段与上面同名。默认空数组，表示所有模型共用一套参数。",
    risk: "写错格式会被直接拒绝。provider 与 model 都必填；同名模型重复出现也会被拒绝。填了但匹配不到任何路由的条目不会生效。"
  },
  // ── 向量：工具行与命令行 ───────────────────────────────────────────
  {
    key: "vectorEnabled",
    surface: "vector",
    type: "boolean",
    label: "语义召回",
    desc: "打开后 lcm_search 增加一条按向量相似度排序的通道，能命中字面不匹配但语义相近的原文。默认关闭。关着时搜索完全走词法匹配。"
  },
  {
    key: "vectorConcurrency",
    surface: "vector",
    type: "integer",
    min: 1,
    label: "嵌入并发数",
    desc: "回填时同时发出几个请求。默认 19，等于凭据池的账号数——网关一个账号服务一个请求，19 是不排队的前提下能拿到的最大吞吐。超时是上游模型自身延迟，每个并发度都会发生，所以调低并不减少超时，只是变慢。"
  },
  {
    key: "vectorTimeoutMs",
    surface: "vector",
    type: "integer",
    min: 1,
    label: "单请求超时（毫秒）",
    desc: "一次嵌入请求的墙钟上限。默认 20000。批越大越容易超，回填行用的是 240000。超时会重试，但重试救不活已经挂掉的端点。"
  },
  {
    key: "vectorTopK",
    surface: "vector",
    type: "integer",
    min: 1,
    label: "向量召回条数",
    desc: "向量通道取回多少条候选交给排序。默认 8。调大召回更全，但每条候选都要算一次相似度。"
  },
  {
    key: "vectorCandidateTokens",
    surface: "vector",
    type: "integer",
    min: 1,
    label: "候选窗口（token）",
    desc: "参与向量排序的最近原文窗口有多大。默认 100000 token。窗口越大越可能命中旧内容，嵌入成本也越高。"
  },
  {
    key: "vectorCandidateLimit",
    surface: "vector",
    type: "integer",
    min: 1,
    label: "候选条数上限",
    desc: "候选窗口里最多取多少条事件。默认 500。与上面的 token 窗口共同决定候选集合。"
  },
  {
    key: "embedMaintenanceLimit",
    surface: "vector",
    type: "integer",
    min: 1,
    label: "空闲预嵌入条数",
    desc: "每次空闲维护最多补多少条嵌入。默认 64，大约一到两个批次，不是把整个语料一次灌完。"
  },
  {
    key: "rank",
    surface: "vector",
    type: "string",
    label: "排序方式",
    desc: "每次空闲维护最多补多少条嵌入。默认 64，大约一到两个批次，不是把整个语料一次灌完——这样空闲时不会把网关占满，回填仍然交给 /lcm-embed backfill。",
    risk: "只影响 lcm_search 这个工具。斜杠命令 /lcm-search 刻意保持纯词法，不接受向量排序——它是人的 grep，要求即时回答。"
  },
  {
    key: "maxRecallTokens",
    surface: "vector",
    type: "integer",
    min: 1,
    label: "恢复输出上限（token）",
    desc: "lcm_expand 一次最多返回多少 token。默认按内置上限。调小可以避免一次恢复就把上下文撑爆。"
  },
  {
    key: "maxSearchHits",
    surface: "vector",
    type: "integer",
    min: 1,
    label: "搜索命中上限",
    desc: "lcm_search 一次最多返回多少条命中。默认按内置上限。超出部分会被标记为省略并给出总数。"
  },
  {
    key: "legacyNames",
    surface: "vector",
    type: "boolean",
    label: "保留旧工具名",
    desc: "是否额外注册 recall 和 search 这两个旧名字，让为旧名字写好的提示词继续可用。默认打开。关掉只保留 lcm_expand / lcm_search / lcm_timeline 这三个新名字，工具列表更短。",
    risk: "这一项在工具注册时就定了，改完要重启 dsh 才生效——这是全表唯一需要重启的参数。"
  },
  {
    key: "allowLanAccess",
    surface: "vector",
    type: "boolean",
    label: "允许非本机访问面板",
    desc: "默认关闭，只服务本机。打开后面板的接口能被局域网访问，而它读的是会话历史与文件路径，也会写入这份配置。",
    risk: "打开等于把会话内容和配置写入能力暴露到局域网。默认关闭是有原因的。"
  },
  {
    key: "vectorBaseUrl",
    surface: "vector",
    type: "string",
    label: "嵌入端点地址",
    desc: "任意 OpenAI 兼容的 /v1 地址。默认指向本机网关。",
    risk: "换端点后，已缓存的向量是旧端点产的、按模型名分目录存的；模型名相同而端点不同会把两个向量空间混在一起。"
  },
  {
    key: "vectorModel",
    surface: "vector",
    type: "string",
    label: "嵌入模型",
    desc: "用来算向量的模型名。默认 mistral-proxy/codestral-embed。",
    risk: "缓存按模型名分目录，换模型等于已有向量全部作废，需要重新回填。"
  },
  {
    key: "vectorDim",
    surface: "vector",
    type: "integer",
    min: 1,
    label: "向量维度",
    desc: "模型输出的向量长度，必须与模型真实维度一致。默认 1536。",
    risk: "填错会让已存的每个向量都不可用，而且不会报错——只是相似度全是噪声。"
  },
  {
    key: "vectorCacheDir",
    surface: "vector",
    type: "string",
    label: "向量缓存目录",
    desc: "向量缓存放在哪。默认 .lcm-vectors，按模型名再分一层子目录。",
    risk: "换目录等于现有缓存全部看不见，需要重新回填。"
  },
  {
    key: "vectorApiKeyEnv",
    surface: "vector",
    type: "string",
    label: "密钥环境变量名",
    desc: "填的是环境变量名，不是密钥本身。默认空，表示不发 Authorization 头（无鉴权端点）。",
    risk: "填了一个进程里没有导出的变量名，请求就不带鉴权头，端点会直接拒绝。"
  }
]);

const BY_KEY = new Map(HOT_KEYS.map((entry) => [entry.key, entry]));

/**
 * Resolved field names for the vector keys.
 *
 * `resolveVectorConfig` RENAMES them when it freezes the record — the raw key is
 * `vectorEnabled`, the resolved field is `enabled`. A row reporting its live values
 * hands back the RESOLVED object, so without this table the form showed every
 * `vector*` field as unset while the layer was running. Same trap the panel's
 * vector-detection test pins for `enabled`.
 */
const RESOLVED_NAMES = Object.freeze({
  vectorEnabled: "enabled",
  vectorBaseUrl: "baseUrl",
  vectorModel: "model",
  vectorDim: "dim",
  vectorTopK: "topK",
  vectorCandidateLimit: "candidateLimit",
  vectorCandidateTokens: "candidateTokens",
  vectorTimeoutMs: "timeoutMs",
  vectorConcurrency: "concurrency",
  vectorCacheDir: "cacheDir",
  vectorApiKeyEnv: "apiKeyEnv"
});

/**
 * The hot keys one surface owns.
 *
 * Both the tool row and the command row resolve the same `vector*` keys, so a
 * patch must reach both; routing per key instead would let the row that happens
 * to be registered first absorb an edit the other never sees.
 * @param surface - `compaction` or `vector`.
 * @returns a Set of key names.
 */
export function hotKeysFor(surface) {
  const out = new Set();
  for (const entry of HOT_KEYS) if (entry.surface === surface) out.add(entry.key);
  return out;
}

/** Rows that can absorb a live patch, in registration order. */
const consumers = new Map();

/**
 * The persisted overlay, read fresh each call.
 *
 * A malformed or unreadable file must not take the row down: the overlay is a
 * convenience layer over the patch file, so an unreadable one means "no
 * overrides", which is also what a missing file means.
 * @returns the stored `{ compaction?, vector? }` object, or an empty one.
 */
export function readOverlay() {
  let raw;
  try {
    raw = fs.readFileSync(overlayPath(), "utf8");
  } catch {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out = {};
  for (const surface of ["compaction", "vector"]) {
    const slice = parsed[surface];
    if (slice === null || typeof slice !== "object" || Array.isArray(slice)) continue;
    const clean = {};
    for (const [key, value] of Object.entries(slice)) {
      const entry = BY_KEY.get(key);
      if (entry === undefined || entry.surface !== surface) continue;
      clean[key] = value;
    }
    if (Object.keys(clean).length > 0) out[surface] = clean;
  }
  return out;
}

/**
 * One surface's persisted overrides.
 * @param surface - `compaction` or `vector`.
 * @returns the stored key/value pairs for that surface, or an empty object.
 */
export function overlayFor(surface) {
  return readOverlay()[surface] ?? {};
}

/**
 * Persist one surface's overrides, replacing what was there.
 *
 * Atomic by rewrite-through-rename: the panel can be saved twice in a second and
 * a half-written file would make every later boot fall back to "no overrides"
 * until someone noticed.
 * @param surface - `compaction` or `vector`.
 * @param patch - complete override set for that surface; an empty object clears it.
 */
function writeOverlay(surface, patch) {
  const file = overlayPath();
  const current = readOverlay();
  if (Object.keys(patch).length === 0) delete current[surface];
  else current[surface] = patch;
  const tmp = file + ".tmp";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Register a row that can absorb a live patch.
 *
 * `keys` is what that row actually resolves — the tool row and the command row
 * share the `vector` surface but do not own the same key set, so the surface alone
 * cannot say who should receive a patch.
 * @param name - row identity used in errors.
 * @param surface - which overlay slice this row's keys are persisted under.
 * @param keys - zero-argument function returning the keys this row accepts.
 * @param apply - `(patch, options) => (commit | undefined)`.
 * @param describe - `() => object`, the row's current effective hot values.
 * @returns a disposer that unregisters the row.
 */
export function registerLiveConsumer(name, surface, keys, apply, describe) {
  const token = Symbol(name);
  consumers.set(token, { name, surface, keys, apply, describe });
  return () => consumers.delete(token);
}

/**
 * Current effective value of every hot key, as the live rows see it.
 * @returns `{ key: value }` for keys some registered row reports.
 */
export function describeLive() {
  const out = {};
  for (const consumer of consumers.values()) {
    let snapshot;
    try {
      snapshot = consumer.describe();
    } catch {
      continue;
    }
    // Only keys this row CLAIMS count: two rows share the vector surface but not
    // the same key set, and a row that does not own `rank` must not overwrite the
    // value the row that does own it reported.
    let owned;
    try { owned = consumer.keys(); } catch { owned = null; }
    for (const [key, value] of Object.entries(snapshot ?? {})) {
      const entry = BY_KEY.get(key);
      if (entry === undefined) continue;
      if (entry.surface !== consumer.surface) continue;
      if (owned !== null && owned !== undefined) {
        const claims = owned instanceof Set ? owned.has(key) : Array.isArray(owned) && owned.includes(key);
        if (!claims) continue;
      }
      out[key] = value;
    }
    // A vector row reports the RESOLVED record, whose field names are not the
    // config key names. Map them so the form shows what the row is really using.
    if (consumer.surface === "vector") {
      for (const [raw, resolvedName] of Object.entries(RESOLVED_NAMES)) {
        const value = snapshot?.[resolvedName];
        if (value !== undefined) out[raw] = value;
      }
    }
  }
  return out;
}

/** The form's own description of the whitelist, so the client never restates it. */
export function describeKeys() {
  return HOT_KEYS.map((entry) => ({
    key: entry.key,
    surface: entry.surface,
    type: entry.type,
    min: entry.min ?? null,
    exclusiveMax: entry.exclusiveMax ?? null,
    // The form renders these three: the name a reader understands, what the value
    // does, and — only where it applies — what changing it at runtime costs.
    label: entry.label ?? entry.key,
    desc: entry.desc ?? null,
    risk: entry.risk ?? null
  }));
}

/** Every key some registered row accepts, with the rows that accept it. */
function ownersOf(key) {
  const entry = BY_KEY.get(key);
  if (entry === undefined) return [];
  const owners = [];
  for (const consumer of consumers.values()) {
    if (consumer.surface !== entry.surface) continue;
    let owned;
    try {
      owned = consumer.keys();
    } catch {
      continue;
    }
    const ok = owned === undefined || owned === null
      ? true
      : owned instanceof Set ? owned.has(key) : Array.isArray(owned) && owned.includes(key);
    if (ok) owners.push(consumer);
  }
  return owners;
}

/**
 * Apply one panel patch to every row that owns a key in it.
 *
 * Validation happens in the owning row's own resolver, not here: that resolver is
 * the single source of what a legal value is, and restating its rules in this
 * module is how the two drift apart.
 *
 * Two-phase: every touched row dry-runs first and returns a commit closure, and
 * only when all of them accepted is the overlay written and the commits fired. A
 * rejected value therefore changes nothing, instead of leaving the process
 * half-updated with the file holding a value no row accepted.
 * @param patch - `{ key: value }` from the panel.
 * @returns `{ values }` — the effective values after the change.
 * @throws Error carrying the row's own message when a value is refused.
 */
export function applyLive(patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("lcm live config: the patch must be an object");
  }
  const staged = new Map();
  const accepted = {};
  for (const [key, value] of Object.entries(patch)) {
    const entry = BY_KEY.get(key);
    if (entry === undefined) throw new Error(`lcm live config: "${key}" is not a live-tunable key`);
    const owners = ownersOf(key);
    if (owners.length === 0) throw new Error(`lcm live config: no loaded row owns "${key}"`);
    for (const owner of owners) {
      if (!staged.has(owner)) staged.set(owner, {});
      staged.get(owner)[key] = value;
    }
    (accepted[entry.surface] ??= {})[key] = value;
  }
  const prepared = [...staged.entries()].map(([consumer, rowPatch]) => ({
    consumer,
    commit: consumer.apply(rowPatch, { dryRun: true })
  }));
  for (const { consumer, commit } of prepared) {
    if (typeof commit !== "function") throw new Error(`lcm live config: row "${consumer.name}" refused to stage a patch`);
  }
  // Persist first: a failed write must leave the running rows on their old values,
  // otherwise the process is patched to something no restart would reproduce.
  for (const [surface, slice] of Object.entries(accepted)) {
    writeOverlay(surface, { ...overlayFor(surface), ...slice });
  }
  for (const { commit } of prepared) commit();
  return { values: describeLive() };
}
