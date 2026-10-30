# 3D Memory Sea V0.2 实施状态

> 本文件是唯一进度事实来源。每完成一块就更新。
> Stage 1：**Experience → Episode → Recall**。
> Stage 2：**Scope 隔离 + Episode 生命周期 + 持久化后台任务 + 可插拔 Embedding/Summary + 混合召回**。
> Stage 3：**Semantic Memory + Episode→Memory Consolidation + Evidence/Reinforce/Supersede/Contradict + Recall 同时检索 Episode 与 Memory**。
> Stage 4：**Pattern Memory + Pattern Evidence + Reinforce/Weaken + Memory Review/Staleness + Pattern-aware Recall + Pattern Scene**。
> 仍然不做：Skill / Procedure / Workflow Learning / 自动工具调用 / Prompt 自动生成 / Agent Policy / Neo4j / Qdrant / 知识图谱 / 多 Agent 记忆 / 用户画像推断 / 3D 前端重写。
> **Pattern is descriptive. Skill is executable.** 本阶段没有任何 `execute()/runSkill()/autoToolCall()/policyApply()`。

# Completed

## Stage 1 基线（摘要）

- 类型/配置/错误/工具函数：`src/types.ts`、`src/config.ts`、`src/errors.ts`、`src/util/*`。
- 存储：SQLite（Node 内置 `node:sqlite`，零运行时依赖）+ WAL + FTS5（可选迁移，失败降级 LIKE）。
- Capture：Experience 原文不可改写（Repository 无 updateContent，重复 id 走 `INSERT OR IGNORE`）；Episode 由确定性规则归属（同 session + 间隔 < idleMs）。
- Recall：lexical（FTS5 bm25）/ temporal（before-after + 14 天半衰期）/ semantic（可插拔）/ fusion（0.45/0.25/0.12/0.10/0.08，semantic 不可用时重新归一化），每条命中都带 `reasons`。
- Harness：`ctx.memorySea` 服务 + `memory_remember / memory_recall / memory_inspect` 三个工具。
- Scene：新格式 `{points, edges, stats}` + `legacy-adapter` 兼容旧 `3d-memory-sea` 前端。

## Stage 2 — Scope

- `src/scope/path-normalizer.ts`：路径规范化（分隔符统一、Win32 不分大小写、去掉末尾斜杠）+ `deriveProjectScopeId()` = `project_` + sha256(规范化路径).slice(0,16)，**同一目录在任何写法下都得到同一个稳定 scope id**。
- `src/scope/scope-resolver.ts`：唯一把 Harness 上下文翻译成 scope 的地方。优先级：`session.header.cwd` → `session.cwd` → session metadata 的 cwd/projectRoot/… → 显式配置 `config.scope.rootPath` → 宿主进程 cwd 兜底。带 sessionId→scope 缓存（LRU 上限 256）。
- 所有核心数据都带 `scope_id`：`experiences`、`episodes`、`memory_jobs`、`embeddings_v2`；Repository 的读写全部以 scopeId 为第一参数（`scopeWhere(scopeId)` 生成 `scope_id = ?`），**不做跨项目自动召回**。
- API 层统一传 scope：`capture/remember/recall/recallDetailed/getScene/getLegacyScene/status` 都接受 `{ scopeId }` 或 `{ rootPath }`；工具调用用 `exec.agent.id` 反查 session→scope；`session/event` 每次事件用 `session.header.cwd` 解析 scope 并登记。
- `003_scope.sql` + `database.backfillScopeIds()`：Stage 1 的老数据先标为 `project_legacy`，再按旧 `scope_root` 回填精确 scope id（幂等、事务内、失败只 warn）。
- `GET /api/memory-sea/scopes` 暴露已知 scope 与默认 scope。

## Stage 2 — Episode Lifecycle

- `episodes` 新增 `last_experience_at`、`closed_at`、`closed_reason`、`summary_status`（`004_episode_lifecycle.sql`）。
- `EpisodeBuilder`：
  - `assign()` 幂等（Experience 已有有效 episodeId 就复用），超时先 `close(idle_timeout)` 再建新 Episode。
  - `closeIdleEpisodes()` / `closeStaleEpisodes('startup_recovery')` / `closeForSession('session_end')`。
  - `applySummary()` 写回 title/summary/topics/participants/locations/confidence 并置 `summaryStatus='ready'`。
- `EpisodeRepository.close()` 是幂等的：只对 `status='open'` 生效，`closed_at` 用 COALESCE 保留首次关闭时间。
- `EpisodeSweeper`：定时收割（`episode.sweepIntervalMs`，默认 60s，`unref` + 单飞），关闭即触发摘要入队。
- 启动恢复：`startupMaintenance()` 对所有已知 scope 跑一次 `sweep('startup_recovery')`，重启后不会有「永远 open」的 Episode。
- 会话结束：`session/end-seed` 事件立即 `closeSession()`（reason=`session_end`），不等空闲超时。

## Stage 2 — Background Jobs

- `memory_jobs`（`005_jobs.sql`）：`UNIQUE(type, owner_type, owner_id)` 天然去重；状态机 `pending → running → completed/failed`，`attempts/max_attempts/available_at/error` 持久化。
- `JobRepository`：`enqueue / claim / complete / fail / reclaimStale / stats / listByOwner`。claim 用事务 + `available_at <= now`，**attempts 在 claim 时 +1**（崩溃也算一次尝试）。
- `JobRunner`：可配置 `intervalMs / maxPerTick / staleMs`；`tick()` 绝不抛错、单飞；失败退避 `min(300s, 2^(attempts-1) * base)`，超过 maxAttempts 落 `failed`；`whenIdle()` 供优雅关闭。
- 崩溃恢复：`reclaimStale()` 把 running 超时的任务拉回 pending（不重复消耗 attempts）；`backfillJobs()` 在启动/维护时把「已关闭但没摘要的 Episode」「pending embedding 的 Episode/Experience」补排进队列。
- Episode 关闭 → 自动 `episode_summary`；`summary` 成功 → 自动排 `episode_embedding`；capture 且 embedding 可用 → 排 `experience_embedding`。
- `GET /api/memory-sea/status` 的 `jobs` 字段给出 `pending/running/failed/completed`。

## Stage 2 — Embedding

- `EmbeddingProvider` v2：`name/model/dimensions`、`isAvailable()`、`embed()`、`embedBatch?()`。
- `NoopEmbeddingProvider`（`disabled` / `not-configured`，dimensions=0）+ `OpenAiCompatibleEmbeddingProvider`（`POST {baseUrl}/embeddings`，可注入 fetch，`AbortSignal.timeout`，非 2xx 抛带状态码错误，首调固化 dimensions）。
- `createEmbeddingProvider(settings, env)` 只按配置判定 `configured`，**启动时绝不探测网络**；缺 key/model/baseUrl 一律 Noop，不发请求。
- `embeddings_v2`（`006_embedding_versioning.sql`）：`UNIQUE(owner_type, owner_id, provider, model)` 支持换模型重算；`content_hash` 记录嵌入内容指纹（sha256），供将来增量重算；旧 `embeddings` 表数据自动迁移。
- `EmbeddingRepository`：`upsert / get / remove / loadVectors / metadata / countByScope`，BLOB 读写都做字节拷贝（避免 Float32Array 对齐问题）。
- env：`DSH_MEMORY_SEA_EMBEDDING_API_KEY`、`DSH_MEMORY_SEA_EMBEDDING_BASE_URL`。apiKey 只存在私有字段，不进日志、不进 `JSON.stringify(service.status())`。

## Stage 2 — Summary

- `EpisodeSummarizer` 接口 + `ExtractiveSummarizer`（确定性：标题按来源优先级挑自然语言经历、摘要 2–4 句 ≤400 字、去重）+ `LlmEpisodeSummarizer`（OpenAI 兼容 chat/completions，**任何失败都回退抽取式，绝不抛错**）。
- `createEpisodeSummarizer(settings, env)`：`provider='llm'` 且 endpoint+model 齐才用 LLM，否则抽取式。
- 摘要只做 **Episode enrichment**：不创建 `Memory / SemanticMemory / Knowledge` 任何对象（spec §62 的边界）。
- 摘要失败：Episode 保持 `summary_status='failed'`、状态照常关闭，Experience 原文与 Scene 不受影响。
- env：`DSH_MEMORY_SEA_SUMMARY_ENDPOINT / API_KEY / MODEL`。

## Stage 2 — Hybrid Recall

- `SqliteSemanticRecall.search(scopeId, query, limit)`：embed query → 按 scope 载入向量 → cosine → 只保留 >0；embed 异常不吞，由 RecallEngine 降级。
- `semantic.available` 是 getter（晚绑定）：真正拿到第一个向量前就是 false，RecallEngine 每次召回前现读。
- Semantic 不可用：`resolveWeights()` 把 semantic 权重置 0、其余四路重新归一化，并在 `memory_recall` 输出里说明「语义权重已重新分配」。
- Episode 命中优先使用 `summary`（有 summary 用 summary，否则 title + 前 3 条经历），避免长文本稀释可读性。
- Reasons 保持 keyword / semantic / temporal / importance / session，全部带人类可读 detail。

## Stage 2 — Scene / Evidence Chain

- Scene 仍在 scope 内：`getScene({ scopeId })` 只输出该 scope 的节点，Episode 节点带 `summary` + `experienceCount`。
- 旧前端契约不变：`/api/memory-sea/scene`、`/api/memory-sea/legacy-scene`；Episode label 用 title，`full` 优先 summary。
- `memory_inspect`：Experience → 所属 Episode + 同 Episode 全部原始经历；Episode → 全部 Experience + `orphanExperienceIds`（关联表与 `experiences.episode_id` 不一致的记录）+ embedding 元数据（provider/model/dimensions/contentHash）。

## 测试

- `npm test`：**206 个用例全部通过**（Stage 5 Phase 1 新增 16 例、Stage 5 Phase 2 新增 16 例、Stage 6 新增 10 例；Node 24 需 glob：`node --test "dist/tests/*.test.js"`）。
- 覆盖矩阵：
  - Stage 1 基线：Episode 归属/超时/多 session/重启恢复/派生字段；原文不可改写；FTS；Scene 稳定坐标；Legacy 字段；关键词召回/时间窗口/reasons/limit。
  - jobs（12）：入队去重、claim、失败退避、最大尝试、僵死回收、stats、owner 查询。
  - embedding（17）：noop、cosine 边界、OpenAI 兼容请求/解析/错误、仓库往返与 scope 隔离、语义排序、维度不一致跳过。
  - summary（14）：抽取式确定性/去重/截断/空输入、LLM 合法 JSON/非法 JSON/500/网络异常回退、provider 选择。
  - Stage 3 集成（13，`tests/stage3.test.ts`）：创建/强化/No-op/取代/冲突/幂等/Scope 隔离/无 embedding/语义记忆召回/证据下钻/历史/崩溃恢复/端到端。
  - pattern-analysis（8，`tests/pattern-analyzer.test.ts`）：模式创建/证据不足 no-op/强化/弱化/LLM 失败回退/合法 JSON/非法 JSON 回退/分析器选择。
  - review（7，`tests/review.test.ts`）：低置信度久置知识标 stale、刚强化不 stale、高置信度 keep、Pattern 两步降级、无矛盾只记录、dueCounts 口径、superseded 不改写。
  - Stage 4 集成（16，`tests/stage4.test.ts`）：模式创建/证据不足不创建/强化/弱化/取代/幂等/Scope 隔离/无 embedding/真实语义召回/模式召回/具体问题优先/证据下钻/旧知识 stale/刚强化不 stale/Scene 四类节点/端到端。
  - Stage 2 集成（8，`tests/stage2.test.ts`）：scope 隔离与跨项目不串味、同文本跨 scope 独立、Episode 生命周期字段与 idle 收割、关闭后摘要任务端到端（summaryStatus ready）、session end 立即关闭、inspect 空向量元数据、**重启恢复（关闭前入队的摘要任务重启后完成）**、Windows 路径归一化稳定 scope id。
  - Stage 4.5 集成（16，`tests/stage45.test.ts`）：弱查询判定、回访+弱问候召回、无 actor 不乱召回、actor 隔离、具体问题不被上下文干扰、连续性创建、不同话题不 continues、跨 session 延续、幂等、无 embedding、计划接续（相似度 0.12 也连上）、`expandContinuity` 展开与排序、关系不污染证据、Scene 连续性边 + legacy、三段跨 session 的 inspect 前后邻居、status 指标。
  - 其它：`tests/personal-plan.test.ts`（个人计划措辞进知识门槛）、`tests/sidecar.test.ts` 属 Live Agent 插件；本仓库 `tests/` 覆盖上述 166 例（Stage 4.6 新增 `tests/stage46.test.ts` 17 例）。
- `npm run smoke` → `SMOKE OK`（场景 A–D + 假 ctx 跑插件入口 + Stage 2 scope/收割/摘要/Jobs 输出）。
- `node scripts/verify-stage2.mjs` → `VERIFY STAGE 2 DONE`（宿主可用性的 A–D 取证 + 性能数字，见「宿主验收证据」）。
- `node scripts/verify-stage3.mjs` → `VERIFY STAGE 3 DONE`（认知闭环 A–G 取证 + 性能数字，见「Stage 3 — 认知闭环取证」）。
- `node scripts/verify-stage4.mjs` → `VERIFY STAGE 4 DONE`（Pattern 认知闭环 A–I 取证 + 真实 HTTP 向量通道 + 性能数字，见「Stage 4 — 验收取证」）。
- `node scripts/verify-stage45.mjs` → `VERIFY STAGE 4.5 DONE`（弱查询召回 + 参与者隔离 + Episode 连续性 + 展开 + Scene + 性能，见「Stage 4.5 — 验收取证」）。

## Harness 宿主

- 插件包 `dsh-3d-memory-sea@0.2.0` 已通过 `plugin_manager install_bundle` 装入 desktop profile（link 到本目录）。
- 只读 HTTP：`/api/memory-sea/{status,scene,legacy-scene,scopes,health}` + `/api/memory-sea/memories[/:id]`（Stage 3）+ `/api/memory-sea/patterns[/:id]`（Stage 4）+ `/api/memory-sea/episode-relations` 与 `/api/memory-sea/episodes/:id/continuity`（Stage 4.5）。没有任何写操作 HTTP。
- `inject` 必须是 `['tools', 'webServer']`（Stage 4.5 修）：只写 `['tools']` 时 `ctx.get('webServer')` 拿不到服务，路由静默缺失，宿主兜底 401。
- `ctx.memorySea` 暴露 Service；工具 3 个（不增加细碎工具）。

## Stage 2 — 宿主验收阶段补的四处修复

宿主里用真实历史库（312 Experiences / 4 Episodes）验收时暴露的问题，已全部修好并回归测试：

- **旧 scope_id 迁移遗漏**：Stage 1 写入的是 `p_xxxxxxxx` 形态，而 `003_scope.sql` 原来只把 NULL/'' 标为 `project_legacy`，导致历史数据「既不迁移也不可见」（新 scope 计数为 0）。现在 `003_scope.sql` 与 `Database.backfillScopeIds()` 用同一规则：**任何不是规范 `project_*`、也不是 `global` 的 scope_id 都按 `scope_root` 重算成 `project_<hash>`**（幂等、事务内、失败只 warn）。修复后宿主 312 条历史经历全部落到 `project_4ac392fdccfaa5c0`。
- **启动收割看不到库里的 scope**：`knownScopes()` 原来只来自「会话事件缓存 + 已建 context」，重启后还没有任何会话事件时会漏掉历史 scope，导致 open Episode 不被收割、pending 任务不补排。新增 `ExperienceRepository.listScopeIds()` / `EpisodeRepository.listScopeIds()`，`knownScopes()` 取「默认 + 缓存 + 库内出现过的 scope」并集，`startupMaintenance()` 对每个 scope 先 `sweep('startup_recovery')` 再 `backfillJobs()`。
- **FTS 命中被压成 0 分**：`bm25()` 在小库上是 1e-6 量级，`strength/(strength+2)` 会把真实关键词命中变成 `score=0.0000`，融合后只剩 recency/importance。改为**同一次查询内相对饱和**：最强命中=1，其余命中落在 0.35–1，`reasons` 里的 keyword 分也不再是 0。
- **验收取证脚本**：新增 `scripts/verify-stage2.mjs`（`node scripts/verify-stage2.mjs`），用编译产物真跑 A–D 四类场景并打印证据与性能数字，见下节。

## 宿主验收证据（`scripts/verify-stage2.mjs` 实跑输出）

- **A. Scope 隔离**：`scopeA=project_60b812c51f40c3d3` / `scopeB=project_cd1c561f850df691`，A 命中 2 条（episode+experience，score 0.7667），B 命中 0 条，A 结果里不含 B 的内容；reasons = `keyword(1.0) + temporal(1) + importance(0.45)`。
- **B. Episode 生命周期**：同 session 3 条 → 1 个 open Episode（`experiences=3`，`lastExperienceAt` 等于最后一条）；+30min 后 `runMaintenance()` → `closedReason='idle_timeout'`、`closedAt` 为数字、`endedAt` 保留最后经历时间；`drainJobs()` 1 个任务 → `summaryStatus='ready'`，title/summary 非空；`status.jobs={pending:0,failed:0,completed:1}`。
- **C. Semantic Recall**：注入确定性 concept embedder 后 `semantic.available=true`，`"Neo4j 暂时不上。"` 被 `"为什么没直接用图数据库？"` 以 `score≈0.577` 召回（证明语义通道真的接进链路）；宿主默认（embedding disabled）下同一 query 走 lexical 为 0 命中，而关键词 `"Neo4j"` 仍命中 2 条，且 `weights.renormalized=true`（lexical 0.6 / temporal 0.16 / importance 0.1333 / recency 0.1067）。
- **D. 重启恢复**：退出前 `jobs.pending=1`、Episode 已 closed；重开后 pending 仍在（持久化），`drainJobs()` 处理 1 个 → completed，`summaryStatus='ready'`，Scene 仍是 2 points / 1 contains edge。
- **性能**（500 条经历的小库，Windows 本机）：capture 平均 **1.80 ms/条**（500 条共 899 ms）；recall 平均 **1.55 ms/次**（50 次共 78 ms，命中 8 条）；runMaintenance 0.2 ms；drainJobs 0.1 ms；库文件 0.86 MB。

## Stage 3 — Semantic Memory 数据模型

- 类型（`src/types.ts`）：`SemanticMemory`（id/scopeId/kind/subject/content/normalizedContent/confidence/importance/status/validFrom/validUntil/createdAt/updatedAt/lastReinforcedAt/lastAccessedAt/reinforcementCount/accessCount/supersededBy/embeddingStatus）、`MemoryKind`（fact/decision/preference/goal/belief/constraint/principle/relationship/other）、`MemoryStatus`（active/superseded/expired/stale）、`MemoryEvidence{memoryId,evidenceType,evidenceId,relation,weight,createdAt}`、`EvidenceRelation`（supports/contradicts/derived_from/supersedes）。
- 迁移（001–006 未改动，migration immutable）：`007_semantic_memory.sql`（`memories` + `memory_evidence`，evidence 为主键去重的关系表，**不是 JSON**）、`008_memory_fts.sql`（可选迁移：`memories_fts`）、`009_consolidation_status.sql`（`episodes.consolidation_status`）、`010_memory_relations.sql`（`memory_relations`）。
- `MemoryRepository`：create/getById/listByIds/findActive/list/findByNormalized/searchLexical(FTS+LIKE 降级)/reinforce/updateContent/markSuperseded/setStatus/incrementAccess/setEmbeddingStatus/listPendingEmbedding/stats。**Memory.content 允许更新（派生知识），Experience.content 仍然绝对不可改写。**
- `EvidenceRepository`：`insert/insertMany`（幂等）、`listByMemory`、`countByMemory`、`hasEvidence`、`listMemoryIdsByEvidence`（**evidence → memories 反向查询**）、`recordRelation/listRelations`。
- `memory-normalizer.ts`：只做 trim/折叠空白/标点归一/ASCII 小写，**不通过 LLM 改写内容做唯一键**；`normalizedContent` 只用于去重。
- `memory-lifecycle.ts`：置信度公式（`1-(1-c)(1-d)`）、冲突降权、kind 推断、决定/取代/弱变化措辞词典、领域词典（storage/graph/vector/model/prompt/memory/harness）。

## Stage 3 — Consolidation（Dream 流水线）

- 进入条件：`status='closed'` 且 `summary_status='ready'`；`consolidation_status` 独立于主状态（pending/ready/failed/disabled）。
- `ConsolidationCandidateFinder.buildContext()`：同 scope 的 `episodes.recent(120)` 打分（topics 0.5 + bigram 0.3 + 时间 0.2，45 天窗口）取相关 Episode（≤8），再用 Memory FTS + evidence 反查 + 高重要度兜底取相关 Memory（≤12）。**不依赖 embedding**。
- `Consolidator` 三档：`RuleBasedConsolidator`（默认，确定性）、`LlmMemoryConsolidator`（OpenAI 兼容 chat/completions，严格 JSON 操作数组，任何失败回退规则式）、`createMemoryConsolidator()` 按配置选择；`configured=false` 时 Episode 标 `disabled` 而不是失败。
- `ConsolidationApplier`：**整批事务化**（单条失败只 skip），支持 create/reinforce/update/supersede/contradict/noop；
  - create 前做 dedup（normalized 完全相等 或 相似度 ≥0.72 或本次已建），命中即退化为 reinforce；
  - reinforce 的幂等核心是 `insertMany()` 返回 0（该 Episode 早就支持过）→ skip，不累加计数；
  - supersede 必须先建新知识再标旧知识（禁止「旧的被取代却没有替代者」），旧知识作为 `memory` 类型的 `supersedes` 证据保留；
  - contradict 只加 `contradicts` 证据 + 降置信度，不 supersede；
  - 同批次同一条知识最多强化一次（避免「标题 + 摘要」把计数刷两次）；
  - validFrom/validUntil 用 **Episode event time**，不是 job 执行时间。
- `DreamRunner`：只负责发现 eligible Episode 并入队（Episode 关闭 → 摘要完成 → consolidation job；启动扫描 + 手动 maintenance），执行完全复用 Stage 2 的持久化 `memory_jobs`。

## Stage 3 — Evidence / Supersede / Contradiction

- 每条 Memory 至少一条 evidence（applier 在 evidence 为空时直接 skip，不存在没有来源的知识）。
- 强化：`reinforcement_count += 1`、`last_reinforced_at`、confidence 提升（bounded ≤1，一次强化不会到 1）。
- 取代：`old.status='superseded'`、`old.superseded_by=new.id`、`old.valid_until=eventTime`，`memory_relations` 记 `supersedes`，新旧都有完整 evidence。
- 冲突：`contradicts` 证据 + 降 confidence + `memory_relations`，**不自动 supersede**（无法判断新旧时不许猜）。
- No-op：编译输出、打开文件、npm test、一次性闲聊不进长期知识（工具输出/结构化回执/路径堆在候选阶段就被过滤）。

## Stage 3 — Recall / Scene / API 集成

- `RecallRequest.types` 支持 `'memory'`；默认召回 experience + episode + memory。
- Memory 通道：Memory FTS（+可选 Memory embedding）+ confidence/importance/reinforcement 修正（`memoryBoost`，clamp ≤2），与 lexical 同批融合，reasons 增加 `confidence`（`置信度 0.xx`）与 `reinforcement`（`已被 N 次整理强化`）。
- `includeSuperseded`（默认 false）：打开后可回答「以前为什么这样决定」，历史不删除。
- `expandEpisodes` 正式接线：Memory 命中展开证据 Episode（≤3），Episode 命中展开代表 Experience（≤3），`RecallHit.expanded`。
- Scene：Memory 为内层核心节点（球壳 30，size = importance + confidence + reinforcement，**clamp 3.2–7.5，不无限增长**），边 `kind: 'derived_from' | 'supports'` 且**必带 reason**；legacy 适配器把 Memory 映射为 `kind='conclusion'`、`topic='memory'`、`weight=3 + importance*1.4 + confidence*0.6`，旧前端契约不变。
- 只读 HTTP：新增 `/api/memory-sea/memories`（scope/status/kind/limit/includeSuperseded）与 `/api/memory-sea/memories/<id>`（含 evidence），**不提供任何写操作 HTTP**。
- `memory_inspect`：支持 Memory → 证据 Episode 列表 → 原始 Experience（完整证据链），并展示 kind/status/置信度/强化次数/生效区间/supersededBy/向量元数据。
- `memory_remember`：仍然只写 Experience（metadata 标 `explicitMemoryIntent`），不绕过证据直接造 Memory。

## Stage 3 — 测试与验收证据

- `npm test`：**117 个用例全部通过**（Stage 2 / 3 / 4 全量回归 + 个人计划阈值回归 `tests/personal-plan.test.ts`）。
- `tests/stage3.test.ts`（13）：创建（decision + evidence）、强化（不新增知识、计数与证据增加）、no-op、取代（旧 superseded + 新 active + 历史证据在）、冲突（不 supersede、记录 contradicts、降置信度）、幂等（同一 Episode 整理三次不重复）、Scope 隔离、无 embedding 仍能形成 Memory、语义记忆召回（reasons + expanded）、证据下钻、历史（includeSuperseded）、崩溃恢复（pending 任务重启后补跑且不重复）、端到端（Scene/legacy/status）。
- `node scripts/verify-stage3.mjs` → `VERIFY STAGE 3 DONE`，实跑输出见下节。

## Stage 3 — 认知闭环取证（`scripts/verify-stage3.mjs` 实跑）

- **A 形成知识**：E1 三段经历（SQLite 决定 + Neo4j 暂时不上 + 本地低复杂度优先）→ 1 个 closed Episode → 整理出 2 条知识（`decision: 决定 Memory Sea V0.2 先用 SQLite 存记忆。`、`preference: Neo4j 暂时不上，当前优先保持本地、低复杂度方案。`），confidence 0.810，evidence 指向该 Episode。
- **B 强化**：2 小时后 E2（`再确认一次：Memory Sea 继续用 SQLite，保持本地优先。`）→ **知识总数不变**，`reinforcementCount=1`，confidence 0.810 → 0.833，证据 Episode 变成 2 个。
- **C 取代**：E3（`数据规模上来了，决定迁移到 PostgreSQL 并评估图数据库。`）→ 旧 decision `status=superseded`、`supersededBy=mem_…`、`validUntil` 为 Episode 事件时间；新 decision active，内容完整（不再被标题截断）；旧知识的 1 次强化与证据全部保留。
- **D 召回**：`为什么 Memory Sea 先用 SQLite？` + `expandEpisodes: true` + `includeSuperseded: true` → Memory 命中 `score=1.0000`，reasons = keyword(1) + temporal + importance + confidence(0.8328) + reinforcement(0.2)，并展开 2 个证据 Episode；同批还返回 Episode 与 Experience 命中（Memory 稳定排在前面）。
- **E 证据下钻**：`inspect(memory)` → 证据条数 2 → Episode → 原始 Experience id 列表。
- **F Scene**：`points=11 / edges=8 / memories=2`，Memory 节点 size 5.37（被 clamp），证据边 2 条均带 reason（`这条记忆由该段经历提炼而来`）；legacy `ok=true`，Memory 点 `kind=conclusion`。
- **G 性能**：capture 200 条 952 ms（平均 **4.76 ms/条**，含首次 FTS/索引开销；纯 capture 快路径不做整理/向量）、recall 平均 **2.57 ms/次**、库 0.56 MB、`jobs.completed=6`、`consolidation={pending:0,ready:3,failed:0}`。

## Stage 3 — 真实宿主验证（desktop profile / 真实数据库）

- 重载方式：`plugin_manager set_bundle target=dsh-3d-memory-sea enabled=false` → `enabled=true`（两次 `applied`）。
  **注意**：热重载不会 dispose 上一代实例，探针显示 `/status` 仍返回 Stage 1 形状（`projectId: p_17ljcwg`、`experiences:0`）、
  `/health` 返回 Stage 2 形状、只有 `/api/memory-sea/memories`（Stage 3 新增路由）由新实例响应 →
  **需要重启一次 DeepSeek 才能让 `/status`、`/scene`、`/health` 都来自同一个 Stage 3 实例**（spec §82，留给用户执行）。
- 认知闭环（用插件同一套 `MemorySeaService` + 宿主真实库 `C:\Users\Administrator\.dsh\3d-memory-sea\memory-sea.db`，独立 scope `project_bb74376c60f1c966`，`embedding=none`）：
  - E1（`决定 Memory Sea V0.2 先用 SQLite 存记忆，本地优先。` + `Neo4j 暂时不上，当前优先保持本地、低复杂度方案。`）→ 2 条知识：`decision conf=0.872 evidence=3`、`preference conf=0.814 evidence=1`。
  - E2（`再确认一次：Memory Sea 继续用 SQLite 存记忆，保持本地优先。`）→ **知识数不变**，`reinforcementCount=1`、`confidence 0.872 → 0.887`、evidence 4。
  - E3（`数据规模上来了，决定迁移到 PostgreSQL 并评估图数据库。`）→ 旧 decision `status=superseded`、`supersededBy=mem_c53f3da9…`、`validUntil` 为 Episode 事件时间；新 decision `active conf=0.818`；历史上 1 次强化与全部证据保留。
  - 召回 `为什么 Memory Sea 先用 SQLite？`（+`expandEpisodes`+`includeSuperseded`）→ **Memory score=1.0000**，reasons=`keyword(1) temporal(0.9968) importance(0.9) confidence(0.8874) reinforcement(0.2)`，展开 3 个证据 Episode；Episode/Experience 命中排在后面。
  - 证据链：`inspect(memory)` → `evidence=2 → episodes=1 → experiences=1`（Memory → Episode → 原始 Experience）。
  - Scene：`points=11 edges=7 stats={experiences:5,episodes:4,memories:2}`，Memory 节点 `size=5.46/5.54`（clamp 生效），证据边 `derived_from` 带 reason；legacy `ok=true`、Memory 点 `kind=conclusion`、`topic=memory`。
- 宿主 HTTP 只读验证（新实例）：
  - `GET /api/memory-sea/memories?scope=project_bb74376c60f1c966&includeSuperseded=true` → 返回 3 条（含 `status=superseded` + `supersededBy` + `validFrom/validUntil`）。
  - `GET /api/memory-sea/memories/mem_c53f3da9-…` → `{ok:true, memory, evidence:[{episode,derived_from},{memory,supersedes}]}`。
- 宿主内工具真调用：`memory_remember` → 写入 Experience `xp_95b85f21-…` 并归入当前 open Episode；`memory_inspect(mem_c53f3da9-…)` → 输出 Memory/证据 Episode/证据关系/原始 Experience（Memory 分支在真实宿主可用）。

## Stage 4 — Pattern Memory 数据模型

- `PatternMemory`：`id / scopeId / kind / content / normalizedContent / confidence / importance / supportCount / contradictionCount / status / subject? / domain? / firstObservedAt / lastObservedAt / createdAt / updatedAt / lastReinforcedAt? / lastReviewedAt? / lastAccessedAt? / accessCount / supersededBy? / embeddingStatus`。
- `PatternKind`：`preference | strategy | habit | principle | recurring_decision | recurring_problem | recurring_solution | trend | other`。
- `status`：`candidate → active → weakened → stale`，另有 `superseded` / `archived`（历史永不删除）。
- `PatternEvidence{patternId, memoryId, relation: supports|contradicts, weight, createdAt}`：**证据指向 Semantic Memory，不指向原始 Experience**；完整链条 `Pattern → Memory → Episode → Experience`。
- 迁移：`011_pattern_memory.sql`（`patterns` + `pattern_evidence` + 索引）、`012_pattern_fts.sql`（可选 FTS，不可用降级 LIKE）、`013_memory_review.sql`（`memories.last_reviewed_at` / `review_status` + 两个 sweep 索引）。001–010 未改动。
- Embedding owner 增加 `pattern`，创建后异步 `pattern_embedding`。
- 新的 job 类型（仍是同一张 `memory_jobs` / 同一个 JobRunner）：`memory_pattern_analysis`、`pattern_embedding`、`memory_review`。

## Stage 4 — Pattern Analysis（Dream 第二步）

- 触发：`episode_consolidation` 产出/强化/取代 Memory 后，对 `applied.created ∪ reinforced ∪ superseded` 逐个 enqueue `memory_pattern_analysis`（**不在 capture 或整理事务里同步分析**）。
- `PatternCandidateFinder.buildContext(triggerMemory, {maxRelatedMemories=12, maxExistingPatterns=8})` → `PatternContext{scopeId, triggerMemory, relatedMemories, existingPatterns}`：
  - relatedMemories = trigger + 同 scope 的 FTS/bigram 命中（active）+ 概念层从 `memories.findActive()` 里按 `sharedConcepts()` 捞到的同概念知识；
  - existingPatterns = FTS 命中 + 该 Memory 已有证据的模式 + 概念家族匹配（`patterns.findCandidates` + `conceptsOf` 交集）。
- `RuleBasedPatternAnalyzer`（默认、无 LLM 也能跑）：用 `dominantConcept(texts, minSupport)` 找出「多条独立知识共享的结构性概念」，只有支持者 ≥ `max(2, minSupport)` 才 `create`；已有同概念家族模式 → `reinforce`；出现明确相反方向信号（`hosted_cloud_shift` vs `local_first/avoid_*`）→ `weaken`；证据不足 → `noop`。
- 6 个内置概念（`PATTERN_CONCEPTS`）：`avoid_infra_complexity`（recurring_decision）、`avoid_extra_services`、`avoid_graph_database`、`local_first`、`upgrade_after_scale`、`hosted_cloud_shift`（trend）。每个概念带 `statement`（描述性、限定「该项目」而不评价人格）与 `tokens`。
- `LlmPatternAnalyzer`（可选）：OpenAI 兼容 `/chat/completions`，严格校验 `patternId`/`memoryId` 必须出现在输入集合、kind 非法→`other`、数值 clamp、最多 2 个操作；任何失败（网络/非 2xx/超时/非法 JSON/空操作）**回退规则式且绝不抛错**。
- `PatternApplier`：整批 `db.transaction()`；单条失败只计 `skipped`；批内 `touched` / `evidenceTouched` 防同批重复；**create 要求 ≥2 个支持 Memory**，命中重复（normalized 全等或 bigram ≥0.72）退化为 reinforce；supersede 先立后废并继承旧证据。
- 激活门槛：`supportCount >= minSupport(3) AND confidence >= activationThreshold(0.7)`，否则保持 `candidate`。

## Stage 4 — Reinforcement / Weakening / Supersede

- reinforce：新增支持证据 → `supportCount += 真实新增证据数`、`confidence = 1-(1-c)(1-0.12)`、`lastObservedAt` 取支持 Memory 的最近事件时间，**不新建第二条模式**。
- weaken：新增反证证据 → `contradictionCount += 新增数`、`confidence` 下降；只有 `confidence < 0.45` 或 `contradictionCount >= max(2, supportCount)` 才转为 `weakened`。**一次例外不会让模式失效，更不会 supersede**。
- supersede：只用于明确的长期趋势改变，且必须同时给出新模式的 ≥2 个支持 Memory；旧模式变 `superseded` + `supersededBy` + `validUntil`（事件时间），历史证据保留。
- 幂等：同一 Memory 反复分析时，`insertMany` 返回 0 → 直接 skip，`supportCount` / `confidence` 不会被重复累加（`tests/stage4.test.ts` 幂等用例覆盖）。

## Stage 4 — Memory Review / Staleness

- Memory 增 `last_reviewed_at` + `review_status ∈ fresh | review_due | reviewed | stale`。
- `MemoryReviewService`：
  - `findDueMemories(scopeId)` → `status='active' AND review_status IN ('fresh','reviewed') AND COALESCE(last_reinforced_at, created_at) < now - memoryStaleAfterMs`（默认 180 天，**不粗暴按时间过期**）；
  - `reviewMemory(memoryId)`：非 active → keep 且不改列；active 且 `confidence < memoryStaleConfidence(0.95)` → `setStatus('stale')` + `markReviewed('stale')`；否则 `markReviewed('reviewed')`；
  - `sweepPatterns(scopeId)`：`active + contradictionCount>0 → weakened`；`weakened 且久未支持 → stale`；其余 `markReviewed`；
  - `dueCounts(scopeId)` → `{dueMemories, duePatterns}`（进入 `status.review`）。
- **stale ≠ 错误 ≠ superseded**：数据不删除，只标记「旧了、需要复核」；`supersede` 仍然只由明确新证据触发。
- 刚被强化过的知识不会 stale（`review_status` 回到 `fresh`，`last_reinforced_at` 更新）。

## Stage 4 — Recall / Scene / API 集成

- `RecallType` 增加 `pattern`；默认召回 `experience + episode + memory + pattern`（Experience 仍是证据层，通过 `expandEpisodes` 展开）。
- 新增 pattern 通道：`patterns.searchLexical`（FTS/LIKE，分数 `0.35 + 0.65*(strength/top)`）。
- `patternBoost = min(2, (0.85 + 0.3*confidence + 0.12*importance + 0.05*min(6,support)) * (0.9 + 0.2*stability))`；**只有查询带有模式意图**（`一直/通常/经常/倾向/习惯/反复/模式/趋势/总体/一般/…`，见 `PATTERN_INTENT_TOKENS`）才额外 ×1.3，因此具体问题仍优先具体知识。
- reasons 扩展：pattern 命中至少给出 `keyword / confidence / support（由 N 条长期知识支持）/ stability（稳定度 x.xx）`；memory 命中给出 `confidence / reinforcement`。
- 证据展开（`expandEpisodes`）：Pattern → 支持 Memory ≤3 → 每个 Memory 的证据 Episode ≤2；Memory → Episode；Episode → Experience。分数逐层 ×0.9，并标注「来自命中 …」。
- `memory_inspect` 支持 `pat_…`：Pattern 正文 + 支持/反证知识 + 证据关系 + 证据 Episode + 原始 Experience + 向量元数据，可继续用 Memory id 下钻到 Episode → Experience。
- Scene：新增 `type='pattern'` 节点（`patternKind / patternStatus / supportCount / stabilityScore`），位置 = 支持它的 Memory 质心（无支持时退回 `spherePosition(id,14)`），`size = clamp(4.0 + importance + confidence + min(6,supportCount)*… + stability, 4, 9)`；边 `supported_by` / `contradicted_by` **必带 reason**；`stats.patterns`。
- legacy 适配：`pattern → kind='conclusion'`、`topic='pattern'`、`cluster='长期模式'`、`weight` 含 supportCount；前端契约不变（`ok:true`）。
- 只读 HTTP：`GET /api/memory-sea/patterns`（`scope/status/kind/limit/includeSuperseded`）、`GET /api/memory-sea/patterns/:id`（含 `evidence`）。

## Stage 4 — 验收取证（`scripts/verify-stage4.mjs` 实跑）

- A 形成模式：3 段独立决策（`决定继续用 SQLite…` / `决定保持单进程…` / `决定省略缓存层…`）→ 3 条 Semantic Memory → **1 条 Pattern**（`kind=recurring_decision`、`status=active`、`confidence=0.772`、`support=3`），证据 3 条且全部指向 Memory id。
- B 强化：新增 `仍然不上消息队列，避免过度设计` → 模式数量仍为 1、`support 3 → 4`、`confidence 0.772 → 0.799`。
- C 例外不摧毁模式：`数据规模增长后决定迁移 PostgreSQL（规模证明有需要之后才升级）` → 旧模式仍 `active`（`support=5`、`confidence=0.824`），且**没有**产生「偏好 PostgreSQL」这类新模式。
- D Pattern-aware Recall：
  - `我们的架构选择一直有什么特点？` → `[pattern] score=1.0000` 排第一，reasons 含 `keyword/importance/confidence/support(5 条)/stability(0.42)`，展开支持 Memory 与证据 Episode；
  - `为什么 V0.2 先用 SQLite？` → `[memory] score=1.0000` 排第一（**Pattern 没有压过具体知识**）。
- E 证据链：`inspect(pattern)` → 支持知识 5 条；`inspect(memory)` → Episode → 原始 Experience。
- F Scene：`points=21 edges=21`，`types={episode:5, experience:10, memory:5, pattern:1}`，`stats={experiences:10, episodes:5, memories:5, patterns:1, edges:21}`；pattern 节点 `size=7.87 support=5 stability=0.416`（clamp 生效）；模式边 `supported_by` 带 reason；legacy `ok=true`、`patternPoint.kind=conclusion topic=pattern cluster=长期模式`。
- G 真实向量通道（脚本内起真实 HTTP `POST /embeddings` stub，`embedding.provider=openai-compatible`）：`embedding={enabled:true,available:true,provider:'openai-compatible',model:'stub-embed',dimensions:3}`；查询 `为什么没有直接采用图数据库？` → 命中 Memory `决定暂时不上 Neo4j。`（score 0.5248），理由含 `semantic 语义相近`；Experience/Episode 也带 semantic 理由。
- H 性能：capture 200 条 = 519 ms（**2.60 ms/条**）；recall 30 次 = 47 ms（**1.57 ms/次**）；DB 0.63 MB；`patterns={active:1,total:1}`、`review={dueMemories:0,duePatterns:0}`、`consolidation={ready:5}`。

## Stage 4 — 真实宿主验证（desktop profile / 宿主真实数据库）

- 迁移：宿主真实库 `C:\Users\Administrator\.dsh\3d-memory-sea\memory-sea.db` 已完成 `001`–`013` 全部迁移（`memory_sea_migrations` 表可查），新增 `patterns` / `pattern_evidence` / `patterns_fts` / `memories.review_status` 等结构；Stage 3 的 3 条 Memory 原样保留。
- 插件重载：`plugin_manager set_bundle enabled=false → true`（两次 `applied`），新实例注册了 `/api/memory-sea/patterns`、`/patterns/:id`（探针：`patterns → 200`）。
- 热替换仍残留旧实例：`/status`、`/health` 仍由 Stage 1/2 实例先匹配（`/health` 里没有 `memories/patterns/review` 字段），需要重启一次 DeepSeek 才能统一（spec §82，留给用户）。
- 真实宿主库认知闭环（`scripts/verify-stage4-live.mjs`，同一个 `MemorySeaService` + 同一个宿主 DB，scope `project_5ca055eda66d0003`，`embedding.provider=openai-compatible` 指向本地真实 HTTP `/embeddings` stub）：
  - 3 段独立决策 → 3 条 Memory → **1 条 Pattern**（`recurring_decision`、`active`、`support=3`、`confidence=0.772`）；
  - 第 4 条同向知识 → `support 3 → 4`、`confidence 0.772 → 0.799`，模式不增条；
  - `迁移 PostgreSQL` 的新 Episode → 模式仍 `active`（`support=5`、`confidence=0.824`），且**没有**产生「偏好 PostgreSQL」模式；该 Episode 提炼出的 principle（「这次是规模证明有需要之后才升级，不是推翻低复杂度原则」）作为支持证据被加入；
  - `为什么没有直接采用图数据库？` → Memory `决定暂时不上 Neo4j。` score 0.5248，reasons 含 `semantic 语义相近`（真实向量通道）；
  - `我们的架构选择一直有什么特点？` → Pattern score 1.0000 排第一；`为什么先用 SQLite？` → Memory score 1.0000 排第一；
  - `inspect(pattern)` → 证据 5 条 → 支持知识 5 条 → 每个 Memory 可下钻 Episode → 原始 Experience；Scene `points=27 edges=26 types={episode:7,experience:13,memory:6,pattern:1}`，模式边 5 条带 reason，legacy `ok=true`、`patternPoint.kind=conclusion topic=pattern`。
- **跨进程一致性**：脚本写入后，用宿主活实例读回来 ——
  - `GET /api/memory-sea/patterns?scope=project_5ca055eda66d0003` → `{ok:true,patterns:[{id:'pat_35190b4f…',kind:'recurring_decision',status:'active',supportCount:5,confidence:0.8235}]}`；
  - `GET /api/memory-sea/patterns/pat_35190b4f-…` → 完整 Pattern + `evidence[]`（supports 5 条，指向 Memory）。
- 宿主工具层真调用：`memory_inspect(pat_35190b4f-…)` 返回 Pattern 正文/kind/status/置信度/支持 5/反证 0/首次与最近出现/最近强化 + 「支持这条模式的知识」5 条 + 证据关系 + 证据 Episode 6 条 + 原始 Experience 12 条 + 下钻提示；`memory_recall` 在真实会话里正常返回多类型命中与 reasons。

## Stage 4 — 已知限制

- 规则式模式分析只有 **6 个内置概念**：能覆盖「避免过早复杂化 / 本地优先 / 避免图数据库 / 规模证明后才升级 / 转向托管云」这几类常见工程模式，其它主题会 `noop`（宁可不产出，也不制造假洞察）。要覆盖更多主题需扩 `PATTERN_CONCEPTS` 或接 `pattern.provider=llm`。
- 模式分析按 Memory 逐个触发，同一批 Memory 可能多次入队（幂等保证不重复计数，但会多做几次候选发现）。
- `review.duePatterns` 用 `listDueForReview` 长度估算（limit 上限内），大量 pattern 时可能低报。
- 「迁移 PostgreSQL」这类 Memory 可能被算作「避免过早复杂化」模式的支持证据（升级发生在规模证明之后），语义上可接受但表达不够精确；更精确需要 LLM 分析器。
- pattern embedding 在宿主里仍受限于没有真实 embedding endpoint（脚本用 stub 验证了通道本身）。

## Stage 4.5 — 短查询上下文召回（Contextual Recall）

问题：真实直播里「主播好」「我来了」这类输入信息量极低，lexical/semantic 通道几乎必然空命中，导致回访观众的关键记忆（「我下周要复试」）召不回来。

- `RecallRequest` 向后兼容地新增 `context?: RecallContext`（`actorId / sessionId / currentTopic / returningActor / interactionType / recentEntityIds / recentMemoryIds`）与 `expandContinuity?: boolean`。Memory Sea 内部**只用通用词汇**，不出现 viewer / 直播 / 弹幕 等领域词。
- `ShortQueryDetector`（`src/recall/short-query-detector.ts`，无 LLM、纯规则）输出 `querySignal: 'normal' | 'weak' | 'empty'`：长度阈值（默认 6）、问候/确认/代词/续接词表；`主播好 / 你好 / 我来了 / 嗯 / 然后呢 / 怎么样了` → weak，`为什么我们没用 Neo4j？` → normal。
- `ContextualRecall`（`src/recall/contextual-recall.ts`）是**独立候选源**，不按 query 文本检索：只有 `signal === 'weak'` **且**有 actor 上下文（`returningActor === true` 或显式近期 id）时才产出候选，最多 `contextualRecall.maxCandidates`（默认 5）。
  - 候选资格：Memory 需「显式近期 id」或 actor 命中（Memory → evidence Episode → Experience `metadata.actorId`）；Episode 只按 actor 命中，权重打折（分母 2.4）。
  - `score = importance × confidence × recency × returningBoost × interactionBoost × continuationBoost`，`recency = 0.5 + 0.5·exp(-age/window)`；问候/续接/提问各有一点 boost；未完成计划（`looksUnfinished`）再 ×1.25。
  - reason 类型为 `context`（`returning actor 的近期经历片段`）或 `continuation`（`returning actor 的近期未完成计划`），**永远可解释**。
- Recall Engine 把它作为第 4 条通道并入融合：`signals.lexical = max(lexical, contextual)`，因此 normal 查询的排序完全不受影响（contextual 恒 0），weak+context 时才抬升；异常只 `degraded.push('contextual')`，不影响其它通道。
- 硬约束全部由结构保证：无 actor 的「你好」返回 **0 命中**（不做随机召回）；同一 query 不同 actor 结果不同；actor 上下文不能突破 scope（scope 仍是查询主键）；contextual 默认只出 memory+episode，不出 pattern/experience。

## Stage 4.5 — Episode 连续性（Continuity，不做物理合并）

问题：同一人的经历被 5 分钟 idle、场次边界切碎成多个 Episode，跨场次召回断链。

- 迁移 `014_episode_relations.sql`：`episode_relations(source_episode_id, target_episode_id, scope_id, relation, confidence, reason, created_at, PRIMARY KEY(source,target,relation))` + 三个索引；`episodes` 增 `continuity_status`。**不做 Physical Merge**：Episode 的 summary/title/Experience 一律不改写，只新增关系。
- `EpisodeRelationRepository`：方向固定 **source=较早，target=较晚**；`upsert/insertMany` 用 `INSERT OR IGNORE` 保证幂等；`previous/next/count/episodesLinked/listForScope`。
- `EpisodeContinuityFinder`：Episode closed + summary ready 后，同 scope 近期（默认 30 天、最多 10 个）候选；提取 actorIds（`metadata.actorId / viewerId / platformUserId`）、threadKeys、topics、tokens、正文摘要。
- `RuleBasedContinuityAnalyzer`：`0.32·同参与者 + 0.20·文本相似 + 0.18·话题重合 + 0.14·token Jaccard + 0.10·时间近 + 0.16·计划接续`；`continues` 要求同参与者 + 有实质关联 + 7 天内（或计划接续）+ 高分；同参与者但话题不同最多 `same_thread`，同话题最多 `same_topic`；置信度低于 `minConfidence`（0.45）不建关系。`hasPlanContinuity` 认「复试/考试/面试/上线…」或「一边计划、一边收尾（结束/完成/考完/刚）」。
- 后台：新 job `episode_continuity`（复用 Stage 2 持久化 JobRunner，summary 完成后入队；`backfillJobs` 会补排 `listPendingContinuity`）；公开 `backfillEpisodeContinuity(scopeId, {maxEpisodes, lookbackDays})`。同一 Episode 跑 N 次关系数不变。
- 消费端：`expandContinuity: true` 时 Episode 命中会展开前/后相关 Episode（每方向 ≤`maxExpansionDepth`，默认 2，分数 ×0.85、reason 为 `continuation`）；Scene 只画两端都在场景内的 `continues/followup` 边（带 reason）；`memory_inspect` 的 Episode 输出「连续性（不是证据）」块；只读 HTTP `/api/memory-sea/episode-relations` 与 `/api/memory-sea/episodes/:id/continuity`。
- **关系不是证据**：`memory_evidence` 不因关系建立而新增一行（专门有用例守）。

## Stage 4.5 — 验收取证（`scripts/verify-stage45.mjs` 实跑）

- 弱查询判定：`主播好/你好/我来了/嗯/然后呢/怎么样了` → weak；`为什么我们没用 Neo4j？` → normal。
- 回访 + 弱问候：4 条命中，`我下周要复试，先准备专业课。`（Memory）以 **0.7003** 排第一，reasons = `continuation(returning actor 的近期未完成计划)` / `temporal` / `importance(0.60)` / `confidence(0.80)`；另外 3 条 Episode 带 `context` 理由；**无 actor 的「你好」命中 0**。
- 参与者隔离：`actor_li` 只命中旅行相关，`actor_zhang` 只命中复试相关。
- 连续性：4 Episodes / 3 relations（每 Episode 平均 **0.75** 条，未过连接）；`A→B continues 0.81`、`A→C continues 0.66`、`B→C followup 0.58`，reason 形如 `延续 · same actor/thread · future plan follow-up · shared topic 复试 · 1 小时 apart`。
- 展开：命中 Episode 的 `expanded` 全为 Episode、按时间正序、带 continuation 理由。
- Scene：points 10 / edges 9（含 3 条连续性边，全部带 reason），legacy `ok: true`。
- Status：`continuity {relations:3, episodesLinked:3}`、`recall {contextualEnabled:true}`。
- 性能（Windows 本机）：capture 200 条 **2.49 ms/条**；recall 60 次（普通 + 上下文）**1.10 ms/次**。

## Stage 4.5 — 真实宿主验证（desktop profile / 真实数据库）

- 新宿主（GUI 端口 51451）里第一次查 `/api/memory-sea/*` 全部 **401 unauthorized**：根因是插件只声明 `inject = ['tools']`，用 `ctx.get('webServer')` 取服务在 Cordis 里拿不到 → `registerSceneRoutes` 静默 return，宿主对未注册的 `/api/*` 兜底 401。修复：`inject = ['tools', 'webServer']`，优先用注入的 `ctx.webServer`（回退 `ctx.get`），拿不到时打 warn。
- 修复后重载插件，宿主真实库（scope `project_4ac392fdccfaa5c0`）实测：`/health` → `experiences 312 / episodes 4 / jobs{pending 23} / fts true`；`/status` → `memories 0 / patterns 0 / continuity{relations:6, episodesLinked:3} / recall{contextualEnabled:true} / consolidation{ready:4}`；`/episode-relations` 返回真实关系（例：`same_topic conf 0.5111 · shared topic · text similarity 0.58 · 1 分钟 apart`）；`/scene` → 316 点 / 312 条 contains 边（该 scope 的 6 条关系都是 `same_topic`，按设计不画进 Scene，只画 continues/followup）。
- Live Agent V0.1 已接线：`recallForViewer` 传 `context{actorId, sessionId, returningActor, interactionType}`，`memory.useLegacyReturningViewerFallback`（默认 true）作为 A/B 开关；关闭后不再手工合并「观众 active memory」，完全由 Memory Sea contextual recall 负责（对应 2 条新测试，live-agent 20/20）。`npm run stress` / `npm run simulate` 回归 PASS（dbKB 608、recallAvgMs 0.46、memory/experience 0.0588）。

## Stage 4.5 — 已知限制

- 连续性分析器只看「同参与者 + 话题/计划接续」，**不识别更抽象的事件延续**（例如没有共享词的两段经历）；需要时接 LLM analyzer（本阶段按 spec 未做）。
- 真实库的旧 Episode 是从「Agent 会话」切出来的，标题里混有英文与路径词，关系 reason 会显示 `shared topic current/the` 这类噪声。
- 关系只画 `continues/followup` 到 Scene；`same_thread/same_topic` 存在但不渲染，避免把 Scene 画成毛球。

## Stage 4.6 — Episode Summary Quality（候选过滤 + 质量评级）

机器密集的会话（子代理、编码 session）曾经出现「摘要 = 一串 `src/x.ts:21:import ...`」，
根因不是摘要器选错句子，而是**整段多行工具输出被当成一句话**：旧的过滤只看整段开头字符与
整体符号比例，长输出里夹着说明文字时两个阈值都不触发。

修复分三层：

1. **行级识别**（`src/util/text.ts`）
   - `looksLikeMachineLine(line)`：路径:行号:内容、源码行号前缀（`  21 | import ...`）、
     整行就是盘符/POSIX 路径、堆栈帧、`error TS1234`、构建耗时（`+28ms Done in 1.2s`）、
     命令行（`$ npm test`）、JSON 行、缩进代码行、符号占比 > 0.18。
   - `stripMachineLines(text)`：逐行剔除机器行，保留夹在中间的说明文字。
   - `machineShareOf(text)`：机器行字符占比（含宿主注入行），给质量评估用。
2. **候选提取**（`src/summary/extractive-summarizer.ts`）
   - 标题与句子都在 `stripMachineLines(stripRuntimeLines(content))` 之后才处理；
   - 单句再过 `looksLikeMachineLine` / `looksLikeMachineDump`（符号密度、箭头、console.log）；
   - `scoreSentence` 给意图句加权：命中 `决定|结论|目标|计划|偏好|约束|原则` +0.9、第一人称 +0.2，
     于是「决定 V0.2 先用 SQLite」排在编译日志之前。
3. **质量评级**（`src/summary/summary-quality.ts`）
   - `assessSummaryQuality({title, summary, experiences})` → `{grade, score, flags, narrativeChars, machineShare, hasIntent, topics}`；
   - 只有摘要本身被机器内容主导才算 `machine_dominated`（输入侧的 `input_machine_heavy` 只是信息性标记，
     不再让「一段 JSON + 一句人话」被误判）；
   - 空摘要 / 低于 0.45 分 → `poor`；`<0.72` 或含代码 → `fair`；其余 `good`；
   - 没有可靠人话时**明确回退**：`title='一段经历'`、`summary=''`、`grade='poor'`，绝不编造摘要。

派生数据可以重算（Experience / Evidence 一律不动）：

- `assessEpisodeSummary(episodeId)`：单个 Episode 的质量。
- `listSummaryQuality(scopeId, { limit })`：scope 内分布 + 明细（status 用 60 个 Episode 取样）。
- `requeueLowQualitySummaries(scopeId, { dryRun, limit, grades })`：默认 dry-run，只把低质量 Episode
  重新排进 `episode_summary` 后台任务；重算只改 `title/summary/summary_status`。

## Stage 4.6 — Actor Identity Continuity（身份规范化）

Stage 4.5 的连续性分析器把 `actorId / viewerId / platformUserId` 混成一个集合，
`vwr_<hash12>` 这类不透明旧 ID 和真正的稳定身份被同等对待 —— 这会让「昵称碰巧相同」有机会串在一起。

现在拆成五件事：

| 概念 | 含义 | 谁生成 |
| --- | --- | --- |
| `actorId` | 跨 Session 稳定的参与者标识 | Live Agent（`act_<sha256(platform:platformUserId)[0..16]>`）|
| `threadKey` | 一次连续互动所属线程 | Live Agent Episode Policy |
| `sessionId` | 一次 Session | Live Agent |
| `scopeId` | 记忆隔离硬边界 | Memory Sea Scope |
| `nickname` | 可变展示字段 | 平台 |

规范化规则（`src/continuity/actor-identity.ts`，确定性、可测试）：

- 可靠来源优先级：**`actorId`（high）> `platformUserId + platform`（high）> `viewerId`（medium）**；
  昵称永不参与，全部缺失 → 身份为 `null`，审计归类为 `missing`。
- 同一参与者跨 Session 得到同一个 `act_…`；改昵称不变；同名不同人不会合并（哈希输入只有平台 + 平台用户 ID）。
- 不跨平台合并：`platform` 是哈希输入的一部分。
- 只有 `viewerId` 的旧数据不会被伪造成 `actorId`（`actorMetadataPatch` 只补 `actorSource`），
  它们在连续性里最多算「弱身份」，只能出 `same_thread`。
- 连续性分析器只在 `strongActorIds` 有交集时判 `sameParticipant`（`continues/followup` 的前提）；
  `same_thread` 额外允许「同 threadKey」或「弱身份相同」。

历史回填（`normalizeActorMetadata` / `auditActorIdentity`，都支持 dry-run 与幂等）：

- 只写 `metadata_json` 的 `actorId` + `actorSource`，**永不改 content**，也不动 Evidence / relation。
- dry-run 两次结果一致；应用后二次运行 `wouldUpdate=0`；同一 key 重复执行不增长。
- 无法恢复身份的记录明确计入 `missing`，不猜测、不合并。

## Stage 4.6 — 验收取证（`scripts/verify-stage46.mjs` 实跑）

临时库（八类摘要输入）：

| 输入 | grade | 结果 |
| --- | --- | --- |
| 普通对话 | good 1.00 | 标题「今天研究 Memory Sea 的结构。」|
| 明确决定与目标 | good 1.00 | 保留「决定 V0.2 先用 SQLite」「目标一个月内跑通链路」|
| 工具 JSON 回执 | poor 0.00 | 明确回退（空摘要 + `一段经历`），不把 JSON 摘要成知识 |
| TS 代码 + 编译错误 | poor 0.00 | 同上（行号清单已被行级过滤拦下）|
| Windows 路径 | poor 0.00 | 同上（整行路径判定）|
| 中英混合技术词 | good 1.00 | 保留 SQLite / FTS5 / Neo4j / embedding |
| 纯日志 | poor 0.00 | 明确回退 |
| 开发会话混合 | good 1.00 | 人话优先，两次结果完全一致 |

临时库（身份）：

- 审计 4 条：`stablePlatformId=2 / legacyViewerId=1 / nicknameOnly=1`；
- dry-run `wouldUpdate=3` 两次一致 → 应用 3 → 二次运行 0 → 审计后 `normalizedActorId=3`（nicknameOnly 仍 1，不猜）。

真实宿主库（`--live`，7 个 scope / 759 条经历）：

- `stablePlatformId=21`（直播观众，有平台用户 ID）、`legacyViewerId=8`、`missing=730`
  （编码型 Agent 会话没有任何参与者元数据 → **明确记为无法回填**）；
- 回填写入 **29** 条 `actorId`（`json_extract(metadata_json,'$.actorId')` 计数 29），content 与 evidence 未变；
- 首个 scope 的 13 个 Episode：重排前 `good 8 / fair 2 / poor 3` → 重排后 `good 9 / fair 2 / poor 2`；
- 真实库里 `identityConfidence` 计数 0：这是 Live Agent 侧新字段，只对新写入生效，历史回填只补 `actorId`。

## Stage 4.6 — 已知限制

- 730 条 `missing` 是 Agent 编码会话，本身没有「参与者」概念；强行推断会违反 Evidence before inference。
- 摘要质量评级是**规则评分**，不是语义判断：一段通顺但空洞的句子仍可能 `good`。
- `requeueLowQualitySummaries` 只重算 `poor`（可传 `grades` 扩到 `fair`），重排后仍需后台 `drainJobs` 才落库。
- 身份规范化只做「同一平台内稳定」，跨平台关联仍需要显式映射表（本阶段禁止自动合并）。

## Stage 5 Phase 1 — Skill Candidate 数据模型

Phase 1 只做「把重复模式变成一个可审核的**描述性**候选」，不做任何执行。

- 迁移 `015_skill_candidate.sql`：`skill_candidates`（`source_pattern_id` + `scope_id` 唯一，
  保证一个 Pattern 只会派生一个候选）、`skill_candidate_versions`（`UNIQUE(candidate_id, version_no)`，
  每个版本把 procedure / trigger / preconditions / expected_outcomes / exceptions / limitations /
  success_criteria / evidence_snapshot 分列存 JSON，**只追加不覆盖**）。
- 迁移 `016_skill_attempt.sql`：`skill_attempts`（`UNIQUE(scope_id, external_key)` 幂等键）、
  `skill_outcome_evidence`（`PRIMARY KEY(attempt_id, evidence_type, evidence_id)`，
  只存指向原始证据的引用，不复制原文）。
- 迁移 `017_skill_review.sql`：`skill_reviews` 只在代码层追加（`createReview`），
  没有任何 update / delete 方法。
- 所有新表都带 `scope_id`；Repository + Service 两层都校验「候选 ↔ 版本 ↔ 尝试 ↔ 证据 ↔ 审核」同 scope，
  Scope 不匹配抛 `SkillScopeError`，不会静默写入。

## Stage 5 Phase 1 — 候选生成与版本化

- 入口 `SkillService.ensureCandidateForPattern(scopeId, patternId)`：
  Pattern 必须 `active`（或 `weakened` 且配置允许）、`supportCount >= skill.minSupportMemories`、
  `confidence >= skill.minConfidence`；支持 Memory 少于门槛直接抛错，不生成空壳候选。
- `deriveDraft()` 把每条支持 Memory 变成一步（`action` 取首句、`detail` 保留原文摘要、`evidenceRefs`
  指向该 Memory 及其来源 Episode）。**推导出的 v1 没有成功标准**，成熟度只会是 `structural_only`。
- `discover(scopeId)` 扫描 active Pattern 批量补候选，幂等（已存在只 `markProvenanceChanged`，不新建版本）。
- `createVersion()` 追加新版本：`changeReason` 与 `createdBy` 必填，审核中禁止建新版本，
  旧版本内容永不修改（父版本只有在 approved 时才置 `superseded`）。
- 状态机：候选 `drafting → ready_for_review → in_review → approved/rejected/changes_requested`；
  版本 `draft → submitted → approved/rejected/superseded`。

## Stage 5 Phase 1 — Attempt / OutcomeEvidence / 成熟度

- Attempt 生命周期 `planned → running → completed|aborted`，结果枚举
  `success|partial_success|failure|unknown|inconclusive`；`complete` 只在 `planned/running` 生效，
  完成后不可静默改写（更正需要新的可审计记录）。
- **没有预先定义成功标准时**，`success` / `failure` 会被降级为 `inconclusive`：没有标准就没有成功判定。
- `attribution ∈ direct|user_reported|inferred|none`；只有 `direct` / `user_reported` 进入已验证样本，
  `inferred` 只记录、不算证据。
- 独立证据折叠 `foldEvidence(scopeId, refs)`：按 `scope + 原始 id` 去重；同一 Episode 的多条 Experience
  折叠成一个单位；同一 Episode 派生的多条 Memory 只贡献 1 个独立 Episode；同一 Attempt 的多条证据
  只算一次执行。
- 成熟度四档 `insufficient → structural_only → observed → validated`，计算是**派生**的（不落库）：
  `validated` 必须同时满足步骤证据覆盖、独立 Episode 数、已定义成功标准与已验证尝试数。
- 成功率只在「预定义成功标准 + 至少一个已验证样本」时报告；`unknown` / `inconclusive` / `aborted`
  不进分母，`inferred` 不进分子分母。

## Stage 5 Phase 1 — 审核状态机

- `submitForReview()`：只允许 `drafting / ready_for_review / changes_requested`；`insufficient`
  会被拒绝并返回缺失项；`provenanceChanged` 且存在反例时拒绝提交。
- `review()`：版本必须 `submitted`、候选必须 `in_review`；`reviewer` 与 `reason` 都有最小长度校验，
  **没有可审计身份就不允许审核**；审核记录、版本状态、候选状态在同一事务里写入。
- 批准只做三件事：写审核记录、把版本置 `approved`、把候选置 `approved`；
  **不注册工具、不生成 Prompt、不执行任何步骤、不改变成熟度**。

## Stage 5 Phase 1 — Recall / Scene / API 集成

- Recall 与 Scene **不加入 Skill 候选**：Skill 是「待验证的描述」，不是当前可用的知识，
  混进召回会让用户以为系统已经会做某件事。
- 语义召回的 owner 白名单保持 `experience / episode / memory / pattern`，Skill 向量不会污染召回结果。
- 新增两个只读工具：`memory_skill_status`（候选列表 + 成熟度 + 缺失项）、
  `memory_skill_inspect`（候选 / 版本 / 尝试 / 审核 / 证据链 + 明确提示「批准不等于可执行」）。
- 新增两条只读 HTTP：`GET /api/memory-sea/skill-candidates`（含 `/:id` 详情）与
  `GET /api/memory-sea/skill-attempts/:id/evidence`；**没有任何写操作路由**。
- `status.skills` 暴露 9 个计数（candidates / drafting / readyForReview / inReview / approved /
  rejected / superseded / attempts / attemptsCompleted）。

## Stage 5 Phase 1 — 验收取证（`scripts/verify-stage5.mjs` 实跑）

真实 SQLite + 真实 Repository + 真实 `SkillService`，输出 `VERIFY STAGE 5 DONE`：

- 候选生成：首次 `created=true`，再次 `created=false` 且同一 id（幂等）。
- v1 由 Pattern 推导：步骤 3 条、成功标准 0 条、成熟度 `structural_only`。
- 人工补充成功标准后 v2：版本数 2、旧版本步骤与 changeReason 不变。
- 第一次真实尝试（user_reported success）：`verified=1`，成熟度 `observed`，缺失 `insufficient_verified_samples`。
- 第二次尝试（direct success）：`verified=2`，成熟度 `validated`，成功率 1（n=2）。
- 审核：提交后 `in_review` → 批准后 `approved`，审核记录 `submit → approve`（append-only）。
- 安全边界：跨 Scope 写入被拒绝、`SkillService` 上不存在 `execute / run / invoke / apply` 入口。

## Stage 5 Phase 1 — 真实宿主验证（desktop profile / 真实数据库）

- 重载 memory-sea 插件后（`plugin_manager set_bundle` enabled=false → true），新 prefix 路由立即可用：
  `GET /api/memory-sea/skill-candidates?scope=project_5ca055eda66d0003` 返回 200，并且**真实库里自动出现了一个候选**：
  - 候选 `skc_6e8af1b1-7511-499b-a824-abb4732fb9fb`，来源 Pattern `pat_35190b4f-...`
    （Stage 4 真实宿主验证时形成的「持续避免过早引入基础设施」模式，supportCount=5）；
  - 状态 `ready_for_review`、类型 `decision_rule`、v1 步骤 5 条、成功标准 0 条；
  - 成熟度 `structural_only`，缺失 `no_success_criteria`、`no_attempts`，尝试数 0、审核数 0。
- 这说明「Pattern → 候选」在真实数据上是通的，而且系统**没有**在缺少成功标准时假装成熟。
- `GET /api/memory-sea/skill-candidates/:id` 返回候选 + 成熟度 + 版本 + 尝试 + 审核；
  不存在的尝试证据接口返回 404（不是 500）。
- 旧实例问题：`/api/memory-sea/status` 仍由热替换前的旧实例响应（缺 `skills` 字段），
  与 Stage 4.5/4.6 相同，需要完整重启 DeepSeek 才能统一；新 prefix 路由由新实例正确响应。

## Stage 5 Phase 1 — 已知限制

- **真实操作者的审核入口尚未交付**：审核是 `SkillService.review()` 方法（可由受控脚本/测试调用），
  没有为 Agent 注册成工具，也没有写操作 HTTP —— 这是刻意的最小暴露面，但意味着 Phase 1
  的审核只能在受控环境里进行。
- 候选的步骤文本直接来自支持 Memory 的首句，可读但粗糙；人工编辑能力要等到有审核入口之后。
- `ready_for_review` 之后的「重新评估」目前靠 `skill_candidate_reevaluate` 任务手动/后台触发，
  没有事件驱动的及时重算。
- 成功率只在样本足够时报告，因此早期候选会显示「样本不足」，这是设计而不是缺陷。

## Stage 5 Phase 2 — 统计验证（成功率 / 置信区间 / 独立样本）

- `src/skill/statistics.ts`：`wilsonInterval(successes, trials, z)` 给出 Wilson score 区间；
  选它而不是 Wald，是因为 n 很小时 Wald 会给出负下界、在 0/1 附近塌缩。
- `countIndependentAttempts()` 以 **Attempt 为独立单位**：同一 Attempt 的多条证据只算一次执行；
  同一 Episode 派生的多条 Memory / Experience 折叠成一个 Episode 单位；同一结果的重复报告不新增样本；
  `inferred` 不进分子也不进分母；`unknown/inconclusive/aborted` 不进分母。
- `summarizeEffectiveness()`：样本量 `minReportableSamples`（默认 5）以下标记 `smallSample`，
  仍给区间但明确「样本不足」；只有独立已验证样本 ≥ 门槛才 `reportable`。
- 成熟度新增门槛：`minIndependentAttempts`（默认 5）、`minDirectAttempts`（≥1 次直接观察）、
  `minSuccessRateForValidated`（默认 0.5）、`wilsonZ`（默认 1.96）。
  `validated` = 有成功标准 + 独立已验证 ≥5 + 至少 1 次 direct + 成功率 ≥0.5 + 无矛盾 + Pattern 未被削弱。
- **两次成功不再等于 validated**：`verify:stage5` 现在 1 次 → `observed`、5 次独立 → `validated`（n=5，Wilson 95% CI 0.5655–1）。
- 旧字段 `minValidatedAttempts` 仍接受，与 `minIndependentAttempts` 取较大值（绝不静默放宽门槛）；
  `SkillService` 构造时用 `normalizeServiceSettings()` 合并默认值，避免调用方漏传字段导致门槛失效。

## Stage 5 Phase 2 — 人工审核入口（本机操作者令牌）

- `src/operator/operator-auth.ts`：宿主没有可信用户身份，因此用**本机令牌文件**
  `${DSH_HOME:-~/.dsh}/3d-memory-sea/operator-token`（首次生成 32 字节随机 hex，权限 0600，不覆盖已有文件）。
  `Authorization: Bearer <token>` + `timingSafeEqual` 比较 sha256；`requireLoopback` 默认开启，非回环 403；
  `operator.enabled=false` 时 503。失败一律关闭。
- Reviewer 由令牌派生：`local_token:op_<sha256(token) 前 8 位>`；请求体里的 `reviewer` 不被接受。
- 写路由（prefix `/api/memory-sea/operator`）：`GET /candidates`、`GET /candidates/:id`、
  `GET /candidates/:id/reviews`、`POST /candidates/:id/submit`、`POST /candidates/:id/review`、
  `POST /candidates/:id/versions`。
- 审核记录 append-only，`candidates.transaction()` 内一次写「审核记录 + 版本状态 + 候选状态」；
  重复审核不生成第二条记录，并被状态机拒绝。
- **批准只表示接受描述**：`approve` 只 `attachVersion`，不注册工具、不改 Prompt、不执行任何步骤。

## Stage 5 Phase 2 — Procedure 人工编辑与版本历史

- `SkillService.editProcedure()`：先 `validateDraft()` 再走 `createVersion()`，永不覆盖旧版本。
- 校验：步骤 1..`maxStepsPerDraft`；`action` 2..280 字；`evidenceRefs` 每条过 `assertEvidenceScope`；
  **无证据步骤强制 `inferred: true` + `source: 'manual'`**，有证据标 `source: 'evidence'`；
  成功标准必须写 `source`（`manual|evidence|derived`）。
- 编辑后：候选回 `drafting`、新版本 `draft`；旧审核记录与旧版本内容保持不变；
  新版本不继承旧批准（真实宿主实测：v3 成熟度从 `validated` 落回 `insufficient`，因为 Attempt 绑定具体版本）。

## Stage 5 Phase 2 — 事件驱动重评估（幂等）

- 复用 Stage 2 持久化 `JobRunner`：`skill_attempt_evaluate`、`skill_candidate_reevaluate`；
  Pattern 状态变化（created/weakened/superseded）、Memory 被 supersede 或降级 stale、出现反例都会触发。
- 触发只做「标记 + 入队」：`refreshSkillCandidatesForMemories()` / `refreshSkillCandidatesForPattern()`
  标记 `provenance_changed=true` 后排队；历史版本与审核记录不被修改。
- 幂等：入队键 `(type, owner_type, owner_id)`；失败指数退避重试，重启由 `backfillJobs()` 继续；
  重评估不触碰原始 Experience（测试断言 content 不变）。

## Stage 5 Phase 2 — 验收取证

- 单元：`tests/stage5b.test.ts` 16 例（统计 8 + 审核/版本/事件 8），全量 `182/182`。
- `npm run verify:stage5`：1 次尝试 `observed` → 5 次独立 `validated`（Wilson CI）→ 审核 submit→approve → 安全边界。
- 真实宿主（desktop profile，真实库）：`scripts/seed-stage5b-host.mjs` 在 `project_p2host` 造可审核候选
  （5 个独立 Episode/5 次成功尝试，`validated`、n=5、CI 0.5655–1）；令牌 0600 存在；无 token/错 token → 401、
  正确 token → 200；越权 scope → 404；submit → `in_review`；approve → `approved`（版本同步）；
  审核记录 2 条（`submit`/`approve`，reviewer `local_token:op_bbf306c3`，中文 reason 原样落库）；
  证据不足候选提交被拒 400（`step_coverage_below_half, step_without_evidence, no_attempts`）；
  `POST /execute` → 404。


### 真实宿主审核路径的可复现脚本

- `scripts/seed-stage5b-host.mjs`：在真实库的 `project_p2host` scope 造 5 个独立 Episode/Experience/Memory + active Pattern
  + 候选 + 带成功标准的版本 + 5 次独立成功尝试（→ `validated`、n=5、CI 0.5655–1）。
- `scripts/verify-review-host.mjs`（`npm run verify:review`，可传 `CANDIDATE_ID`）：
  读本机令牌 → 401/200 认证矩阵、越权 scope 404、详情与成熟度、`submit` → `in_review`、`approve` → `approved`、
  重复审核被拒（记录仍 2 条）、中文 reason 原样落库、`insufficient` 候选提交 400、`POST /execute` 404。
- 最近一次实跑：候选 `skc_aca14520-...`，`independent=5`、`validated`，reviewer `local_token:op_bbf306c3`；
  唯一的已知偏差是重复审核的状态码（残留实例返回 500，新构建映射为 409）。

## Stage 5 Phase 2 — 已知限制

- 操作者身份是「本机文件读权限」，不是自然人身份/角色权限；多用户部署前必须替换。
- 热重载残留实例下，状态机冲突返回 500 而非新构建的 409（`dist` 已含映射，需冷启动生效）。
- 统计是频数学二项口径：`partial_success` 按 0.5 折算，未做 Beta 后验。
- `user_reported` 只保留归因、不升为 direct，因此只有 user_reported 的候选停在 `observed`。

## Stage 6 — Visual Revision B（星图高亮风）

按反馈（参考一张密集星图式记忆网络）重做视觉层，只改表现，不动任何数据/布局/接口：

- 节点：经历改为更亮更小的冰白点；Episode 冷白大节点；Memory 薄荷绿、Pattern 暖琥珀，只用低饱和强调色区分类型。
- 泛光：节点用 `lighter` 叠加径向光晕，画面收尾再加一次 `blur(6px)` 自叠加泛光（Canvas2D 后处理，Chromium 支持）。
- 边：更细更亮的灰蓝线（`contains` 0.26 / 语义边 0.34–0.46）。
- 标签：默认显示更多节点标签（最多 120 个候选、按类型与 size 排序、碰撞才跳过），字号 10.5px，深色描边保证在光晕上可读。
- 背景：更纯的黑 + 中心一团冷色星云，云层与星点更暗，避免抢过节点。
- 相机：`fitCamera` 改为 `radius * 1.62`，让星群在首屏占比更大。

新增 prefix 路由 `/memory-sea/view`（与 `/memory-sea/scene` 同一页面）：热重载时旧实例会占住 exact 路由，prefix 变体保证新实例的页面立即可用；客户端半端 iframe 已改为指向它。

验收：`npm test` **194/194**；`docs/stage6-rev-b.png`（开发 scope，316 节点）、`docs/stage6-rev-b-rich.png`（`project_1b1a0fab281b0678`，2410 节点 / 2371 经历 / 23 片段 / 16 长期记忆，含绿色 Memory 节点）。
## Stage 6 — 交互修正（360° 旋转 + 惯性 + 自动恢复）

反馈：「页面无法 360° 旋转；划动一下停止后就不再转动」。定位到两处实现限制：

- 原来 `camera.pitch = Math.max(-1.35, Math.min(1.35, …))`，纵向被夹在 ±77°，永远转不到背面 → 改为 `wrapAngle()` 把角度折回 `[-π, π)`，横向与纵向都能连续转满 360°。
- 原来拖动结束只把 `autoRotate` 置 false，之后再也不会自己动 → 增加「甩动惯性 + 空闲恢复」：松手后按最后一帧角速度衰减（每帧 ×0.92，低于 4e-5 停止），空闲 1.3 秒后重新开始缓慢自转；`/`、`Esc`、滚轮、点击节点都不会破坏这个节奏。

「聚焦选中」的可发现性修正（同一轮反馈「点了没反应」）：

- 真正原因是**布局遮挡**：设置面板原来固定在右侧（`right:16px; z-index:6`），而节点详情面板占据右侧同一列且 `z-index:7` —— 打开详情后设置面板整块被压在下面，点任何按钮都点到详情上。现改为设置面板固定在**左上**（`left:16px; top:62px; z-index:8`，窄屏 `left/right:7px`），与右侧详情面板不再重叠。
- 聚焦本身加重了动画与反馈：点击「聚焦选中」会把相机在 520ms 内平滑推到选中节点（`easeInOutCubic`，距离收敛到不超过 160），并在状态条提示「已聚焦：<节点标签>」；**未选中时按钮为 disabled**，直接点会提示「先在星海里点选一个节点，再点聚焦选中」。
- 新增更直观的入口：**双击节点 = 选中并聚焦**，双击空白仍是复位；底部提示改为「单击节点看详情 · 双击节点聚焦 · 双击空白复位」。

验收（headless Chromium，`?debug=1` 才暴露只读相机状态）：316 个节点正常加载；纵向拖 838px（≈2π）后 pitch 未被夹住（再拖一圈仍继续回绕，说明可无限连续旋转）；横拖两圈 yaw 增量 ≈ 12.6–13.6 rad；停止操作后 1.3–3s 内 `autoRotate` 自动恢复 `true`；**0 console 错误**。回归：`npm test` **194/194**（新增三条断言：必须存在 `wrapAngle(`、必须存在 `RESUME_AUTO_ROTATE_MS`、不得再出现 `Math.max(-1.35, Math.min(1.35`）。

## Stage 6 — 设置栏重构（紧凑条 + 按需展开）

按反馈把页面顶部常驻的整排控件（品牌 + Scope + 搜索 + 四个类型开关 + 刷新/复位/聚焦 + 说明）改成「紧凑条 + 右上角设置面板」：

- 顶部条只保留：品牌标记、当前 Scope 徽标、Scope 数量提示、右侧 `⚙ 设置` 按钮；高度从 62px 降到 44px，中间视野让给星海。
- `#settings-panel` 默认 `hidden`（`aria-hidden` + `hidden` 属性），点按钮/按 `/` 展开，`Esc` 或点画布收起；面板内是 Scope 下拉、搜索框、四类节点开关（长期模式默认开启）、刷新数据/复位视角/聚焦选中三个按钮，以及一行「设置只影响本地视图，不改变任何记忆数据」。
- 搜索联动：过滤后顶部提示从「N 个 scope」变为「匹配 X / Y 个节点」，让过滤结果可核对。
- 键盘：`/` 展开并聚焦搜索，`Esc` 先收面板再取消选中，`R`/`F` 仍为复位/聚焦。

验收：`npm test` **194/194**（新增三条页面断言：面板存在且默认收起、搜索框不在顶部条内）；headless Chromium 实测 `hidden` 与 `aria-expanded` 状态切换正确、搜索「SQLite」得到「匹配 8 / 316 个节点」、深链接 `?select=<id>` 打开详情面板（正文 800 字）且 **0 console 错误**。截图：`docs/stage6-settings-collapsed.png`、`docs/stage6-settings-open.png`、`docs/stage6-settings-search.png`、`docs/stage6-settings-detail.png`。

## Stage 6 — 嵌入 DeepSeek 界面（客户端半端）

- 侧栏入口 `sidebar.panellist`（id `memory-sea`，order 2）+ 主面板 `main`（key `memory-sea`），渲染 `<iframe src="/memory-sea/scene">`，复用已验证的只读页面，不新增接口。
- 注册方式：`slots.inject("<slot>", () => slots.register(...))`；`package.json` 需 `exports["./package.json"]`、`exports["./client"]`、`dsh.client{platform,inject,immediately}`（缺一宿主静默跳过）。
- 验收（真实宿主）：`Slots.listSubTree` 显示 `memory-sea-view` 已注册 `sidebar.panellist` 与 `main` 两个座位且 `active: true`；`/memory-sea/scene` 200（57,986B）；`/api/memory-sea/scene?scope=…` 200（171,048B）。截图 `docs/stage6-embedded.png`。
- 限制：宿主升级可能变更 client 契约；iframe 内页面不共享宿主主题变量；客户端半端改动必须完整重启宿主。
## Stage 6 — 3D Memory Sea 页面（只读投影）

- **三个只读缺口补齐**（`src/index.ts`）：
  - `GET /api/memory-sea/{scene,legacy-scene,status,health}?scope=` —— scope 先经 `knownScopes()` 校验，未知 scope 一律
    `404 {ok:false,error:'unknown scope'}`，不静默回落默认 scope。
  - `GET /api/memory-sea/experiences/<id>?scope=` —— Experience 原文 + 所属 Episode（跨 scope 读回 404）。
  - `GET /api/memory-sea/episodes/<id>?scope=` —— Episode + 成员经历预览（`preview(content, 240)`，不复制全文）
    + 证据 Memory 链 + 连续性视图；原 `/episodes/<id>/continuity` 保留。
- **页面**：`GET /memory-sea/scene`（回退 `/api/memory-sea/ui`），由 `src/web/scene-page.ts` 把
  `src/web/client/scene.css` 与 `scene-app.js` 内联成单文件 HTML（约 36KB，无 CDN、无外部请求）。
  3D 采用 **Canvas2D + 手写 yaw/pitch 旋转 + 透视投影 + 深度排序**（方案 A），不引入 three.js；
  支持拖拽旋转、滚轮缩放、双击复位、`R`/`F`/`Esc`、单击选中、文本搜索、四类节点过滤、Scope 下拉。
- **节点与颜色**：Experience 小点（按 sourceType 区分）、Episode 中球（带 experienceCount 外环）、
  Memory 大球（importance/confidence/reinforcement 决定大小，clamp）、Pattern 核心球。
  边按 `contains / derived_from / supports / supported_by / contradicted_by / continues / followup / same_thread / same_topic`
  分色分线型，详情面板会显示每条边的 `reason`。
- **数据真实性**：位置来自 `scene-builder` 的稳定伪随机布局（同一数据两次生成 JSON 完全一致）；
  `contains` 来自 `episode_experiences`，证据边来自 `memory_evidence`，连续性边来自 `episode_relations`；
  默认 scope 的 `memories=0` 是真实结果（4 个 Episode 全是工具日志，`RuleBasedConsolidator` 按设计 `no_op`），
  页面显示 0 而不是编造记忆。
- **验收取证**：
  - 单元/集成：`tests/scene-web.test.ts` 11 例（映射、校验、确定性、scope 隔离与未知 404、Experience/Episode 详情、
    跨 scope 404、空数据、页面自包含且无写请求、详情预览 ≤240 字硬上限）；全量 **193/193** 通过。
  - 真实宿主：`node scripts/verify-stage6.mjs --port <端口>`，页面 200/text/html/自包含、316 节点结构合法、
    Experience 详情 200、跨 scope 404、旧连续性路由可用、审核入口 401 全部通过。
  - 交互（headless Chromium 实测）：点击画布节点 → 右侧面板显示真实 Experience 全文与「所属经历片段」chip；
    拖拽旋转 + 滚轮缩放后相机位置变化；无 console 错误。
  - 截图：`docs/stage6-scene.png`（首屏）、`docs/stage6-scene-selected.png`（选中 + 详情面板）、
    `docs/stage6-scene-rotated.png`（旋转缩放后）。真实宿主数据：312 Experience + 4 Episode + 312 `contains` 边。
- **已知限制**：
  - 宿主热重载不 dispose 旧实例，`/scene`、`/status` 等 exact 路由仍可能由旧实例先响应
    （表现：scene 无 `scopeId`、`contains` 边无 `reason`、`/episodes/<id>` 404），需完整重启 DeepSeek 后复验。
  - 节点 label 直接取自 `Event/Episode.title/summary`，工具日志型 Episode 的标签可读性差（数据质量问题，非页面 bug）。
  - Canvas2D 投影在几千节点内可交互；更大规模需要分页/LOD/WebGL，本阶段不做。
  - 页面只读：没有编辑、删除、打标或 Skill 审核入口。

# In Progress

- 无（Stage 7 闭环：206/206 测试、`npm run verify:stage7` → `VERIFY STAGE 7 DONE` 32 项全过；全景页面已用 headless Chromium 实测模式切换/Scope 过滤/详情/零 console 错误并截图。真机 GUI 需完整重启一次 DeepSeek 才能看到最新前端（服务端会内联最新 CSS/JS，旧实例仍占住已注册路由）。）

# Next

- 完整重启 DeepSeek 后复跑 `node scripts/verify-stage6.mjs --port <端口>`，确认 exact 路由全部来自 Stage 6 实例
  （scene 带 `scopeId`、`contains` 边带 `reason`、`/episodes/<id>` 200），并重拍 `docs/stage6-scene.png`。
- Stage 7 候选（**未开始、需批准**）：只做可视化增强（WebGL/LOD、时间轴回放、证据链高亮），
  或补真实 embedding endpoint；不涉及 Skill 执行。
- Stage 4.5 之后仍挂起的后移项：高质量中文分词与 IDF、多实例分布式锁、目录 rename 的 scope 迁移、工具/代码型摘要质量。

# Decisions

1. **存储用 Node 24 内置 `node:sqlite`**（`DatabaseSync`）：运行时零依赖，同步 API 适配 capture 快路径。
2. **FTS 是可选迁移**：FTS5 不可用时降级 LIKE，绝不让插件启动失败。
3. **中文切词放在 JS（bigram）**：`unicode61` 不切中文；索引写入时由 Repository 生成，避免 SQL 触发器。
4. **Experience 不可变性在 API 层封死**：Repository 没有 updateContent；重复 id 返回 `deduplicated=true`。
5. **一个 Experience 只能属于一个 Episode**：`episode_experiences.UNIQUE(experience_id)` + 重新归属先 detach。
6. **Episode 归属是确定性规则**：不做聚类，可解释、可测试、无模型依赖。
7. **Scene 坐标由 ID 稳定伪随机生成**：刷新不跳动，不引入 UMAP。
8. **Scene 保留双格式**：内部 `MemorySeaScene` + `toLegacyScene()`，前端不重写。
9. **所有捕获失败不冒泡**：`session/event` 监听器内 try/catch，Memory Sea 挂掉不影响宿主。
10. **工具只注册 3 个**。
11. **Episode 标题由确定性规则挑**：来源优先级（chat > diary > manual > file/web > tool）+ 排除结构化回执 + 过滤宿主注入的运行上下文行；旧标题不回写。
12. **Stage 2 用单键 `scope_id` 替换 Stage 1 的 `(scope_type, scope_id)` 复合键**：scope 身份由规范化路径哈希决定，天然唯一；旧数据用 `project_legacy` + `scope_root` 回填，迁移可重放。
13. **scope id 用规范化绝对路径的 sha256 前缀**：Windows 下大小写/分隔符/末尾斜杠不影响结果，同一目录永远同一 id；不用随机 UUID（否则重装即失忆）。
14. **Episode 关闭原因枚举化**（idle_timeout / session_end / manual / startup_recovery / topic_shift），`topic_shift` 只留类型不实现。
15. **后台任务是持久化队列，不是内存定时器**：崩溃后靠 `memory_jobs` + `reclaimStale` + `backfillJobs` 恢复；内存定时器只负责「催」队列。
16. **attempts 在 claim 时 +1**：崩溃也算一次尝试，避免毒任务无限重试。
17. **embedding provider 只按配置判定可用性，启动不探测网络**：宿主启动不能因为外部服务慢而卡住。
18. **embedding 表按 (provider, model) 版本化**：换模型不覆盖旧向量，`content_hash` 支持增量重算。
19. **语义通道的 available 是 getter（晚绑定）**：无真实向量前自动降级，不报错。
20. **摘要失败不影响 Episode**：`summary_status='failed'`，Episode 照常关闭，原文与 Scene 不受影响。
21. **LLM 摘要必须能回退**：任何异常都用抽取式摘要兜底，插件不因外部 LLM 故障而失败。
22. **配置同时接受 spec §44/§45 命名与早期命名**：`background.*` / `episode.*` 与 `jobs.*` / `capture.episodeIdleMs` 都可用，前者优先。
23. **`close()` 异步 + `closeSync()` 同步**：Node 测试的 `finally` 无法 await，而 Windows 上库未关会导致临时目录 `EPERM`；生产走 `close()`（等队列空闲再关库）。
24. **插件已在 desktop profile 安装并 live**：改完代码 `npm run build` + `set_bundle enabled=false/true` 热替换。
25. **历史 scope_id 一律按 `scope_root` 重算，不保留旧 id**：Stage 1 的 `p_xxxx` 是随机短哈希，跨重装不稳定；只有路径哈希才能让「同一目录永远同一 scope」成立，因此迁移把非规范 id 全部视为 legacy 并重算（幂等，可重复执行）。
26. **启动维护要枚举「库里的 scope」而不是「会话见过的 scope」**：否则宿主重启后（还没有任何 session/event）历史 open Episode 永远不会被收割，pending 任务也不会补排。
27. **FTS 分数按查询内相对饱和映射**：`bm25()` 的绝对量纲随语料规模变化，不能用固定 `strength/(strength+2)`；改用「本次最强命中=1、其它 0.35–1」。
28. **已完成/永久失败的后台任务允许重新入队**：摘要与向量是可重算的派生数据，换了 summarizer 或补上 embedding provider 之后必须能重跑；`UNIQUE(type,owner_type,owner_id)` 冲突时，只有 `completed`/`failed` 会重置回 pending，`pending`/`running` 保持原样（幂等）。
29. **摘要与派生字段只取「人写的经历」**：`narrativeExperiences()` 优先 chat/manual/diary/web 且排除结构化回执、工具输出、路径堆；工具结果仍然被完整捕获、可检索、可追溯，只是不进摘要与参与者抽取。
30. **抽取式摘要是「可用基线」而不是「好摘要」**：工具/代码密集的 Agent 会话里，抽取式只能挑到代码行与路径（见 Known Issues）；要真正可读的摘要必须配置 `summary.provider=llm`（`LlmEpisodeSummarizer` 已实现，失败自动回退抽取式）。

31. **Evidence before inference**：Memory 必须有 evidence（`memory_evidence` 关系表，PK 去重），applier 在证据为空时直接 skip；不存在「无来源的知识」。
32. **Memory.content 可变、Experience.content 不可变**：前者是派生结论（可被 update/取代），后者是原始证据（Repository 层就没有更新接口）。
33. **整理批处理整体事务化**：create + evidence + relation + 状态更新在同一 `db.transaction()` 内，单条操作失败只 skip，不产生半完成知识。
34. **reinforce 幂等靠证据唯一键**：`insertMany()` 返回 0 说明该 Episode 早就支持过这条知识 → 直接 skip，不累加计数（这是「同一 Episode 整理 N 次结果一致」的实现基础）。
35. **同批次同一条知识最多强化一次**：Episode 标题与摘要常说的是同一件事，否则一次整理会把 `reinforcement_count` 刷两次。
36. **supersede 必须先立后废**：先建新知识、写证据，再 `markSuperseded()`；旧知识作为 `memory/supersedes` 证据保留，历史永远可回答。
37. **冲突不猜新旧**：无法判断时只记 `contradicts` 并降置信度，绝不自动 supersede。
38. **Memory id 用随机 UUID，不用内容哈希**：同一句话在不同时间可以合法地成为不同知识；去重交给 normalized 相等 + 相似度检索 + 证据唯一键。
39. **归一化只做机械变换**（trim/空白/标点/小写），不调 LLM 改写做唯一键 —— 否则等于让模型决定「什么算同一件事」。
40. **Candidate Discovery 不依赖 embedding**：FTS + topics + bigram + 时间就足够找到相关 Episode/Memory；embedding 只是增强项，缺了不影响正确性。
41. **领域词典兜底关联**（storage/graph/vector/model/prompt/memory/harness）：措辞差异很大但同一领域的旧结论（SQLite → PostgreSQL）也能被 supersede/reinforce 找到，否则旧知识永远 active。
42. **被标题截断的半句不进知识**：标题经 `trimTitle` 截断后以「…」结尾，候选阶段直接丢弃；有 summary 时优先用 summary。
43. **整理任务复用 Stage 2 的持久化队列**：`episode_consolidation` / `memory_embedding` 都是 `memory_jobs` 的 job 类型，崩溃后由 `backfillJobs()` 补排，不自建第二套调度。
44. **Memory 召回带 boost 但不改可解释性**：`memoryBoost` 只作用于最终 score（clamp ≤2），reasons 里保留原始 confidence/importance/reinforcement 数值。
45. **Scene 里 Memory 尺寸必须 clamp**：`3.2–7.5`，由 importance+confidence+reinforcement 决定上限，避免知识被反复强化后把 3D 场景撑爆。
46. **Pattern 先从 Evidence 长出来，不先造描述**：没有 ≥2 个独立 Semantic Memory 支持，`PatternApplier` 直接 skip，宁可不产出 Pattern 也不产出「一条知识总结出的模式」。
47. **Pattern 是描述性的，不是可执行的**：类型与文档明确 `Pattern is descriptive. Skill is executable.`，Stage 4 不出现 `execute/runSkill/autoToolCall/policyApply`；Pattern 只回答「这个项目长期倾向什么」，不回答「下次该怎么做」。
48. **规则式分析器用「概念层」而不是文本相似**：`PATTERN_CONCEPTS` 把 `SQLite/单进程/不加缓存` 抽象成 `avoid_infra_complexity`，否则文本相似会把「同一句话换个说法」当成模式，而把真正结构相同的决策漏掉（spec §15 的核心难点）。
49. **证据不足一律 no-op**：规则式分析器在概念支持者 < `max(2,minSupport)` 时返回 `noop`；这是「宁可沉默」的取舍，避免 fallback 模式制造虚假洞察。
50. **Weaken 与 Supersede 分开**：一次反证只降置信度、计矛盾数（`weaken`）；只有「明确长期趋势改变 + 新模式有 ≥2 支持」才 `supersede`，且先立后废。
51. **Pattern 幂等靠证据唯一键**：`pattern_evidence` 主键 `(pattern_id, memory_id, relation)`，`insertMany` 返回真实新增数，返回 0 就 skip，`supportCount` 不会因重复分析虚增。
52. **Batch 内 `touched` 去重**：同一次分析对同一 Pattern 的 reinforce/weaken 只生效一次（沿用 Stage 3 `touched` 思路）。
53. **Pattern 召回必须受 query intent 约束**：`PATTERN_INTENT_TOKENS` 命中才 ×1.3，否则「为什么没上 Neo4j」会被抽象模式压过具体知识 —— 模式是背景，不是答案。
54. **Pattern 场景位置取支持 Memory 的质心**：模式在空间上「长在支持它的知识中间」，不随机落点；没有支持时才退回稳定伪随机球面，保证刷新不跳动。
55. **Pattern 尺寸必须 clamp（4–9）**：`supportCount` 增加不该无限放大节点，否则几百条证据会把 3D 场景压垮。
56. **stale 与 supersede 严格分离**：久未强化只是「旧了」（`stale`，可复核后恢复），只有明确新证据才 `superseded`；这样「以前为什么这么决定」永远可回答。
57. **review 只在后台 job 里做**，且本阶段只支持 `keep / mark_stale`，不重复实现 Consolidation 的判断逻辑。
58. **向量通道的 owner 白名单必须包含 memory/pattern**：Stage 3/4 的真实 bug 就是 `semantic-recall.ts` 与 `embedding-repository.ts` 里写死的 `['experience','episode']`，导致语义通道对 Memory/Pattern 完全失效；现在四类 owner 统一。
59. **真实 embedding 验证用本地 OpenAI-compatible stub 而非伪造 provider**：脚本起真实 HTTP `/embeddings`，走真实 `OpenAiCompatibleEmbeddingProvider` + 真实 BLOB 存储 + 真实 cosine，验证的是通道而不是 mock。
60. **上下文召回不改写 query**：weak query 只触发「按 actor/时间/重要性取候选」，绝不把「主播好」改写成「他想聊复试」——改写会让召回不可解释，也会把猜测写进证据链。
61. **上下文召回只在 `querySignal === 'weak'` 时生效**：normal 查询的 `signals.lexical` 取 `max(lexical, contextual)`，而 normal 时 contextual 恒 0，所以具体问题的排序与 Stage 4 完全一致。
62. **actor 上下文不是跨 scope 的通行证**：`context.actorId` 只在已解析的 `scope_id` 内过滤，scope 仍是唯一查询主键；无 actor 时宁可 0 命中也不随机召回。
63. **Episode 碎片的解法是 Link 不是 Merge**：`episode_relations` 只新增关系，Episode 的 summary/title/Experience 一律不回写——合并会破坏 Evidence ID、时间结构与 Consolidation 证据。
64. **关系不是证据**：`episode_relations` 与 `memory_evidence` 两张表互不写入；连续性只影响「召回展开」和「inspect 展示」，不影响知识生命周期。
65. **连续性方向固定 source=较早 / target=较晚**：`previous/next` 由方向推导，避免双向存储带来的重复与歧义；`PRIMARY KEY(source,target,relation)` 天然幂等。
66. **连续性阈值偏保守**：同参与者但话题不同最多 `same_thread`，只有「同参与者 + 实质关联 + 7 天内（或计划接续）」才 `continues`；宁可少连，也不要把 Scene 画成毛球（实测 4 Episode / 3 relations）。
67. **规则式连续性分析器优先，LLM 版后置**：先有确定性候选与可解释 reason，再考虑接 LLM；本阶段按 spec 不写 LLM continuity analyzer。
68. **`inject` 必须显式声明 `webServer`**：Cordis 里 `ctx.get('webServer')` 在未注入时拿不到服务，会静默丢掉所有路由（宿主兜底 401）；这是 Stage 4.5 在真实宿主上暴露并修掉的部署级 bug。

## Stage 4 — 直播场景带回的一条知识门槛修正

- 直播验收（`dsh-plugin-live-agent`）发现：用户说「我下周要复试，专业课差不多了」这种**第一人称个人计划**
  没有「决定/目标/结论」字眼，RuleBasedConsolidator 判定为不可立知识，导致「回访观众」场景没有任何可召回内容。
- 修正（`src/memory/memory-lifecycle.ts`）：`hasDecisionWording()` 在原有 DECISION_PATTERNS 之外，
  接受长度 >= 10 的第一人称计划表达（`我下周/我这周/我明天/我下个月/我要/我准备/我打算/我叫/我最近`）。
- 回归测试：`tests/personal-plan.test.ts`（个人计划无决定字眼 → 形成 goal/active 知识）。
- 取舍：这类表达进入「明确决定」通道意味着单条 Episode 即可立知识；用最小长度 + 第一人称双重限制压住噪声，
  直播侧仍由 importance 分级（`defaultImportance 0.15`）与 Memory Sea 的置信度门槛把关。

## Stage 4.6 — 摘要质量与身份收敛（Decisions 69–75）

69. **行级过滤，而不是整段过滤**
    原因：工具输出与说明文字经常混在同一段里；整段判定只能二选一，行级过滤才能「剔除日志、留下结论」。
70. **质量评级读时计算，不加数据库列**
    原因：质量是派生判断，规则会调整；先不加列，避免每次调阈值都写迁移。低质量重排走既有的 `episode_summary` 任务。
71. **没有可靠人话就明确回退，不编造摘要**
    原因：编造的低质量摘要会进入 Consolidation 与 Pattern，污染比空摘要严重得多。
72. **`machine_dominated` 只看摘要本身**
    原因：输入里工具多不代表摘要差（人话可能只有一句但很关键）；用输入比例会让「一句结论 + 大段日志」被误判。
73. **身份规范化放在 Live Agent，Memory Sea 只消费通用字段**
    原因：平台身份是领域知识；Memory Sea 只认 `actorId/threadKey/sessionId/scopeId`，否则内核会被直播概念污染。
74. **`actorId` 用「平台 + 平台用户 ID」哈希，昵称不参与**
    原因：昵称可变且可重名；只有平台级稳定 ID 才能跨 Session 稳定、又不误合并同名用户。
75. **弱身份（只有 `viewerId`）不升级为强身份**
    原因：`vwr_` 是插件内部不透明 ID，不能证明与历史记录同源；宁可少连一条，也不要连错一条。

76. **Skill 候选是描述，不是能力**
    原因：Phase 1 的目标是让「重复模式」变成可证伪的描述；一旦允许执行，Pattern 就会变成 Policy，
    而 Pattern 的正确性目前只有「多个 Memory 支持」，远不足以驱动行为。
77. **一个 Pattern 只派生一个候选**
    原因：`(scope_id, source_pattern_id)` 唯一约束把「同一模式的多次发现」收敛到一条候选上，
    否则每次 Pattern 分析都会制造一条新候选，审核队列会爆炸。
78. **版本只追加，不覆盖**
    原因：审核要能回看「当时批准的是哪一版」；覆盖写会让审核记录失去指向对象，
    也无法判断批准后规则是否被悄悄改过。
79. **没有预先成功标准就降级为 inconclusive**
    原因：`success` 是判断，不是事实；没有事先可核对的成功标准时，任何「成功」都是事后叙事。
80. **审核与执行彻底分离**
    原因：批准只表示「接受这份描述」，不代表「以后自动照做」；Phase 1 的 `SkillService`
    因此不暴露任何 `execute/run/invoke/apply` 入口，并用测试固化这一点。
81. **成熟度是派生计算，不落权威字段**
    原因：缓存成熟度会与 Attempt / Outcome / 版本漂移；每次按当前证据重算是唯一不会撒谎的方式。
82. **审核入口先只做 Service 方法，不注册成 Agent 工具**
    原因：Agent 不应能自行批准自己的候选；真实操作者入口属于 Phase 2，本轮明确记录为未交付。
83. **Recall / Scene 不引入 Skill 候选**
    原因：候选的定位是「待验证的描述」；把它混进召回会让用户误以为系统已经会做某件事。


84. **成功率用 Wilson 区间，而不是 Wald**
    原因：n 很小时 Wald 会给出负下界、在 0/1 附近塌缩；早期候选恰恰都是小样本。
85. **独立单位是 Attempt，不是证据条目**
    原因：一次尝试可附带多条证据；按证据计数，重复记录就能刷高「验证次数」。
86. **同一 Episode 的多条 Experience / Memory 折叠成一个样本**
    原因：同一段经历派生的多条知识不是多次独立验证，计数会虚高。
87. **两次成功不再等于 validated**
    原因：小样本 100% 成功率几乎没有信息量；门槛提到 5 个独立样本 + 至少 1 次 direct。
88. **审核身份来自本机令牌文件，而不是请求体**
    原因：宿主没有可信身份时，请求体里的 reviewer 就是自证；令牌至少要求能读本机文件，并且失败关闭。
89. **批准与验证彻底分开**
    原因：批准是「接受描述」，验证是「观察到效果」；混在一起会让审核变成免罪的执行许可。
90. **编辑产生新版本，且新版本不继承旧批准**
    原因：Attempt 绑定具体版本；否则改两行字就能把未验证的东西变成已验证。
91. **来源变化只标记 + 入队，不改历史**
    原因：历史版本与审核记录是审计对象；来源漂移通过 `provenance_changed` 与重新评估体现。
92. **3D 渲染用 Canvas2D + 手写投影，不引入 three.js**
    原因：插件运行时零依赖是既有约束；legacy 前端已证明这套投影能满足旋转/缩放/深度排序，
    而引入 three.js 会让插件体积和构建复杂度显著上升，收益（光照/后处理）在本阶段不需要。
93. **页面 HTML/CSS/JS 内联成单文件，由 `webServer` handler 直接返回**
    原因：宿主 `webServer.register` 只有 handler、没有静态文件托管；内联既避免额外静态服务，
    也避免「另起常驻进程」与端口写死的问题（页面用同源相对路径请求 API）。
94. **未知 scope 一律 404，不回落到默认 scope**
    原因：静默回落会让用户以为自己在看 A 项目的星海，实际是 B 项目的数据——这比报错危险得多。
95. **详情接口只给预览（≤240 字），全文按需单节点读取**
    原因：312 个 Experience 的全文一次性塞进 Scene 会让响应体与首屏都失控；Scene 负责「形状」，详情负责「原文」。
96. **Scene 的每条边都必须带可读 `reason`，包括 `contains`**
    原因：Stage 3 起「可解释」就是硬约束；页面要能回答「为什么这两个节点连着」，
    所以 `contains` 也补上了「这段经历归属于该段连续经历」，并由 `validateScene` 与测试双重校验。

# Known Issues

- Stage 4.6：真实库里 730 条 Agent 会话经历没有参与者元数据（`missing`），无法回填也不应猜测。
- Stage 4.6：摘要质量是规则评分，不判断语义是否空洞；`fair` 与 `good` 的边界依赖阈值，改阈值需重跑 `verify-stage46`。
- Stage 4.6：`identityConfidence` 只由 Live Agent 新写入产生；历史 `actorId` 已回填但没有置信度字段。

- Stage 5 Phase 2：操作者身份是「本机令牌」，能读文件的人即可审核；不是自然人身份，也不是角色权限。
- Stage 5 Phase 2：热重载残留实例下，状态机冲突返回 500 而不是 409（`dist` 已实现映射，需冷启动生效）。
- Stage 5 Phase 2：`partial_success` 按 0.5 折算成功，`inconclusive/unknown` 不进分母（保守的频数学口径）。

- Stage 6：宿主热重载不 dispose 旧实例，`/scene`、`/status` 等 exact 路由可能仍由旧实例响应
  （scene 缺 `scopeId`、`contains` 边缺 `reason`、`/episodes/<id>` 404）；需要完整重启后复验。
- Stage 6：节点标签直接来自 `Episode.title/summary` 与 Experience 截断文本，工具日志型会话的标签可读性差。
- Stage 6：Canvas2D 投影适合几千节点；更大规模需要 LOD/分页或 WebGL，本阶段不做。
- Stage 5 Phase 2：Attempt 没有 HTTP 写入口（刻意），真实宿主审核演示需先用脚本写入尝试数据。

- **中文 FTS 召回 precision 一般**：bigram + OR 查询偏召回；后续可加短语加权与 IDF。
- **旧前端主题配色退化**：未移植 legacy TOPIC_KEYWORDS/SECTOR，`topic` 现在是 `experience|episode`；旧 UI 分簇名会显示为「未归属经历」等。
- **Episode summary 是抽取式**：不接 LLM 时是「挑句子」而非真摘要；接 LLM 需配置 endpoint+model。
- **工具/代码密集的 Agent 会话摘要质量差**：子代理会话里大量 Experience 是 grep/编译输出与代码块，抽取式摘要会挑到 `134: private refreshDerived(...)`、`C:/.../src/x.ts` 这类行（已过滤一部分，但无法根治）。这是「没有 LLM」的固有限制：宿主实测 4 个 closed Episode 中，聊天型会话摘要可读（`今天研究 Memory Sea。决定 V0.2 先用 SQLite。Neo4j 后面再上。`），代码型会话摘要仍偏噪声。验收口径是**链路正确**（closed → job → ready），摘要可读性依赖 `summary.provider=llm`。
- **真实 embedding 已用本地 OpenAI-compatible stub 验收（Stage 4）**：`scripts/verify-stage4.mjs` 起真实 HTTP `/embeddings`，`embedding.provider=openai-compatible` 下 `为什么没有直接采用图数据库？` 命中 `决定暂时不上 Neo4j。` 并带 `semantic` 理由；宿主进程内尚未配置真实 endpoint（需要在宿主环境变量里给 `DSH_MEMORY_SEA_EMBEDDING_*` 后重启）。
- **Memory 内容仍是 Episode 原句**：规则式整理产出的是 Episode 里的句子（例如「决定 Memory Sea V0.2 先用 SQLite 存记忆。」），不是凝练总结；要更凝练需要 `consolidation.provider=llm`。
- **规则式整理一条事实一条知识**：一段对话里的多个决定会形成多条 Memory（verify 脚本里 E1 就产出 decision + preference 两条），粒度比 LLM 整理粗，但符合「一条知识一个事实」。
- **中文语义相似度仍是 bigram**：`bestMemoryMatch` 用 bigram + 关键词重合，措辞差异大时必须依赖领域词典兜底（已覆盖常见技术词，未覆盖全部领域）。
- **Memory/Pattern embedding 只在脚本内验收**：宿主的 embedding 仍是 `noop`（未配置 endpoint），因此宿主里 memory/pattern 走 lexical + importance/confidence/support 通道。
- **scope 的 global 类型只预留**：不做跨项目召回。
- **单进程假设**：`node:sqlite` 同步 API + WAL；同库多进程并发写可能 `SQLITE_BUSY`（`busy_timeout=5000` 兜底）。
- **`getLegacyScene` 的 Episode text 仍是 label**：`full` 已给 summary，但旧前端列表视图只显示 text。
- **日志没有独立的 debug 级别**：`scope resolved` 等结构化日志走 `info`，宿主日志量大时略啰嗦（只含 id/count/reason，不含聊天原文）。
- **维护定时器用 setInterval**：`unref` 后随进程存活；进程挂起时不会补跑，靠重启的 `startupMaintenance()` 兜底。
- **热替换会残留旧插件实例**：`set_bundle enabled=false→true` 后，旧实例的 HTTP 路由仍可能先匹配（现象：`/status` 是旧 JSON，`/health` 是新 JSON，双实例同一 DB）。彻底清掉需要重启宿主；不影响新实例的功能与数据正确性。
- **无 embedding 时纯语义改写召回为 0**：没有向量通道时，`"为什么没直接用图数据库？"` 这类与原文没有关键词交集的 query 返回空（不是报错）。这是 lexical-only 的固有限制；Stage 4 已证明配上 provider 后同一 query 可命中（见上）。
- **规则式 Pattern 只有 6 个概念**：其它主题会 no-op；扩概念词典或接 `pattern.provider=llm` 才能覆盖更多领域。
- **Pattern 分析按 Memory 逐个触发**：同一批知识会重复做候选发现（幂等保证不重复计数，但多花几次 DB 查询）。
- **上下文召回依赖 actor 元数据**：只有 Experience `metadata` 里带 `actorId`（Live Agent 会带 `viewerId/platformUserId`）时，weak query 才有候选；纯宿主聊天会话没有 actor，`主播好` 这类输入仍是 0 命中（这是刻意的：宁可空，也不随机召回）。
- **连续性分析器只认「同参与者 + 话题/计划接续」**：没有共享词的两段经历不会连上；真实宿主旧 Episode 标题混有英文/路径词，reason 里会出现 `shared topic current/the` 这类噪声。
- **Scene 只渲染 `continues/followup`**：`same_thread/same_topic` 关系存在但不画，避免图变成毛球；需要时可在前端按需打开。
- **`014` 迁移会给已有 episodes 加 `continuity_status='pending'`**：升级后首次启动会补排一批 `episode_continuity` job（宿主实测 pending 23 → 逐步消费），属于预期行为。
- Stage 5 Phase 1：**真实操作者审核入口尚未交付**。审核目前只能通过受控脚本 / 测试调用
  `SkillService.review()`，没有 Agent 工具、也没有写操作 HTTP；这是刻意的暴露面控制，但在 Phase 2 之前
  无法在正常使用流程里批准候选。
- Stage 5 Phase 1：候选步骤直接取自支持 Memory 的首句，可读但粗糙；人工编辑步骤要等审核入口一起交付。
- Stage 5 Phase 1：`ready_for_review` 之后的重算依赖 `skill_candidate_reevaluate` 任务手动/后台触发，
  没有事件驱动的即时重算（成熟度查询本身是实时的，不会显示旧结果）。
- Stage 5 Phase 1：`/api/memory-sea/status` 仍可能被热替换前的旧实例响应（缺 `skills` 字段）；
  新 prefix 路由正常，需要完整重启宿主才能统一。


## Stage 6 — Visual Revision A（深空摄影风）

- 用户选择 A：深空摄影风。当前视觉以近黑深空、低饱和蓝灰尘埃带、稀疏冷白星点为主；移除第一轮高饱和紫色星云和发光丝带。
- `src/web/client/scene-app.js`：背景缓存为独立 Canvas；920 个确定性星点；降低节点光晕和关系边亮度；Episode 轨道环变细；默认不绘制星芒；标签采用优先级与碰撞规避；自动旋转速度降低。
- `src/web/client/scene.css`：降低玻璃面板、渐变、边框高亮和投影的存在感。
- `src/web/scene-page.ts`、`src/web/scene-page-data.ts`：统一主题色与关系色。
- `tests/scene-web.test.ts`：更新视觉契约断言。
- 数据模型、migration 001–017、Scene 坐标、Scope 隔离和只读接口均未改变；无第三方运行时依赖、外链或写请求。
- 当前执行环境没有安装 `@types/node`，`npm ci` 网络请求超时，因此本轮未能完成 `npm run build`。使用已有 dist 与本轮资源执行全量 Node 测试：194/194 通过；`scene-app.js` 通过 `node --check`。Windows 环境仍需执行标准构建与 Stage 6 真机验收。

## Stage 7 — All Scopes 全景视图（后端聚合 + 双模式）

**目标**：默认打开就是「全景」——所有已知 Scope 的真实 Experience / Episode / Memory / Pattern 画在同一片星海里；需要深挖某项目时切「单 Scope」。

**后端**
- 新 `src/scene/global-scene.ts`：`buildGlobalScene(sources, {failures, now})` 纯函数聚合各 scope 的真实 `MemorySeaScene`。节点全局 id = `<scopeId>::<原始 id>`（`originalId` 一并返回）；边只在本 scope 内部按 `localIdMap` 重映射端点，端点缺失的边直接丢弃 —— **不存在跨 scope 边**（也不允许因为文本相似/同一个人自动连）。
- `MemorySeaService.getGlobalScene(options)`：`knownScopes()` 取全部 scope，逐 scope `sceneBuilder.build()`；未知 scope / 构建失败都进 `failures[]`，`complete=false`，已读到的数据保留。
- 新只读路由 `GET /api/memory-sea/global-scene?scopes=a,b`；新页面 `GET /memory-sea/atlas`（热重载期间由新实例提供，避免旧实例占住 `/memory-sea/scene`）。
- 类型：`GlobalScenePoint/GlobalSceneEdge/GlobalSceneScopeSummary/GlobalSceneStats/GlobalSceneFailure/GlobalScene`。

**前端**
- `#topbar` 增模式切换（`#mode-global` 默认 on / `#mode-scope`）；`scenePath()` 按模式切 `/global-scene` 与 `/scene?scope=`。
- 全景空间分离：每个 scope 先按自身包围球压缩到相近体量，再放到薄球壳上（黄金角分布），并在聚类中心标 `scope` 短 id —— 坐标只在视图层平移/缩放，**不改后端数据、不合并 scope**。
- Scope 多选过滤（`#scope-filter` 复选框，全不勾=全部）、四类类型过滤带实时计数（`#count-*`）、统计条 `节点/边/Scope`、状态条显示「X 个节点 / Y 条边 · N 个 Scope」，失败 scope 标红提示「数据不完整」。
- 详情面板两种模式共用：按节点自身 `scopeId` + `originalId` 请求真实详情接口；面板内 chip 上的原始 id 会经 `resolveRef()` 映射回命名空间 id 再选中。

**测试**：`tests/stage7.test.ts` 12 例（多 scope 聚合、命名空间唯一、同 id 跨 scope 不合并、边端点同 scope、无跨 scope 边、单 scope 不回归、空 scope、未知 scope 显式失败、详情按 scope、确定性、悬空边丢弃、页面自检）；`scripts/verify-stage7.mjs` 32 项真实宿主检查（`npm run verify:stage7`）。

**Decisions 97–101**：全景用命名空间 id 而不是重编号；只画本 scope 内的真实边；失败必须显式（`complete=false`）；页面用 `/memory-sea/atlas` 绕过热重载占位；只读校验用「POST 前后数据不变」而不是依赖 405（宿主 webServer 不区分方法）。

**Known Issues**：单 scope 的 Scene 会因 `maxPoints` 裁剪产生悬空边，全景丢弃后边数 ≤ 单 scope 边数（不是丢数据）；11 个 scope 里三个 live 观众 scope 节点很少，视觉上偏小、属真实数据；全景下 Experience 点被压缩到 0.08–1 倍，密集 scope 仍需切单 scope 看细节。

## Stage 7.1 — 全景关系线可见性修复

**现象**：全景模式节点都在，但关系线几乎看不见；底部显示「关系 19」。

**诊断（`scripts/diagnose-global-edges.mjs`，只读）**

| 层级 | 结果 |
|---|---|
| 单 scope Scene 边合计 | 3151（contains 3045 / derived_from 67 / continues 19 / supported_by 20） |
| 全景聚合后 | 3144 条（合并 7 条重复的 `derived_from` 真实边，其余不丢） |
| 端点匹配 | 3144 / 3144 全部匹配，缺失 0、跨 scope 0、缺 reason 0 |
| 前端投影 | 每个 scope 自己的布局里所有边都被绘制 |

结论：**边没有丢**，问题在统计口径、视图层和取景三处。

**第一轮：数据与视图结构**
1. **统计口径**：`SceneStats.relations` 只统计 Episode 连续性（19），不含 `derived_from`/`supported_by`。现在聚合时按真实非 contains 边计数（真实值 101），每个 scope summary 也带 `relations`。
2. **全叠在一个原点**：11 个 scope 原本共用同一片坐标，节点叠成毛球。现在每个 scope 的布局先压缩到相近体量，再放到薄球壳上（只动视图坐标，后端坐标不变），聚类中心标 scope 短 id。
3. **相机对着空场**：球壳中心是空的，放大只会钻进空白。改成按「最远的真实节点」取景并让 content 铺满视口。

**第二轮：可读性（本轮补齐）**
- 取景改为 `distance = 1.7 × 最远节点半径`（投影 `focal = min(w,h)*1.12`，可见半高约 `0.446*distance`），全景一屏能看到全部 11 个 scope，聚类足够大。
- **缩略层级（LOD）**：镜头距离 > 1500 且没有搜索时只画 Episode / 长期记忆 / 模式（约 124 个节点），Experience 在放大后出现；面板上明确写出「缩略视图……节点与关系统计始终是真实总数」，底部统计仍显示真实的 3163 经历 / 101 关系。
- 关系边两层叠加：柔光（4.4px、α0.42、blur 7）+ 亮芯（2.0px、α0.95），只画真实非 contains 边；`contains` 的浓淡随镜头距离变化（远 0.20 → 近 0.82），远景不糊成白云。
- 全景节点辉光 0.26 → 0.13、半径 ×0.62（缩略层级里语义节点 ×1.7），避免白点把线吞掉。

**回归**
- `tests/stage7.test.ts` 新增 1 例（共 13）：关系统计 = 真实非 contains 边数、每 scope 关系数之和一致、每条关系边两端存在且同 scope、`contains` 归属边聚合后不丢。全量 **207/207**。
- `npm run smoke` → `SMOKE OK`；`verify-stage6.mjs` → `VERIFY STAGE 6 DONE`；`verify-stage7.mjs` → 32 项全过。
- 真实库实测（宿主 55915，headless Chromium 对真实 API）：全景 **3291 节点 / 3246 边 / 关系 101 / 11 个 Scope**；缩略层级 124 个语义节点；放大后 `contains ≥12px` **2736** 条、语义关系 `≥12px` 64 条，画面线像素占比 14.8%；单 Scope 模式 316 节点 / 312 边不回归；0 console 错误。

**Known Issues**：`project_1b1a0fab281b0678` 单 scope 就有 2600+ 个节点，近景仍是一个极密的白团（真实数据密度，可切单 Scope 或继续放大）；旧的 `/memory-sea/scene`、`/memory-sea/view` 仍可能被热重载前的实例占住，需要完整重启宿主才会切到新页面。

## Stage 7.2 — 底部状态与图例不再重叠 + 数据位置可见

**用户反馈（m07464 / m07466）**：1056×794 窗口下底部「已加载 …」与图例行叠在一起；同时问「记忆存在哪个文件夹、能不能自定义」。

**布局修复**
- `#statusbar` 从水平居中（`left:50%; transform:translateX(-50%)`）改为左下第二行（`left:17px; bottom:54px; transform:none`），不再和 `#stats` 抢同一行；`@media (max-width:1120px)` 抬到 `bottom:48px` 并让宽度撑满（原来只改 left/bottom，窄窗口仍会压）。
- 交互提示 `#hint` 在 `max-width:1240px` 以下隐藏，同样的提示文本移进「设置」面板（`#hint-static`），窄窗口靠面板查看，避免右下角与图例挤在一起。
- HUD 字号：`#scope-note` 10px → 11.5px、`#hint` 9px → 10.5px、`.settings-hint` 9px → 10.5px。
- 验收截图：`docs/stage7-hud-before-1056.png`（修复前重叠）、`docs/stage7-layout-1056.png`、`docs/stage7-layout-1440.png`。

**数据位置可见**
- 设置面板新增「数据位置」行（`#db-row` / `#db-path`，只读），内容来自 `GET /api/memory-sea/status` 的 `databasePath`；`scene-app.js` 的 `loadDatabasePath()` 在 `boot()` 里与 `loadScopes()` 并行，失败显示「读取失败（不影响浏览）」。
- 新增 `tests/config-database-path.test.ts` 4 例：默认路径在 `$DSH_HOME/3d-memory-sea/memory-sea.db`；`DSH_MEMORY_SEA_DB` 覆盖；`resolveConfig({databasePath})` 覆盖且优先于 env（支持 `~`）；自定义 `databasePath` 会真正建库且 `status().databasePath` 一致。全量 **211/211**。
- README 新增 `## 数据位置（记忆存在哪个文件夹 / 怎么换）`：查看三种方式、profile `cordis.patch.yml` 覆盖写法、`DSH_MEMORY_SEA_DB`、迁移步骤（完全退出 → 连同 `-wal`/`-shm` 拷贝 → 改配置 → 启动 → 核对节点数）、以及「必须完整重启」的提示。

**本机迁移记录（2026-10-30）**
- 用户选择把知识库从 `C:\Users\Administrator\.dsh\3d-memory-sea\memory-sea.db` 迁到 `D:\MemorySea\memory-sea.db`。
- 用 `VACUUM INTO` 做在线一致性快照（不停宿主、不拷 `-wal`/`-shm`）：源库 3282 experiences / 79 episodes / 51 memories / 5 patterns / 17 migrations，目标库计数完全一致，19.06 MB。
- profile 覆盖写入 `C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml`（追加 `- id: 3d-memory-sea` + `config.databasePath: "D:/MemorySea/memory-sea.db"`，改前已备份 `cordis.patch.yml.bak-dbpath-*`）。
- 用 `resolveConfig({databasePath})` + `MemorySeaService` 打开新库验证：`status().databasePath` 为 `D:\MemorySea\memory-sea.db`，当前项目 scope 计数 312 experiences / 4 episodes 一致。
- 旧库保留在原处作为回滚备份；生效需完整重启 DeepSeek。

**Decisions**
- 数据位置只做**只读展示 + 配置项**，不做 GUI 写路径：改库文件位置必须重启进程才会重新打开数据库，GUI 里改会产生「看起来成功但其实还在旧库」的假象。
- Live Agent 不引入自己的数据库路径配置：它只通过 `ctx.memorySea` 读数据，Memory Sea 换位置后自动跟随。
