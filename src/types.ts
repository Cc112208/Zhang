/**
 * 3D Memory Sea V0.2 —— 核心数据契约
 *
 * 三层语义（本阶段只实现前三层）：
 *   Experience（原始证据，不可被 LLM 改写）
 *     → Episode（一段连续经历，V0.2 的核心对象）
 *       → Recall（可解释召回）
 *
 * Stage 2 增加：Scope（项目隔离）、Episode 生命周期字段、持久化后台任务（Job）、
 * 可插拔 Embedding / Summarizer / SemanticRecall。
 *
 * 本文件只放类型与常量，不放运行时逻辑。
 */

/** 经历的来源类型。chat = 真实对话消息，manual = Agent 主动 remember，其余为预留/导入。 */
export type ExperienceSourceType = 'chat' | 'tool' | 'manual' | 'diary' | 'file' | 'web'

/** 消息在会话中的角色。 */
export type ExperienceRole = 'user' | 'assistant' | 'system' | 'tool'

/** 异步处理状态（embedding / summary 共用）。disabled = 当前没有可用 provider。 */
export type ProcessingStatus = 'pending' | 'ready' | 'failed' | 'disabled'

/** 兼容旧名：向量化状态与 ProcessingStatus 同义。 */
export type EmbeddingStatus = ProcessingStatus

/** Episode 生命周期状态。consolidated / archived 由未来 Dream 阶段写入，本阶段只到 closed。 */
export type EpisodeStatus = 'open' | 'closed' | 'consolidated' | 'archived'

/** Episode 关闭原因（Stage 2 至少实现 idle_timeout / session_end / startup_recovery）。 */
export type EpisodeClosedReason =
  | 'idle_timeout'
  | 'session_end'
  | 'manual'
  | 'startup_recovery'
  | 'topic_shift'

// ------------------------------------------------------------------ Stage 4.5：Episode 连续性

/**
 * Episode 之间的关系类型（spec §18）。
 *
 * continues / followup 表示同一件长期经历的下一步；
 * same_thread / same_topic 只表示「同一个人 / 同一个话题」，不代表叙事连续。
 */
export type EpisodeRelationType = 'continues' | 'followup' | 'same_thread' | 'same_topic'

/** 落库的 Episode 关系。Relation is not evidence：它不进 memory_evidence。 */
export interface EpisodeRelation {
  sourceEpisodeId: string
  targetEpisodeId: string
  scopeId: string
  relation: EpisodeRelationType
  /** 0..1，低于阈值的候选不落库（spec §24）。 */
  confidence: number
  /** 人可读的连接原因（spec §30），例如「same actor + shared topic + 2 days apart」。 */
  reason?: string
  createdAt: number
}

/** 单个相邻 Episode 的视图（inspect / 调试接口用）。 */
export interface EpisodeRelationView {
  episodeId: string
  relation: EpisodeRelationType
  confidence: number
  reason?: string
}

/** Episode 的前后连续性视图（Narrative Chain 的局部切片）。 */
export interface EpisodeContinuityView {
  previous: EpisodeRelationView[]
  next: EpisodeRelationView[]
}

/**
 * 记忆作用域（spec §3）。
 *
 * `id` 是数据库里唯一的作用域键：project scope 用 `project_<hash>`（由规范化根目录派生，
 * 与绝对路径写法无关），global scope 用 `global`。查询永远只按 `id` 过滤，
 * 绝不跨 scope 默认召回。
 */
export interface MemoryScope {
  type: 'project' | 'global'
  id: string
  /** project scope 的规范化根目录（审计/调试用，不参与查询）。 */
  rootPath?: string
}

/** 召回对象类型。Stage 3 增加 memory（长期知识）。 */
export type RecallType = 'experience' | 'episode' | 'memory' | 'pattern'

/** Stage 4.5：查询信号强度（ShortQueryDetector 的确定性判定，不使用 LLM）。 */
export type QuerySignal = 'normal' | 'weak' | 'empty'

/** Stage 4.5：交互类型（领域无关，直播里的 greeting 只是其中一种）。 */
export type RecallInteractionType = 'question' | 'greeting' | 'statement' | 'followup' | 'unknown'

/**
 * Stage 4.5：召回上下文。
 *
 * 关键原则：Context is not query rewriting（spec §85）。上下文只决定「去哪里找候选」，
 * 不解释、不改写用户这句话本身。Memory Sea 只知道 actor / session / interaction，
 * 不知道 viewer / 主播 / 直播这些领域词（领域映射在适配器里做）。
 *
 * Scope 始终是硬边界：actor 相同但 scope 不同，仍不得互相召回（spec §44）。
 */
export interface RecallContext {
  /** 领域无关的参与者 id（直播里就是 viewerId 的稳定派生值）。 */
  actorId?: string
  sessionId?: string
  /** 当前话题提示（由上层给定，不由 Memory Sea 推断）。 */
  currentTopic?: string
  /** 是否是回访参与者：为 true 时才允许「弱查询 + 上下文」召回。 */
  returningActor?: boolean
  interactionType?: RecallInteractionType
  /** 上层已知的近期实体 / 记忆 id（只作为候选提示，仍受 scope 限制）。 */
  recentEntityIds?: string[]
  recentMemoryIds?: string[]
}

/**
 * 原始经历 —— 永远是一次「观察」的快照。
 *
 * 不可变性约定：content 写入后不允许被 LLM 或任何上层模块改写。
 * 需要摘要 / 结论 / 判断时，写 Episode.summary 或未来的 Memory 对象。
 */
export interface Experience {
  id: string

  sourceType: ExperienceSourceType
  sourceId?: string

  sessionId?: string
  turnId?: string

  role?: ExperienceRole

  /** 原始文本，不可变证据。 */
  content: string

  /** 记录时间（写入数据库的时间戳，ms）。 */
  createdAt: number
  /** 观察时间（事件本身发生的时间戳，ms）。默认等于 createdAt。 */
  observedAt: number

  /** 0..1，越大越重要。由 capture 时的启发式规则给出，不做 LLM 判断。 */
  importance: number

  metadata: Record<string, unknown>

  /** 所属 Episode。一个 Experience 最多属于一个 Episode。 */
  episodeId?: string

  embeddingStatus: ProcessingStatus

  /** 所属作用域 id（project_xxx / global）。 */
  scopeId?: string
}

/** 一段连续经历 —— V0.2 的核心对象。 */
export interface Episode {
  id: string

  title?: string

  startedAt: number
  endedAt?: number

  /** 由 episode_experiences 关联表派生，按追加顺序。 */
  experienceIds: string[]

  /** 由 Summarizer 产生的摘要（Stage 2 引入）；不覆盖任何 Experience。 */
  summary?: string

  participants: string[]
  locations: string[]
  topics: string[]

  importance: number
  salience: number
  confidence: number

  status: EpisodeStatus

  /** 最后一条 Experience 的观察时间（ms）。Sweeper 用它判断 idle，避免每次动态 MAX() 查询。 */
  lastExperienceAt: number

  /** 第一次关闭的时间（ms）。关闭幂等：后续 close 不覆盖。 */
  closedAt?: number
  closedReason?: EpisodeClosedReason

  createdAt: number
  updatedAt: number

  embeddingStatus: ProcessingStatus
  /** Episode 摘要处理状态（与 status / embeddingStatus 分离，summary 失败不会让 Episode 回到 open）。 */
  summaryStatus: ProcessingStatus

  /**
   * 长期记忆整理（Consolidation）状态（spec §13）。
   * 独立于主状态：整理失败不会让 Episode 回退，也不会阻塞其它链路。
   */
  consolidationStatus: ProcessingStatus

  /**
   * Episode 连续性分析状态（Stage 4.5）。
   * 独立字段而不是塞进 consolidationStatus：连续性可以重跑，且失败不能影响整理结果。
   */
  continuityStatus: ProcessingStatus

  /** 所属作用域 id。 */
  scopeId?: string
}

/** capture() 入参。 */
export interface CaptureInput {
  /** 调用方自带 id 时用于幂等写入（同一 id 只写一次）。 */
  id?: string

  sourceType?: ExperienceSourceType
  sourceId?: string

  sessionId?: string
  turnId?: string

  role?: ExperienceRole

  content: string

  /** 事件发生时间；缺省用 now()。 */
  observedAt?: number

  importance?: number

  metadata?: Record<string, unknown>
}

/** capture() / remember() 返回。 */
export interface CaptureResult {
  experience: Experience
  /** 该 Experience 落入的 Episode（可能是新建的，也可能是追加到已有 open Episode）。 */
  episode: Episode
  /** true = 本次 capture 新建了 Episode。 */
  createdEpisode: boolean
  /** true = 该 experience 已存在（幂等命中），未重复写入。 */
  deduplicated: boolean
  /** 命中的作用域（调试用）。 */
  scopeId: string
}

/** remember() 入参 —— Agent 主动记录，最终仍然落成 Experience。 */
export interface RememberInput {
  content: string
  importance?: number
  metadata?: Record<string, unknown>
  sessionId?: string
}

/** 召回请求。 */
export interface RecallRequest {
  query: string

  sessionId?: string

  /** 只召回 observedAt < before 的对象（ms 时间戳）。 */
  before?: number
  /** 只召回 observedAt > after 的对象（ms 时间戳）。 */
  after?: number

  types?: RecallType[]

  limit?: number

  /**
   * 是否把命中的 Memory 展开成它的 Evidence Episode、把 Episode 展开成 Experience（spec §38 / §44）。
   * 缺省跟随配置 recall.expandEpisodes；显式 true/false 覆盖配置。
   */
  expandEpisodes?: boolean

  /**
   * 是否把已被取代（superseded）的 Memory 也纳入召回（spec §57）。
   * 默认 false：普通问答应看到当前有效知识；
   * 但要回答「以前为什么这样决定」时必须能打开它 —— 历史不删除。
   */
  includeSuperseded?: boolean

  /** Stage 4.5：召回上下文（弱查询 / 回访参与者场景才显著生效）。 */
  context?: RecallContext

  /**
   * Stage 4.5：Episode 命中时是否沿 continuity 关系展开前后 Episode（spec §27）。
   * 默认跟随配置 episodeContinuity.expandOnRecall；展开数量有上限。
   */
  expandContinuity?: boolean
}

/** 召回理由 —— 可解释性的最小单元。 */
export interface RecallReason {
  type:
    | 'keyword'
    | 'semantic'
    | 'temporal'
    | 'importance'
    | 'session'
    | 'confidence'
    | 'reinforcement'
    /** Stage 4：Pattern 被多少条 Knowledge 支持（描述性模式的主要依据）。 */
    | 'support'
    /** Stage 4：Pattern 的稳定度（支持数 + 时间跨度 - 反证）。 */
    | 'stability'
    /** Stage 4.5：由召回上下文（actor / returning / recent）带来，而不是 query 文本。 */
    | 'context'
    /** Stage 4.5：由 Episode continuity 关系带来的叙事链展开。 */
    | 'continuation'
  score?: number
  detail?: string
}

/** 召回命中。score 一定有 reasons 解释它从哪里来。 */
export interface RecallHit {
  id: string
  type: RecallType
  content: string
  score: number
  createdAt: number
  reasons: RecallReason[]
  /** 展开的证据（Memory→Episode、Episode→Experience）；默认不展开，展开数量有上限。 */
  expanded?: RecallHit[]
}

/** 语义召回的最小结果单元。 */
export interface SemanticHit {
  id: string
  type: RecallType
  score: number
}

/**
 * 语义召回提供者（独立接口，不把 cosine / 向量库写进 RecallEngine）。
 * 未来替换成 Qdrant / pgvector / sqlite-vec 时只换实现。
 */
export interface SemanticRecallProvider {
  /** 当前是否可用；false 时 RecallEngine 归一化剩余权重。 */
  readonly available: boolean
  /** scopeId 是硬过滤条件：绝不在其它 scope 里做相似度检索。 */
  search(scopeId: string, query: string, limit: number): Promise<SemanticHit[]>
}

/**
 * Embedding 提供者（可插拔，默认 Noop）。
 *
 * Stage 2 增加 name / model / isAvailable()：provider 生命周期必须显式，
 * 不允许构造时就发网络请求，也不允许把厂商写死。
 */
export interface EmbeddingProvider {
  readonly name: string
  readonly model: string
  readonly dimensions: number
  /** 可用性检查（可能探测远端）；false 时所有 embedding job 直接 disabled。 */
  isAvailable(): Promise<boolean>
  embed(text: string): Promise<Float32Array>
  embedBatch?(texts: string[]): Promise<Float32Array[]>
}

/** embedding provider 的解析结果（service 用来决定 job 是否可跑）。 */
export interface EmbeddingSelection {
  provider: EmbeddingProvider
  label: string
  model: string
  dimensions: number
  /** 构造期乐观判断：false 表示「明确没有配置」，无需再探测。 */
  configured: boolean
}

/** Episode 摘要结果（不覆盖 Experience，只写 Episode 的派生字段）。 */
export interface EpisodeSummaryResult {
  title?: string
  summary: string
  participants?: string[]
  locations?: string[]
  topics?: string[]
  confidence?: number
}

/** Episode 摘要器接口（Stage 2 不绑定任何 LLM SDK）。 */
export interface EpisodeSummarizer {
  readonly name: string
  summarize(episode: Episode, experiences: Experience[]): Promise<EpisodeSummaryResult>
}

// ------------------------------------------------------------------ 后台任务

export type MemoryJobType =
  | 'episode_summary'
  | 'experience_embedding'
  | 'episode_embedding'
  | 'memory_embedding'
  | 'episode_consolidation'
  | 'memory_pattern_analysis'
  | 'pattern_embedding'
  | 'memory_review'
  | 'episode_continuity'
  | 'skill_candidate_discovery'
  | 'skill_candidate_reevaluate'
  | 'skill_attempt_evaluate'

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed'

export type JobOwnerType = 'episode' | 'experience' | 'memory' | 'pattern' | 'skill_candidate' | 'skill_attempt'

/** 持久化后台任务。状态在 DB 里，进程崩溃后可恢复。 */
export interface MemoryJob {
  id: string
  scopeId: string
  type: MemoryJobType
  ownerType: JobOwnerType
  ownerId: string
  status: JobStatus
  attempts: number
  maxAttempts: number
  /** 最早可执行时间（ms）。重试时会往后推。 */
  availableAt: number
  startedAt?: number
  completedAt?: number
  error?: string
  createdAt: number
  updatedAt: number
}

/** 工具/HTTP 里暴露的任务统计。 */
export interface JobStats {
  pending: number
  running: number
  failed: number
  completed: number
}

// ------------------------------------------------------------------ Scene

/** Scene 节点。 */
export interface ScenePoint {
  id: string
  type: RecallType
  /** experience 点的来源类型（legacy 适配器用它映射「来自真实消息 / 长期记忆 / 日记」）。 */
  sourceType?: ExperienceSourceType
  label: string
  x: number
  y: number
  z: number
  size: number
  importance: number
  activation: number
  createdAt: number
  /** Episode 的摘要（tooltip / legacy full 用），没有 summary 时缺省。 */
  summary?: string
  /** Episode 包含的 Experience 数量。 */
  experienceCount?: number
  /** Semantic Memory 节点的知识类型（type=memory 时存在）。 */
  kind?: MemoryKind
  /** Semantic Memory 的置信度（type=memory 时存在）。 */
  confidence?: number
  /** Semantic Memory 被强化的次数（type=memory 时存在）。 */
  reinforcementCount?: number
  /** Pattern 节点的模式类型（type=pattern 时存在）。 */
  patternKind?: PatternKind
  /** Pattern 的支持 Memory 数量（type=pattern 时存在）。 */
  supportCount?: number
  /** Pattern 的稳定性（0..1，type=pattern 时存在）。 */
  stabilityScore?: number
  /** Pattern 的状态（type=pattern 时存在）。 */
  patternStatus?: PatternStatus
}

/** Scene 连线。Stage 2 只有 contains；Stage 3 增加 memory → episode 的证据关系。 */
export interface SceneEdge {
  a: string
  b: string
  score: number
  kind:
    | 'contains'
    | 'supports'
    | 'derived_from'
    | 'supported_by'
    | 'contradicted_by'
    | 'continues'
    | 'followup'
    | 'same_thread'
    | 'same_topic'
  /** 人可读的连接原因（证据边必须能解释，spec §44）。 */
  reason?: string
}

export interface SceneStats {
  experiences: number
  episodes: number
  /** Semantic Memory 节点数（Stage 3）。 */
  memories?: number
  /** Pattern 节点数（Stage 4）。 */
  patterns?: number
  /** Stage 4.5：Episode 关系（连续经历）边数。 */
  relations?: number
  edges: number
  /** 时间跨度（ms）。 */
  span: { from: number; to: number }
}

/** 3D Memory Sea 的可视化数据契约（稳定、可由 ID 复现）。 */
export interface MemorySeaScene {
  points: ScenePoint[]
  edges: SceneEdge[]
  stats: SceneStats
  /** Scene 所属作用域（Stage 2：scene 只输出当前 project scope）。 */
  scopeId?: string
}

/** 一个对象上已有 embedding 的元数据（inspect 用，绝不返回完整向量）。 */
/**
 * Stage 7：全景（All Scopes）视图的节点。
 * 节点 id 带 scope 命名空间（`<scopeId>::<原始 id>`），保证跨 scope 唯一；
 * `originalId` 保留原始 id，详情接口照旧用它查。
 */
export interface GlobalScenePoint extends ScenePoint {
  scopeId: string
  originalId: string
  scopeRootPath?: string
}

/** Stage 7：全景视图的边。边永远属于同一个 scope（不跨 scope 造边）。 */
export interface GlobalSceneEdge extends SceneEdge {
  scopeId: string
}

/** Stage 7：全景里每个 scope 的真实计数（前端 Scope 过滤与统计用）。 */
export interface GlobalSceneScopeSummary {
  scopeId: string
  rootPath?: string
  points: number
  edges: number
  /** 真实语义/证据关系数（不含 contains 归属边）。 */
  relations: number
  experiences: number
  episodes: number
  memories: number
  patterns: number
}

/** Stage 7：全景统计（在单 scope 统计基础上加 scope 维度）。 */
export interface GlobalSceneStats extends SceneStats {
  scopes: number
  loadedScopes: number
  nodeTotal: number
}

/** Stage 7：某个 scope 聚合失败（必须显式暴露，不能把部分数据伪装成完整全景）。 */
export interface GlobalSceneFailure {
  scopeId: string
  error: string
}

/** Stage 7：多 scope 全景视图。`complete=false` 表示至少一个 scope 读取失败。 */
export interface GlobalScene {
  points: GlobalScenePoint[]
  edges: GlobalSceneEdge[]
  stats: GlobalSceneStats
  scopes: GlobalSceneScopeSummary[]
  failures: GlobalSceneFailure[]
  complete: boolean
  builtAt: number
}

/** Stage 7：全景聚合选项（只读）。 */
export interface GlobalSceneOptions {
  scopeIds?: string[]
}

export interface EmbeddingMetadata {
  provider: string
  model: string
  dimensions: number
  contentHash: string
  createdAt: number
}

/** memory_inspect 的结构化结果（Evidence Chain 第一版）。 */
export interface MemoryInspection {
  id: string
  type: RecallType
  scopeId?: string
  experience?: Experience
  episode?: Episode
  /** type=memory 时返回 Semantic Memory 本体。 */
  memory?: SemanticMemory
  /** type=memory 时的证据列表（Episode / Experience / 其它 Memory）。 */
  evidence?: MemoryEvidence[]
  /** type=memory 时按证据展开的 Episode（上限内，不会一次吐出全部原文）。 */
  episodes?: Episode[]
  /** type=pattern 时返回 Pattern 本体。 */
  pattern?: PatternMemory
  /** type=pattern 时返回支持/反驳它的 Semantic Memory 证据。 */
  patternEvidence?: PatternEvidence[]
  /** type=pattern 时按证据展开的 Semantic Memory。 */
  memories?: SemanticMemory[]
  /** type=experience 时返回其所属 Episode；type=episode 时返回全部 Experience。 */
  experiences: Experience[]
  /** Stage 4.5：只给 episode 用 —— 前后连续 Episode（Narrative Chain 的局部视图）。 */
  continuity?: EpisodeContinuityView
  /** 只给 episode 用：是否存在未归属的孤儿 Experience（数据一致性提示）。 */
  orphanExperienceIds?: string[]
  /** 对象上已有 embedding 时只返回元数据。 */
  embeddings?: EmbeddingMetadata[]
}

/** 插件/服务运行状态，给 /api/health 与调试用。 */
export interface MemorySeaStatus {
  enabled: boolean
  databasePath: string
  scope: MemoryScope
  experiences: number
  episodes: number
  openEpisodes: number
  closedEpisodes: number
  fts: boolean
  jobs: JobStats
  embedding: {
    enabled: boolean
    available: boolean
    provider: string
    model: string
    dimensions: number
  }
  background: {
    enabled: boolean
    running: boolean
  }
  /** Stage 3：当前 scope 的 Semantic Memory 统计。 */
  memories: {
    active: number
    superseded: number
    stale: number
    total: number
  }
  /** Stage 3：Episode 的整理状态统计（pending / ready / failed）。 */
  consolidation: {
    pending: number
    ready: number
    failed: number
  }
  /** Stage 4：当前 scope 的 Pattern 统计。 */
  patterns: {
    candidate: number
    active: number
    weakened: number
    stale: number
    superseded: number
    total: number
  }
  /** Stage 4：Review 队列里到期的对象数。 */
  review: {
    dueMemories: number
    duePatterns: number
  }
  /** Stage 4.5：当前 scope 的 Episode 连续性统计。 */
  continuity: {
    relations: number
    episodesLinked: number
  }
  /** Stage 4.6：摘要质量分布（读时计算，样本上限见 service）。 */
  summaries: { total: number; good: number; fair: number; poor: number; sampled: number }
  /** Stage 4.6：身份审计（只统计，不推断）。 */
  actors: {
    total: number
    normalizedActorId: number
    stablePlatformId: number
    legacyViewerId: number
    nicknameOnly: number
    missing: number
    sampled: number
  }
  /** Stage 5：Skill Candidate 统计（Phase 1 只读）。 */
  skills: {
    candidates: number
    drafting: number
    readyForReview: number
    inReview: number
    approved: number
    rejected: number
    superseded: number
    attempts: number
    attemptsCompleted: number
  }
  /** Stage 4.5：召回能力开关（contextual recall 是否生效）。 */
  recall: {
    contextualEnabled: boolean
  }
  lastError?: { at: number; message: string }
}

/** 默认的 sourceType → legacy 前端可接受的 point.kind 映射依据。 */
export const EXPERIENCE_SOURCE_TYPES: readonly ExperienceSourceType[] = [
  'chat',
  'tool',
  'manual',
  'diary',
  'file',
  'web',
]

export const EPISODE_STATUSES: readonly EpisodeStatus[] = ['open', 'closed', 'consolidated', 'archived']

export const EPISODE_CLOSED_REASONS: readonly EpisodeClosedReason[] = [
  'idle_timeout',
  'session_end',
  'manual',
  'startup_recovery',
  'topic_shift',
]

export const MEMORY_JOB_TYPES: readonly MemoryJobType[] = [
  'episode_summary',
  'experience_embedding',
  'episode_embedding',
  'memory_embedding',
  'episode_consolidation',
  'memory_pattern_analysis',
  'pattern_embedding',
  'memory_review',
  'episode_continuity',
  'skill_candidate_discovery',
  'skill_candidate_reevaluate',
  'skill_attempt_evaluate',
]

export const JOB_STATUSES: readonly JobStatus[] = ['pending', 'running', 'completed', 'failed']

export const PROCESSING_STATUSES: readonly ProcessingStatus[] = ['pending', 'ready', 'failed', 'disabled']

// ================================================================== Stage 3：Semantic Memory
//
// 分层（spec §1–§3）：
//   Closed Episodes → Consolidation → Semantic Memory → Evidence[] → Recall / Scene。
//
// 不变量：
//   - Experience.content 永远不可改写；Memory 是**派生知识**，允许更新（但必须保留证据）。
//   - 每条 Memory 至少 1 条 Evidence（application 层强制，spec §5）。
//   - Memory 的 scopeId 必须继承 Evidence Episode 的 scope，禁止跨 scope（spec §57）。

/** 长期知识的类型。 */
export type MemoryKind =
  | 'fact'
  | 'decision'
  | 'preference'
  | 'goal'
  | 'belief'
  | 'constraint'
  | 'principle'
  | 'relationship'
  | 'other'

/** 长期知识生命周期：旧知识不删除，只标记（spec §41 / §55）。 */
export type MemoryStatus = 'active' | 'superseded' | 'expired' | 'stale'

/** 有证据、有生命周期的稳定陈述。 */
export interface SemanticMemory {
  id: string
  scopeId: string
  kind: MemoryKind
  /** 主题/对象（可选，便于按主体聚合，例如 "Memory Sea 的存储选型"。 */
  subject?: string
  content: string
  /** 归一化文本，只用于去重，不用于展示。 */
  normalizedContent?: string
  confidence: number
  importance: number
  status: MemoryStatus
  validFrom?: number
  validUntil?: number
  createdAt: number
  updatedAt: number
  lastReinforcedAt?: number
  lastAccessedAt?: number
  /** Stage 4：最近一次 Review 的时间。 */
  lastReviewedAt?: number
  /** Stage 4：Review 状态（fresh / review_due / reviewed / stale）。 */
  reviewStatus?: MemoryReviewStatus
  reinforcementCount: number
  accessCount: number
  supersededBy?: string
  embeddingStatus: ProcessingStatus
}

/** 证据来源类型。 */
export type EvidenceType = 'episode' | 'experience' | 'memory'

/** 证据与 Memory 的关系。 */
export type EvidenceRelation = 'supports' | 'contradicts' | 'derived_from' | 'supersedes'

/** 一条证据。不是 JSON 数组，是独立可查询的行（spec §7）。 */
export interface MemoryEvidence {
  memoryId: string
  evidenceType: EvidenceType
  evidenceId: string
  relation: EvidenceRelation
  weight: number
  createdAt: number
}

/** 创建 Memory 的仓储入参。 */
export interface CreateMemoryInput {
  id?: string
  scopeId: string
  kind: MemoryKind
  subject?: string
  content: string
  normalizedContent?: string
  confidence: number
  importance: number
  status?: MemoryStatus
  validFrom?: number
  validUntil?: number
  embeddingStatus?: ProcessingStatus
  createdAt?: number
}

/** Memory 列表/检索过滤（调试 API 与 recall 共用）。 */
export interface MemoryQuery {
  status?: MemoryStatus | MemoryStatus[]
  kind?: MemoryKind | MemoryKind[]
  /** true = 连 superseded 一起返回（历史问题必须可回答，spec §41）。 */
  includeSuperseded?: boolean
  limit?: number
}

// ------------------------------------------------------------------ Consolidation

/** Consolidation 的输入上下文（spec §15）。候选数量必须有上限（§17）。 */
export interface ConsolidationContext {
  scopeId: string
  episode: Episode
  /** 时间/主题/词面上相关的其它 Episode（≤ maxRelatedEpisodes）。 */
  relatedEpisodes: Episode[]
  /** 可能相关的既有 Memory（≤ maxRelatedMemories）。 */
  relatedMemories: SemanticMemory[]
}

/** create：形成一条新知识。 */
export interface CreateMemoryOperation {
  type: 'create'
  kind: MemoryKind
  subject?: string
  content: string
  confidence: number
  importance: number
  /** 支持该结论的 Episode（必须非空；第一条通常是当前 Episode）。 */
  evidenceEpisodeIds: string[]
}

/** reinforce：已有知识被再次证实（不产生重复 Memory）。 */
export interface ReinforceMemoryOperation {
  type: 'reinforce'
  memoryId: string
  evidenceEpisodeIds: string[]
  /** 可选的置信度增量；默认由 applier 按证据数量计算。 */
  confidenceDelta?: number
}

/** update：同一事实变得更完整（保留原证据，不覆盖历史）。 */
export interface UpdateMemoryOperation {
  type: 'update'
  memoryId: string
  content?: string
  subject?: string
  kind?: MemoryKind
  confidence?: number
  importance?: number
  evidenceEpisodeIds?: string[]
}

/** supersede：明确的时间变化（旧知识标记为 superseded，并指向新知识）。 */
export interface SupersedeMemoryOperation {
  type: 'supersede'
  memoryId: string
  kind: MemoryKind
  subject?: string
  content: string
  confidence: number
  importance: number
  evidenceEpisodeIds: string[]
}

/** contradict：证据冲突但无法判断谁更新有效（不自动 supersede，spec §24）。 */
export interface ContradictMemoryOperation {
  type: 'contradict'
  memoryId: string
  evidenceEpisodeIds: string[]
  confidenceDelta?: number
}

/** noop：绝大多数 Episode 应该走这里（spec §25）。 */
export interface NoopOperation {
  type: 'noop'
  reason?: string
}

export type ConsolidationOperation =
  | CreateMemoryOperation
  | ReinforceMemoryOperation
  | UpdateMemoryOperation
  | SupersedeMemoryOperation
  | ContradictMemoryOperation
  | NoopOperation

/** Consolidator 的唯一输出形状：结构化操作，禁止自由文本（spec §19）。 */
export interface ConsolidationResult {
  operations: ConsolidationOperation[]
}

/** 可插拔的整理器（不绑定任何模型厂商，spec §18）。 */
export interface MemoryConsolidator {
  readonly name: string
  /** false 时 service 直接把 Episode 标记为 disabled，不算失败。 */
  readonly configured?: boolean
  consolidate(context: ConsolidationContext): Promise<ConsolidationResult>
}

/** 应用一次 ConsolidationResult 的结果（事务内产生，全部成功或全部回滚）。 */
export interface ConsolidationApplyResult {
  created: string[]
  reinforced: string[]
  updated: string[]
  superseded: string[]
  contradicted: string[]
  /** 被规则/数据校验丢弃的操作数（例如证据为空、memory 不存在）。 */
  skipped: number
}

/** 一次 Episode 整理的可观测结果。 */
export interface ConsolidationOutcome {
  episodeId: string
  scopeId: string
  consolidator: string
  memoryIds: string[]
  operations: ConsolidationApplyResult
  status: ProcessingStatus
}

/** Memory 词法检索命中（MemoryRepository.searchLexical 返回）。 */
export interface MemoryLexicalHit {
  memory: SemanticMemory
  score: number
  strength: number
}

export const MEMORY_KINDS: readonly MemoryKind[] = [
  'fact',
  'decision',
  'preference',
  'goal',
  'belief',
  'constraint',
  'principle',
  'relationship',
  'other',
]

export const MEMORY_STATUSES: readonly MemoryStatus[] = ['active', 'superseded', 'expired', 'stale']

export const EVIDENCE_TYPES: readonly EvidenceType[] = ['episode', 'experience', 'memory']

export const EVIDENCE_RELATIONS: readonly EvidenceRelation[] = [
  'supports',
  'contradicts',
  'derived_from',
  'supersedes',
]

// ================================================================== Stage 4：Pattern Memory
//
// 分层（spec §1–§3）：
//   Semantic Memories → Pattern Candidate Discovery → Pattern Analysis
//   → Pattern Memory → PatternEvidence[] → Recall / Review / Scene。
//
// **Pattern is descriptive. Skill is executable.**
// 本阶段只允许描述性知识（"这个项目长期倾向低复杂度方案"），
// 绝不允许任何可执行能力（execute / runSkill / autoToolCall / policyApply）。

/** 模式类型（描述性，不是可执行技能）。 */
export type PatternKind =
  | 'preference'
  | 'strategy'
  | 'habit'
  | 'principle'
  | 'recurring_decision'
  | 'recurring_problem'
  | 'recurring_solution'
  | 'trend'
  | 'other'

/** Pattern 生命周期：candidate 只是候选，达到门槛才 active。 */
export type PatternStatus = 'candidate' | 'active' | 'weakened' | 'superseded' | 'stale' | 'archived'

/** 跨多个 Semantic Memory 反复出现的模式（描述性知识，spec §5）。 */
export interface PatternMemory {
  id: string
  scopeId: string
  kind: PatternKind
  /** 限定的对象/领域，避免把项目结论说成人格（spec §25/§26）。 */
  subject?: string
  domain?: string
  content: string
  normalizedContent?: string
  confidence: number
  importance: number
  /** 支持该模式的 Semantic Memory 数量（不是 Memory 的 reinforcementCount）。 */
  supportCount: number
  contradictionCount: number
  status: PatternStatus
  /** 支持证据里最早/最晚的事件时间（回答"最近才出现还是持续半年"）。 */
  firstObservedAt: number
  lastObservedAt: number
  createdAt: number
  updatedAt: number
  lastReinforcedAt?: number
  lastReviewedAt?: number
  lastAccessedAt?: number
  accessCount: number
  supersededBy?: string
  embeddingStatus: ProcessingStatus
}

/** Pattern 的证据优先指向 Semantic Memory，而不是全部原始 Experience（spec §6）。 */
export type PatternEvidenceRelation = 'supports' | 'contradicts'

export interface PatternEvidence {
  patternId: string
  memoryId: string
  relation: PatternEvidenceRelation
  weight: number
  createdAt: number
}

/** Pattern 仓储创建入参。 */
export interface CreatePatternInput {
  id?: string
  scopeId: string
  kind: PatternKind
  subject?: string
  domain?: string
  content: string
  normalizedContent?: string
  confidence: number
  importance: number
  status?: PatternStatus
  /** 初始支持数（通常由 applier 写入证据后回写，创建时可省略）。 */
  supportCount?: number
  contradictionCount?: number
  firstObservedAt: number
  lastObservedAt: number
  embeddingStatus?: ProcessingStatus
  createdAt?: number
}

/** Pattern 列表/检索过滤。 */
export interface PatternQuery {
  status?: PatternStatus | PatternStatus[]
  kind?: PatternKind | PatternKind[]
  includeSuperseded?: boolean
  limit?: number
}

/** Pattern 分析输入上下文（spec §14）。候选数量必须有上限。 */
export interface PatternContext {
  scopeId: string
  triggerMemory: SemanticMemory
  /** 同 scope 的其它 active Memory（≤ maxRelatedMemories）。 */
  relatedMemories: SemanticMemory[]
  /** 同一 scope 里已有的 candidate/active/weakened Pattern（≤ maxExistingPatterns）。 */
  existingPatterns: PatternMemory[]
}

export interface CreatePatternOperation {
  type: 'create'
  kind: PatternKind
  content: string
  confidence: number
  importance: number
  subject?: string
  domain?: string
  supportingMemoryIds: string[]
}

export interface ReinforcePatternOperation {
  type: 'reinforce'
  patternId: string
  supportingMemoryIds: string[]
  confidenceDelta?: number
}

/** 弱化：不足以推翻模式，只是说明"没这么强"（spec §20）。 */
export interface WeakenPatternOperation {
  type: 'weaken'
  patternId: string
  contradictingMemoryIds: string[]
  confidenceDelta?: number
}

/** 取代：只有明确长期趋势改变才允许，且必须先立后废（spec §21）。 */
export interface SupersedePatternOperation {
  type: 'supersede'
  patternId: string
  kind: PatternKind
  content: string
  confidence: number
  importance: number
  supportingMemoryIds: string[]
  subject?: string
  domain?: string
}

export interface NoopPatternOperation {
  type: 'noop'
  reason: string
}

export type PatternOperation =
  | CreatePatternOperation
  | ReinforcePatternOperation
  | WeakenPatternOperation
  | SupersedePatternOperation
  | NoopPatternOperation

export interface PatternAnalysisResult {
  operations: PatternOperation[]
}

/** 结构化分析器：规则式（默认）或 LLM（失败回退规则式）。 */
export interface PatternAnalyzer {
  readonly name: string
  readonly configured?: boolean
  analyze(context: PatternContext): Promise<PatternAnalysisResult>
}

/** 一次 Pattern 应用的统计。 */
export interface PatternApplyResult {
  created: string[]
  reinforced: string[]
  weakened: string[]
  superseded: string[]
  /** 被丢弃的操作数（证据不足、pattern 不存在等）。 */
  skipped: number
}

/** Pattern 词法检索命中。 */
export interface PatternLexicalHit {
  pattern: PatternMemory
  score: number
  strength: number
}

// ------------------------------------------------------------------ Memory Review（spec §31–§35）

/** Review 状态：stale ≠ 错误，只是"旧了"。 */
export type MemoryReviewStatus = 'fresh' | 'review_due' | 'reviewed' | 'stale'

/** Review 只允许两种低风险结论（spec §35）。 */
export type MemoryReviewDecision = 'keep' | 'mark_stale'

export interface MemoryReviewResult {
  memoryId: string
  decision: MemoryReviewDecision
  reviewStatus: MemoryReviewStatus
}

// ================================================================== Stage 5：Skill Candidate
//
// 边界（Phase 0 已批准）：
//   - Pattern is not Procedure：Pattern 只是候选来源，不是流程；
//   - Repeated is not successful：支持次数不是成功次数；
//   - Evidence is not attribution：证据来源与归因类型分开记录；
//   - Unknown is not failure：unknown / inconclusive / aborted 不进成功率分母；
//   - Approved is not validated：批准只代表接受描述；
//   - Candidate is not executable Skill：这里只有数据与状态，没有任何执行入口。

/** 候选类型（描述性，不代表可执行）。 */
export type SkillCandidateKind = 'guideline' | 'procedure' | 'decision_rule' | 'checklist' | 'other'

/** 候选生命周期状态（Phase 0 §4.1）。 */
export type SkillCandidateStatus =
  | 'drafting'
  | 'ready_for_review'
  | 'in_review'
  | 'changes_requested'
  | 'approved'
  | 'rejected'
  | 'superseded'
  | 'stale_candidate'

/** 版本状态：内容一旦 submit 就不可改，只能新建版本。 */
export type SkillVersionStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'superseded'

/** 成熟度是派生评估结果，不作为权威数据入库缓存。 */
export type SkillMaturityLevel = 'insufficient' | 'structural_only' | 'observed' | 'validated'

export type SkillMaturityMissing =
  | 'no_steps'
  | 'step_coverage_below_half'
  | 'step_without_evidence'
  | 'no_success_criteria'
  | 'no_attempts'
  | 'insufficient_verified_samples'
  | 'insufficient_independent_episodes'
  | 'inferred_attempts_only'
  | 'unresolved_contradictions'
  | 'pattern_weakened_contradictions'
  | 'insufficient_independent_attempts'
  | 'insufficient_direct_attempts'
  | 'user_reported_only'
  | 'low_success_rate'

export type SkillAttemptStatus = 'planned' | 'running' | 'completed' | 'aborted'
export type SkillAttemptResult = 'success' | 'partial_success' | 'failure' | 'unknown' | 'inconclusive'
export type SkillAttribution = 'direct' | 'user_reported' | 'inferred' | 'none'
export type SkillOutcomeRelation = 'supports' | 'contradicts' | 'partial'
export type SkillReviewDecision = 'submit' | 'approve' | 'reject' | 'request_changes'

/** 步骤 / 条件里对真实证据的引用；只存指针，不复制原文。 */
export interface SkillEvidenceRef {
  type: EvidenceType
  id: string
  note?: string
}

export interface ProcedureStep {
  stepNo: number
  action: string
  detail?: string
  /** 空数组表示这一步是推断出来的，不是有证据的步骤（不计入 stepCoverage）。 */
  evidenceRefs: SkillEvidenceRef[]
  /** true = 人工补充的步骤，尚无证据支持，必须标记为待验证。 */
  inferred?: boolean
  /** 步骤来源：derived（由模式推导）/ manual（人工补充）/ evidence（有直接证据）。 */
  source?: 'derived' | 'manual' | 'evidence'
}

export interface TriggerCondition {
  id: string
  description: string
  evidenceRefs?: SkillEvidenceRef[]
}

export interface Precondition {
  id: string
  description: string
  required: boolean
  evidenceRefs?: SkillEvidenceRef[]
}

export interface ExpectedOutcome {
  id: string
  description: string
  evidenceRefs?: SkillEvidenceRef[]
}

/** 人工确认的成功标准；没有它就不允许做成功/失败判定。 */
export interface SuccessCriterion {
  id: string
  description: string
  measurable?: boolean
  /**
   * 成功标准的来源（Phase 2C）：manual = 人工填写，evidence = 由证据推导，
   * derived = 由模式派生。没有来源的标准不能用于判定尝试成功。
   */
  source?: 'manual' | 'evidence' | 'derived'
}

/** 版本内的 Procedure Draft（经 schema 校验的 JSON）。 */
export interface ProcedureDraft {
  steps: ProcedureStep[]
  triggers: TriggerCondition[]
  preconditions: Precondition[]
  expectedOutcomes: ExpectedOutcome[]
  exceptions: string[]
  limitations: string[]
  successCriteria: SuccessCriterion[]
}

/** 版本创建时固化的来源快照（记录当时的 status/confidence，便于解释「当时依据什么」）。 */
export interface SkillEvidenceSnapshot {
  patternId?: string
  memoryIds: string[]
  episodeIds: string[]
  experienceIds: string[]
  capturedAt: number
  details?: Array<{ type: EvidenceType; id: string; status?: string; confidence?: number }>
}

export interface SkillCandidate {
  id: string
  scopeId: string
  sourcePatternId?: string
  sourceMemoryIds: string[]
  title: string
  description?: string
  kind: SkillCandidateKind
  status: SkillCandidateStatus
  currentVersionId?: string
  latestVersionNo: number
  provenanceChanged: boolean
  reviewDueAt?: number
  createdAt: number
  updatedAt: number
}

export interface SkillCandidateVersion {
  id: string
  candidateId: string
  scopeId: string
  versionNo: number
  parentVersionId?: string
  status: SkillVersionStatus
  title: string
  procedure: ProcedureDraft
  evidenceSnapshot: SkillEvidenceSnapshot
  changeReason: string
  createdBy: string
  createdAt: number
  updatedAt: number
}

export interface SkillAttempt {
  id: string
  scopeId: string
  candidateId: string
  versionId: string
  externalKey: string
  status: SkillAttemptStatus
  result?: SkillAttemptResult
  attribution: SkillAttribution
  successCriteriaSnapshot: SuccessCriterion[]
  startedAt: number
  endedAt?: number
  note?: string
  correctionsAttemptId?: string
  createdAt: number
  updatedAt: number
}

export interface SkillOutcomeEvidence {
  attemptId: string
  scopeId: string
  versionId: string
  evidenceType: EvidenceType | 'manual'
  evidenceId: string
  relation: SkillOutcomeRelation
  attribution: SkillAttribution
  weight: number
  observedAt: number
  createdAt: number
}

export interface SkillReviewRecord {
  id: string
  scopeId: string
  candidateId: string
  versionId: string
  decision: SkillReviewDecision
  reviewer: string
  reason: string
  fromStatus: string
  toStatus: string
  /** 审核入口的认证方式（Phase 2B）：local_token = 本地操作者令牌，service = 内部调用。 */
  authMethod?: 'local_token' | 'service'
  createdAt: number
}

/** 独立证据统计（去重后）。 */
export interface SkillIndependentEvidence {
  independentUnits: number
  independentEpisodes: number
  independentExperiences: number
  independentMemories: number
  rawRefs: number
  duplicatesRemoved: number
}

/** Attempt 统计：只有 verified 才进入成功率分母。 */
export interface SkillAttemptStats {
  total: number
  completed: number
  aborted: number
  success: number
  partialSuccess: number
  failure: number
  unknown: number
  inconclusive: number
  inferred: number
  verified: number
  /** 归因拆分：direct = 直接观察，userReported = 用户报告，二者共同构成 verified。 */
  directVerified: number
  userReportedVerified: number
  /**
   * 独立已验证尝试数：按「带来新 Episode 或直接观察」去重后的尝试数。
   * 同一 Episode 的多次尝试、同一结果的重复报告都不增加这个数。
   */
  independentVerified: number
  /** 该候选的已验证尝试覆盖到的独立 Episode 数。 */
  episodesCovered: number
}

/** 成熟度评估结果：派生、可解释、必须带缺口与理由。 */
export interface SkillCandidateMaturity {
  candidateId: string
  level: SkillMaturityLevel
  evidence: SkillIndependentEvidence
  attempts: SkillAttemptStats
  stepCoverage: number
  successCriteriaDefined: boolean
  missing: SkillMaturityMissing[]
  reasons: string[]
  contradictions: string[]
  effectiveness?: {
    reportable: boolean
    sampleSize: number
    successes: number
    successRate?: number
    /** Wilson 95% 置信区间（小样本下比正态近似更可靠）。 */
    ci95?: { low: number; high: number }
    /** 样本量小于报告门槛时为 true，成功率只能当参考。 */
    smallSample?: boolean
    /** 独立样本数（与 sampleSize 不同的口径，见 statistics.ts）。 */
    independentSampleSize?: number
    note?: string
  }
  evaluatedAt: number
}

export const SKILL_CANDIDATE_KINDS: readonly SkillCandidateKind[] = [
  'guideline',
  'procedure',
  'decision_rule',
  'checklist',
  'other',
]

export const SKILL_CANDIDATE_STATUSES: readonly SkillCandidateStatus[] = [
  'drafting',
  'ready_for_review',
  'in_review',
  'changes_requested',
  'approved',
  'rejected',
  'superseded',
  'stale_candidate',
]

export const SKILL_ATTEMPT_RESULTS: readonly SkillAttemptResult[] = [
  'success',
  'partial_success',
  'failure',
  'unknown',
  'inconclusive',
]

export const SKILL_ATTRIBUTIONS: readonly SkillAttribution[] = ['direct', 'user_reported', 'inferred', 'none']

export const PATTERN_KINDS: readonly PatternKind[] = [
  'preference',
  'strategy',
  'habit',
  'principle',
  'recurring_decision',
  'recurring_problem',
  'recurring_solution',
  'trend',
  'other',
]

export const PATTERN_STATUSES: readonly PatternStatus[] = [
  'candidate',
  'active',
  'weakened',
  'superseded',
  'stale',
  'archived',
]

export const PATTERN_EVIDENCE_RELATIONS: readonly PatternEvidenceRelation[] = ['supports', 'contradicts']

export const MEMORY_REVIEW_STATUSES: readonly MemoryReviewStatus[] = [
  'fresh',
  'review_due',
  'reviewed',
  'stale',
]

// ---------------------------------------------------------------------------
// Stage 6：3D 页面的只读详情视图。
//
// 只做「读出已有数据并裁剪成适合前端展示的形状」，不参与记忆模型，
// 也不产生任何新的持久化对象（Stage 6 只读约束）。
// ---------------------------------------------------------------------------

export interface EpisodeExperiencePreview {
  id: string
  sourceType: ExperienceSourceType
  role?: ExperienceRole
  createdAt: number
  observedAt: number
  importance: number
  contentPreview: string
}

export interface EpisodeMemoryLink {
  memoryId: string
  kind: MemoryKind
  status: MemoryStatus
  content: string
  confidence: number
  importance: number
  relation: EvidenceRelation
}

export interface EpisodeDetailView {
  episode: Episode
  experiences: EpisodeExperiencePreview[]
  memories: EpisodeMemoryLink[]
  continuity: EpisodeContinuityView
  stats: { experienceCount: number; memoryCount: number; truncated: boolean }
}

export interface ExperienceDetailView {
  experience: Experience
  episode: Episode | null
}
