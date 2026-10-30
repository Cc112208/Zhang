/**
 * config.ts —— Memory Sea V0.2 Stage 2 配置。
 *
 * 设计约束（spec §27）：
 *   - 装上就能跑：不配置任何字段也要有可用的本地 SQLite + 项目作用域；
 *   - 所有后台能力（摘要 / embedding / job runner）默认「存在但可关」，关掉后主链路完全不受影响；
 *   - 非法值一律回落默认并夹取范围，绝不因为配置写错让插件启动失败；
 *   - 密钥（embedding/summary 的 apiKey）只允许来自 config 或环境变量，且不得进入任何返回值/日志。
 */

import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { MemoryScope } from './types.js'
import { deriveProjectScopeId, normalizeProjectPath } from './scope/path-normalizer.js'

/** 配置里的作用域：只有「声明」，真正的 id 由 ScopeResolver 在运行时派生。 */
export interface ConfiguredScope {
  type: 'project' | 'global'
  /** project 作用域的根路径（缺省由会话 cwd 决定）。 */
  rootPath?: string
}

export interface EmbeddingConfig {
  enabled: boolean
  provider?: string
  model?: string
  apiKey?: string
  baseUrl?: string
  dimensions?: number
  timeoutMs?: number
}

export interface SummaryConfig {
  enabled: boolean
  provider?: string
  endpoint?: string
  apiKey?: string
  model?: string
  timeoutMs?: number
}

export interface JobsConfig {
  enabled: boolean
  /** 后台轮询间隔（ms）。 */
  intervalMs: number
  /** 每轮最多处理多少个任务（保护宿主主线程）。 */
  maxPerTick: number
  /** running 超过该时长视为卡死，可被回收。 */
  staleMs: number
  /** 单任务最大尝试次数。 */
  maxAttempts: number
}

/** Episode 生命周期（spec §45）：空闲多久算断档、多久扫一次。 */
export interface EpisodeConfig {
  /** 两条 Experience 间隔超过该值（ms）就关闭旧 Episode。 */
  idleMs: number
  /** 后台扫描 open Episode 的间隔（ms）。 */
  sweepIntervalMs: number
}

/**
 * Dream / Consolidation 配置（spec §17 / §28 / §30）。
 *
 * 默认是「规则整理」：没有 LLM 也必须能把 Episode 变成 Semantic Memory。
 * provider='llm' 且 endpoint+model 齐全才走远端；否则自动回退规则整理。
 */
export interface ConsolidationConfig {
  enabled: boolean
  provider: 'rule-based' | 'llm'

  /** 单个 Episode 最多参考多少个相关 Episode / Memory。 */
  maxRelatedEpisodes: number
  maxRelatedMemories: number

  /** 形成新 Memory 的最低置信度门槛。 */
  minConfidence: number

  /** 出现明确时间变化措辞时是否允许自动 supersede（默认允许）。 */
  autoSupersede: boolean

  /** preference/belief/principle 这类知识是否要求多条 Evidence。 */
  requireMultipleEvidenceForPreference: boolean

  /** provider='llm' 时使用；也接受 DSH_MEMORY_SEA_CONSOLIDATION_* 环境变量。 */
  endpoint?: string
  apiKey?: string
  model?: string
  timeoutMs?: number
}

/**
 * Pattern 分析配置（Stage 4，spec §59）。
 *
 * Pattern 是**描述性**的高层知识：至少 minSupport 条 Semantic Memory 支持才可能成立。
 * 默认保守：minSupport=3、activationThreshold=0.7，宁可不产生，也不要造出"另一份 Memory"。
 */
export interface PatternConfig {
  enabled: boolean
  provider: 'rule' | 'llm'

  /** 支持一个 Pattern 所需的最少 Semantic Memory 数（硬下限 2）。 */
  minSupport: number

  /** candidate → active 的置信度门槛。 */
  activationThreshold: number

  /** 单次分析最多参考多少条相关 Memory / 已有 Pattern。 */
  maxRelatedMemories: number
  maxExistingPatterns: number

  /** 出现反证时每次弱化的置信度幅度。 */
  confidenceDecayOnContradiction: number

  /** provider='llm' 时使用；也接受 DSH_MEMORY_SEA_PATTERN_* 环境变量。 */
  endpoint?: string
  apiKey?: string
  model?: string
  timeoutMs?: number
}

/**
 * Memory / Pattern Review 配置（spec §31–§36）。
 *
 * 默认很保守：180 天才考虑"该看看了"，且只把低置信度的旧知识标 stale。
 * stale ≠ 错误，也不等于 superseded —— 只有明确的新证据才会 supersede。
 */
export interface ReviewConfig {
  enabled: boolean

  /** Review 扫描间隔（ms），默认 6 小时。 */
  intervalMs: number

  /** 多久没有新证据支持就进入 review 候选。 */
  memoryStaleAfterMs: number
  patternStaleAfterMs: number

  /** 每次 Review 最多处理多少条。 */
  maxItemsPerRun: number

  /** 只有置信度低于该值的旧知识才会被标 stale（高置信度旧知识只标 reviewed）。 */
  memoryStaleConfidence: number
}

/**
 * 上下文召回（Stage 4.5）：弱查询 + 强上下文时的候选来源。
 * 它只扩大「可能是谁在问、他最近在做什么」的召回面，不解释也不改写 query。
 */
export interface ContextualRecallConfig {
  enabled: boolean

  /** 一次最多给多少上下文候选。 */
  maxCandidates: number

  /** 不超过这个字数（且命中问候/确认/代词等）才算弱查询。 */
  weakQueryMaxLength: number

  /** 回访参与者的加成倍数。 */
  returningActorBoost: number

  /** 近因衰减窗口（毫秒）。 */
  recentMemoryWindowMs: number
}

/**
 * Episode 连续性（Stage 4.5）：跨 Episode / 跨场次把同一段经历链起来。
 * 只建立 relation，不合并、不改写任何 Episode 内容。
 */
export interface EpisodeContinuityConfig {
  enabled: boolean

  /** 只在这个时间窗内找候选前序 Episode。 */
  lookbackMs: number

  /** 每次最多检查多少个候选。 */
  maxCandidates: number

  /** 低于这个置信度不建立关系。 */
  minConfidence: number

  /** 召回时向每个方向展开几层。 */
  maxExpansionDepth: number
}

export interface MemorySeaConfig {
  enabled: boolean

  databasePath: string

  /** 记忆作用域声明（Stage 2 真正按项目隔离；global 仅预留）。 */
  scope: ConfiguredScope

  capture: {
    enabled: boolean

    userMessages: boolean
    assistantMessages: boolean
    toolResults: boolean

    /** 两条 Experience 间隔超过该值（ms）就关闭旧 Episode 开新的。默认 20 分钟。 */
    episodeIdleMs: number
  }

  recall: {
    maxResults: number

    lexicalWeight: number
    semanticWeight: number
    temporalWeight: number
    importanceWeight: number
    recencyWeight: number

    /** Episode 命中后是否把它的代表 Experience 也带进结果（默认 false，保持结果可读）。 */
    expandEpisodes: boolean
  }

  embedding: EmbeddingConfig

  summary: SummaryConfig

  consolidation: ConsolidationConfig

  pattern: PatternConfig

  review: ReviewConfig

  contextualRecall: ContextualRecallConfig

  episodeContinuity: EpisodeContinuityConfig

  /** Stage 5：Skill Candidate（只有描述性候选，没有任何执行能力）。 */
  skill: SkillConfig

  /** Stage 5 Phase 2B：人工审核写入口的本机操作者认证。 */
  operator: OperatorConfig

  episode: EpisodeConfig

  jobs: JobsConfig

  scene: {
    maxPoints: number
  }
}

/**
 * Stage 5 Phase 2B：人工审核入口的操作者认证配置。
 *
 * 宿主目前没有可信的用户身份服务，所以用本机 0600 随机令牌文件作为真实凭证：
 *   - 只有读得到该文件的本机进程 / 本机用户才能审核；
 *   - 关闭（enabled=false）时所有写入口返回 503，不静默放行；
 *   - 令牌不写入日志，只记录 operatorId 指纹。
 */
export interface OperatorConfig {
  enabled: boolean

  /** 令牌文件路径；默认 `${DSH_HOME:-~/.dsh}/3d-memory-sea/operator-token`。 */
  tokenPath?: string

  /** 是否只接受本机（loopback）连接。默认 true。 */
  requireLoopback: boolean
}

export interface SkillConfig {
  enabled: boolean

  /** 初筛门槛：至少多少条支持 Memory。 */
  minSupportMemories: number

  /** 初筛门槛：至少多少个独立 Episode。 */
  minIndependentEpisodes: number

  /** Pattern 稳定度下限（0..1）。 */
  minStability: number

  /** 一个 draft 最多推导多少步骤。 */
  maxStepsPerDraft: number

  /** Phase 2A：进入 validated 需要的独立已验证尝试数（默认 5，两次成功不算证明）。 */
  minIndependentAttempts: number

  /** Phase 2A：至少多少次归因为 direct（直接观察）的已验证尝试。 */
  minDirectAttempts: number

  /** Phase 2A：validated 的最低成功率（0..1）。 */
  minSuccessRateForValidated: number

  /** Phase 2A：报告成功率所需最小样本量（低于它标记 small sample）。 */
  minReportableSamples: number

  /** Phase 2A：Wilson 区间的 z 值（1.96 = 95%）。 */
  wilsonZ: number

  /** 判定 validated 需要的已验证 Attempt 数。 */
  minValidatedAttempts: number

  /** 步骤证据覆盖率下限（0..1）。 */
  minStepCoverage: number

  /** Pattern 置信度下限。 */
  minConfidence: number

  /** 是否允许 weakened Pattern 生成探索性候选。 */
  allowWeakenedPatterns: boolean
}

/** 20 分钟：spec §7 的默认 episodeIdleMs。 */
export const DEFAULT_EPISODE_IDLE_MS = 20 * 60 * 1000

/** 默认数据库位置：$DSH_HOME/3d-memory-sea/memory-sea.db（DSH_HOME 缺省 ~/.dsh）。 */
export function defaultDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = nonEmpty(env.DSH_MEMORY_SEA_DB)
  if (override) return resolve(override)
  const home = nonEmpty(env.DSH_HOME) ?? join(homedir(), '.dsh')
  return join(home, '3d-memory-sea', 'memory-sea.db')
}

/**
 * 默认作用域声明。
 *
 * Stage 2 的关键修复：不再把 `process.cwd()` 固化成 scope（宿主进程 cwd 是 profile 目录，
 * 会让所有会话共用一个作用域）。这里只声明「默认按项目」，具体根路径由 ScopeResolver
 * 从会话 cwd 推导，进程 cwd 仅作最后兜底。
 */
export function defaultConfiguredScope(env: NodeJS.ProcessEnv = process.env): ConfiguredScope {
  const override = nonEmpty(env.DSH_MEMORY_SEA_ROOT)
  return override ? { type: 'project', rootPath: resolve(override) } : { type: 'project' }
}

/** 兼容 Stage 1 的调用点：直接给一个已解析的 scope（兜底用途，运行时一般用 ScopeResolver）。 */
export function defaultScope(rootPath: string = process.cwd()): MemoryScope {
  const root = resolve(rootPath)
  return { type: 'project', id: deriveProjectScopeId(root), rootPath: normalizeProjectPath(root) }
}

export const MEMORY_SEA_DEFAULTS: MemorySeaConfig = {
  enabled: true,
  databasePath: defaultDatabasePath(),
  scope: defaultConfiguredScope(),
  capture: {
    enabled: true,
    userMessages: true,
    assistantMessages: true,
    toolResults: true,
    episodeIdleMs: DEFAULT_EPISODE_IDLE_MS,
  },
  recall: {
    maxResults: 8,
    lexicalWeight: 0.45,
    semanticWeight: 0.25,
    temporalWeight: 0.12,
    importanceWeight: 0.1,
    recencyWeight: 0.08,
    expandEpisodes: false,
  },
  embedding: {
    enabled: true,
  },
  summary: {
    enabled: true,
  },
  consolidation: {
    enabled: true,
    provider: 'rule-based',
    maxRelatedEpisodes: 8,
    maxRelatedMemories: 12,
    minConfidence: 0.5,
    autoSupersede: true,
    requireMultipleEvidenceForPreference: true,
  },
  pattern: {
    enabled: true,
    provider: 'rule',
    minSupport: 3,
    activationThreshold: 0.7,
    maxRelatedMemories: 12,
    maxExistingPatterns: 8,
    confidenceDecayOnContradiction: 0.1,
  },
  review: {
    enabled: true,
    intervalMs: 6 * 60 * 60 * 1000,
    memoryStaleAfterMs: 180 * 24 * 60 * 60 * 1000,
    patternStaleAfterMs: 90 * 24 * 60 * 60 * 1000,
    maxItemsPerRun: 20,
    memoryStaleConfidence: 0.75,
  },
  contextualRecall: {
    enabled: true,
    maxCandidates: 5,
    weakQueryMaxLength: 6,
    returningActorBoost: 1.25,
    recentMemoryWindowMs: 21 * 24 * 60 * 60 * 1000,
  },
  episodeContinuity: {
    enabled: true,
    lookbackMs: 30 * 24 * 60 * 60 * 1000,
    maxCandidates: 10,
    minConfidence: 0.45,
    maxExpansionDepth: 2,
  },
  skill: {
    enabled: true,
    minSupportMemories: 3,
    minIndependentEpisodes: 2,
    minStability: 0.5,
    maxStepsPerDraft: 6,
    minValidatedAttempts: 5,
    minIndependentAttempts: 5,
    minDirectAttempts: 1,
    minSuccessRateForValidated: 0.5,
    minReportableSamples: 5,
    wilsonZ: 1.96,
    minStepCoverage: 0.6,
    minConfidence: 0.6,
    allowWeakenedPatterns: true,
  },
  operator: {
    enabled: true,
    requireLoopback: true,
  },
  episode: {
    idleMs: DEFAULT_EPISODE_IDLE_MS,
    sweepIntervalMs: 60_000,
  },
  jobs: {
    enabled: true,
    intervalMs: 5000,
    maxPerTick: 8,
    staleMs: 60_000,
    maxAttempts: 3,
  },
  scene: {
    maxPoints: 4000,
  },
}

/**
 * 把 Cordis 传入的原始 config 解析成完整配置。
 * 未知字段忽略；数字夹取；权重全为 0 时回落默认（避免「召回全 0 分」）。
 */
export function resolveConfig(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
): MemorySeaConfig {
  const raw = isRecord(input) ? input : {}
  const capture = isRecord(raw.capture) ? raw.capture : {}
  const recall = isRecord(raw.recall) ? raw.recall : {}
  const embedding = isRecord(raw.embedding) ? raw.embedding : {}
  const summary = isRecord(raw.summary) ? raw.summary : {}
  const consolidation = isRecord(raw.consolidation) ? raw.consolidation : {}
  const pattern = isRecord(raw.pattern) ? raw.pattern : {}
  const review = isRecord(raw.review) ? raw.review : {}
  const contextualRecall = isRecord(raw.contextualRecall) ? raw.contextualRecall : {}
  const episodeContinuity = isRecord(raw.episodeContinuity) ? raw.episodeContinuity : {}

  const skill = isRecord(raw.skill) ? raw.skill : {}
  const operator = isRecord(raw.operator) ? raw.operator : {}
  const jobs = isRecord(raw.jobs) ? raw.jobs : {}
  const background = isRecord(raw.background) ? raw.background : {}
  const episode = isRecord(raw.episode) ? raw.episode : {}
  const scene = isRecord(raw.scene) ? raw.scene : {}

  const d = MEMORY_SEA_DEFAULTS

  const databasePathInput =
    typeof raw.databasePath === 'string' && raw.databasePath.trim().length > 0 ? raw.databasePath.trim() : undefined
  const databasePath = databasePathInput ? expandHome(resolve(databasePathInput)) : defaultDatabasePath(env)

  const weights = {
    lexicalWeight: unit(recall.lexicalWeight, d.recall.lexicalWeight),
    semanticWeight: unit(recall.semanticWeight, d.recall.semanticWeight),
    temporalWeight: unit(recall.temporalWeight, d.recall.temporalWeight),
    importanceWeight: unit(recall.importanceWeight, d.recall.importanceWeight),
    recencyWeight: unit(recall.recencyWeight, d.recall.recencyWeight),
  }
  if (
    weights.lexicalWeight + weights.semanticWeight + weights.temporalWeight + weights.importanceWeight +
      weights.recencyWeight <=
    0
  ) {
    Object.assign(weights, {
      lexicalWeight: d.recall.lexicalWeight,
      semanticWeight: d.recall.semanticWeight,
      temporalWeight: d.recall.temporalWeight,
      importanceWeight: d.recall.importanceWeight,
      recencyWeight: d.recall.recencyWeight,
    })
  }

  return {
    enabled: bool(raw.enabled, d.enabled),
    databasePath,
    scope: resolveConfiguredScope(raw.scope),
    capture: {
      enabled: bool(capture.enabled, d.capture.enabled),
      userMessages: bool(capture.userMessages, d.capture.userMessages),
      assistantMessages: bool(capture.assistantMessages, d.capture.assistantMessages),
      toolResults: bool(capture.toolResults, d.capture.toolResults),
      episodeIdleMs: int(episode.idleMs ?? capture.episodeIdleMs, d.episode.idleMs, 60_000, 24 * 60 * 60 * 1000),
    },
    recall: {
      maxResults: int(recall.maxResults, d.recall.maxResults, 1, 50),
      ...weights,
      expandEpisodes: bool(recall.expandEpisodes, d.recall.expandEpisodes),
    },
    embedding: {
      enabled: bool(embedding.enabled, d.embedding.enabled),
      provider: nonEmpty(embedding.provider) ?? undefined,
      model: nonEmpty(embedding.model) ?? undefined,
      apiKey: nonEmpty(embedding.apiKey) ?? nonEmpty(env.DSH_MEMORY_SEA_EMBEDDING_API_KEY),
      baseUrl: nonEmpty(embedding.baseUrl) ?? nonEmpty(env.DSH_MEMORY_SEA_EMBEDDING_BASE_URL),
      dimensions: optionalInt(embedding.dimensions, 1, 32_768),
      timeoutMs: optionalInt(embedding.timeoutMs, 1000, 120_000),
    },
    summary: {
      enabled: bool(summary.enabled, d.summary.enabled),
      provider: nonEmpty(summary.provider) ?? undefined,
      endpoint: nonEmpty(summary.endpoint) ?? nonEmpty(env.DSH_MEMORY_SEA_SUMMARY_ENDPOINT),
      apiKey: nonEmpty(summary.apiKey) ?? nonEmpty(env.DSH_MEMORY_SEA_SUMMARY_API_KEY),
      model: nonEmpty(summary.model) ?? nonEmpty(env.DSH_MEMORY_SEA_SUMMARY_MODEL),
      timeoutMs: optionalInt(summary.timeoutMs, 1000, 120_000),
    },
    consolidation: {
      enabled: bool(consolidation.enabled, d.consolidation.enabled),
      provider: consolidation.provider === 'llm' ? 'llm' : 'rule-based',
      maxRelatedEpisodes: int(consolidation.maxRelatedEpisodes, d.consolidation.maxRelatedEpisodes, 0, 32),
      maxRelatedMemories: int(consolidation.maxRelatedMemories, d.consolidation.maxRelatedMemories, 0, 48),
      minConfidence: unit(consolidation.minConfidence, d.consolidation.minConfidence),
      autoSupersede: bool(consolidation.autoSupersede, d.consolidation.autoSupersede),
      requireMultipleEvidenceForPreference: bool(
        consolidation.requireMultipleEvidenceForPreference,
        d.consolidation.requireMultipleEvidenceForPreference,
      ),
      endpoint:
        nonEmpty(consolidation.endpoint) ?? nonEmpty(env.DSH_MEMORY_SEA_CONSOLIDATION_ENDPOINT),
      apiKey:
        nonEmpty(consolidation.apiKey) ?? nonEmpty(env.DSH_MEMORY_SEA_CONSOLIDATION_API_KEY),
      model: nonEmpty(consolidation.model) ?? nonEmpty(env.DSH_MEMORY_SEA_CONSOLIDATION_MODEL),
      timeoutMs: optionalInt(consolidation.timeoutMs, 1000, 120_000),
    },
    episode: {
      idleMs: int(episode.idleMs ?? capture.episodeIdleMs, d.episode.idleMs, 60_000, 24 * 60 * 60 * 1000),
      sweepIntervalMs: int(episode.sweepIntervalMs, d.episode.sweepIntervalMs, 1_000, 60 * 60 * 1000),
    },
    pattern: {
      enabled: bool(pattern.enabled, d.pattern.enabled),
      provider: pattern.provider === 'llm' ? 'llm' : 'rule',
      minSupport: int(pattern.minSupport, d.pattern.minSupport, 2, 12),
      activationThreshold: unit(pattern.activationThreshold, d.pattern.activationThreshold),
      maxRelatedMemories: int(pattern.maxRelatedMemories, d.pattern.maxRelatedMemories, 0, 64),
      maxExistingPatterns: int(pattern.maxExistingPatterns, d.pattern.maxExistingPatterns, 0, 32),
      confidenceDecayOnContradiction: unit(
        pattern.confidenceDecayOnContradiction,
        d.pattern.confidenceDecayOnContradiction,
      ),
      endpoint:
        nonEmpty(pattern.endpoint) ??
        nonEmpty(env.DSH_MEMORY_SEA_PATTERN_ENDPOINT) ??
        nonEmpty(env.DSH_MEMORY_SEA_CONSOLIDATION_ENDPOINT),
      apiKey:
        nonEmpty(pattern.apiKey) ??
        nonEmpty(env.DSH_MEMORY_SEA_PATTERN_API_KEY) ??
        nonEmpty(env.DSH_MEMORY_SEA_CONSOLIDATION_API_KEY),
      model:
        nonEmpty(pattern.model) ??
        nonEmpty(env.DSH_MEMORY_SEA_PATTERN_MODEL) ??
        nonEmpty(env.DSH_MEMORY_SEA_CONSOLIDATION_MODEL),
      timeoutMs: optionalInt(pattern.timeoutMs, 1000, 120_000),
    },
    review: {
      enabled: bool(review.enabled, d.review.enabled),
      intervalMs: int(review.intervalMs, d.review.intervalMs, 60_000, 7 * 24 * 60 * 60 * 1000),
      memoryStaleAfterMs: int(
        review.memoryStaleAfterMs,
        d.review.memoryStaleAfterMs,
        60 * 60 * 1000,
        5 * 365 * 24 * 60 * 60 * 1000,
      ),
      patternStaleAfterMs: int(
        review.patternStaleAfterMs,
        d.review.patternStaleAfterMs,
        60 * 60 * 1000,
        5 * 365 * 24 * 60 * 60 * 1000,
      ),
      maxItemsPerRun: int(review.maxItemsPerRun, d.review.maxItemsPerRun, 1, 200),
      memoryStaleConfidence: unit(review.memoryStaleConfidence, d.review.memoryStaleConfidence),
    },
    contextualRecall: {
      enabled: bool(contextualRecall.enabled, d.contextualRecall.enabled),
      maxCandidates: int(contextualRecall.maxCandidates, d.contextualRecall.maxCandidates, 1, 20),
      weakQueryMaxLength: int(
        contextualRecall.weakQueryMaxLength,
        d.contextualRecall.weakQueryMaxLength,
        2,
        20,
      ),
      returningActorBoost: numberInRange(
        contextualRecall.returningActorBoost,
        d.contextualRecall.returningActorBoost,
        1,
        2,
      ),
      recentMemoryWindowMs: int(
        contextualRecall.recentMemoryWindowMs,
        d.contextualRecall.recentMemoryWindowMs,
        60 * 60 * 1000,
        365 * 24 * 60 * 60 * 1000,
      ),
    },
    episodeContinuity: {
      enabled: bool(episodeContinuity.enabled, d.episodeContinuity.enabled),
      lookbackMs: int(
        episodeContinuity.lookbackMs,
        d.episodeContinuity.lookbackMs,
        60 * 60 * 1000,
        365 * 24 * 60 * 60 * 1000,
      ),
      maxCandidates: int(
        episodeContinuity.maxCandidates,
        d.episodeContinuity.maxCandidates,
        1,
        30,
      ),
      minConfidence: unit(episodeContinuity.minConfidence, d.episodeContinuity.minConfidence),
      maxExpansionDepth: int(
        episodeContinuity.maxExpansionDepth,
        d.episodeContinuity.maxExpansionDepth,
        0,
        3,
      ),
    },
    skill: {
      enabled: bool(skill.enabled, d.skill.enabled),
      minSupportMemories: int(skill.minSupportMemories, d.skill.minSupportMemories, 2, 20),
      minIndependentEpisodes: int(skill.minIndependentEpisodes, d.skill.minIndependentEpisodes, 1, 20),
      minStability: unit(skill.minStability, d.skill.minStability),
      maxStepsPerDraft: int(skill.maxStepsPerDraft, d.skill.maxStepsPerDraft, 1, 20),
      minValidatedAttempts: int(skill.minValidatedAttempts, d.skill.minValidatedAttempts, 1, 20),
      minIndependentAttempts: int(
        skill.minIndependentAttempts ?? skill.minValidatedAttempts,
        d.skill.minIndependentAttempts,
        1,
        20,
      ),
      minDirectAttempts: int(skill.minDirectAttempts, d.skill.minDirectAttempts, 0, 20),
      minSuccessRateForValidated: unit(skill.minSuccessRateForValidated, d.skill.minSuccessRateForValidated),
      minReportableSamples: int(skill.minReportableSamples, d.skill.minReportableSamples, 1, 100),
      wilsonZ: numberInRange(skill.wilsonZ, d.skill.wilsonZ, 1, 3),
      minStepCoverage: unit(skill.minStepCoverage, d.skill.minStepCoverage),
      minConfidence: unit(skill.minConfidence, d.skill.minConfidence),
      allowWeakenedPatterns: bool(skill.allowWeakenedPatterns, d.skill.allowWeakenedPatterns),
    },
    operator: {
      enabled: bool(operator.enabled, d.operator.enabled),
      ...(typeof operator.tokenPath === 'string' && operator.tokenPath.trim().length > 0
        ? { tokenPath: expandHome(resolve(operator.tokenPath)) }
        : {}),
      requireLoopback: bool(operator.requireLoopback, d.operator.requireLoopback),
    },
    jobs: {
      // spec §44 命名（background.*）与 Stage 2 早期命名（jobs.*）都接受，background 优先。
      enabled: bool(background.enabled, bool(jobs.enabled, d.jobs.enabled)),
      intervalMs: int(background.pollIntervalMs ?? jobs.intervalMs, d.jobs.intervalMs, 200, 60_000),
      maxPerTick: int(background.maxJobsPerTick ?? jobs.maxPerTick, d.jobs.maxPerTick, 1, 64),
      staleMs: int(background.staleJobTimeoutMs ?? jobs.staleMs, d.jobs.staleMs, 5_000, 30 * 60 * 1000),
      maxAttempts: int(jobs.maxAttempts, d.jobs.maxAttempts, 1, 10),
    },
    scene: {
      maxPoints: int(scene.maxPoints, d.scene.maxPoints, 50, 20_000),
    },
  }
}

function resolveConfiguredScope(input: unknown): ConfiguredScope {
  if (isRecord(input)) {
    if (input.type === 'global') return { type: 'global' }
    const rootPath = nonEmpty(input.rootPath)
    return rootPath ? { type: 'project', rootPath: expandHome(resolve(rootPath)) } : { type: 'project' }
  }
  return defaultConfiguredScope()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~' + String.fromCharCode(92))) {
    return join(homedir(), path.slice(2))
  }
  return path
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, n))
}

function optionalInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.round(value)))
}

function unit(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(1, Math.max(0, n))
}

/** 给日志/状态用的作用域描述（只暴露项目名，不打印完整路径）。 */
export function describeScope(scope: MemoryScope): string {
  if (scope.type === 'global') return 'global'
  return `project:${basename(scope.rootPath ?? '') || scope.id}`
}
