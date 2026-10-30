/**
 * recall-engine.ts —— 召回编排（spec §11 / §3.6 / §34–§45）。
 *
 *   query
 *    ├─ Lexical Recall（Experience/Episode FTS5 + Memory FTS，失败降级 LIKE）
 *    ├─ Semantic Recall（可选通道，不可用就跳过）
 *    ├─ Temporal Recall（before / after 硬过滤 + recency 衰减）
 *    └─ Importance（对象自身的重要性）
 *         ↓
 *       Fusion（归一化权重 + 类型加成 + reasons）
 *         ↓
 *       Top N（可选展开证据：Memory→Episode、Episode→Experience）
 *
 * 这一层负责「取候选、补信号、组装理由、按需展开证据」；
 * 数学在 fusion.ts，SQL 在 repository 与 lexical-recall.ts。
 * 任何单通道异常都不允许炸掉整次 recall（spec §21）：降级、记录、继续。
 */

import type {
  Episode,
  Experience,
  MemoryLexicalHit,
  PatternLexicalHit,
  PatternMemory,
  RecallHit,
  RecallReason,
  RecallRequest,
  RecallType,
  SemanticHit,
  SemanticMemory,
  SemanticRecallProvider,
} from '../types.js'
import type { ExperienceRepository } from '../storage/repositories/experience-repository.js'
import type { EpisodeRepository } from '../storage/repositories/episode-repository.js'
import { tokenize } from './tokenizer.js'
import type { LexicalHit, LexicalRecall } from './lexical-recall.js'
import type { TemporalRecall, TemporalWindow } from './temporal-recall.js'
import { resolveWeights, fuse, type FusionCandidate, type RecallWeights, type ResolvedWeights } from './fusion.js'
import { stabilityScore } from '../pattern/pattern-lifecycle.js'
import { detectQuerySignal } from './short-query-detector.js'
import type { ContextualCandidate } from './contextual-recall.js'
import type { EpisodeRelation } from '../types.js'
import { errorMessage } from '../errors.js'

const MAX_LIMIT = 50
const DEFAULT_LANE_LIMIT = 24
const EPISODE_CONTENT_EXPERIENCES = 3
/** 展开上限：默认不把整条证据链的原文一次性倒出来（spec §38）。 */
const DEFAULT_EXPAND_LIMIT = 3

/**
 * Memory 的类型加成（spec §34–§37）。
 *
 * 只用三个可解释因子：置信度、重要性、被强化次数。
 * 上限 2.0：足以让「相关且稳定」的 Memory 排到低价值 Experience 之前，
 * 又不至于把一条 Memory 顶成永远第一。
 */
export function memoryBoost(confidence: number, importance: number, reinforcementCount: number): number {
  const c = clamp01(confidence)
  const i = clamp01(importance)
  const r = Math.min(4, Math.max(0, reinforcementCount))
  return round4(Math.min(2, 0.9 + 0.35 * c + 0.15 * i + 0.05 * r))
}

/**
 * Pattern 的类型加成（spec §38 / §40）。
 *
 * Pattern 比 Memory 更抽象：它回答的是「一直有什么倾向」，不该永远压过具体知识。
 * 所以基础加成略低于 Memory 上限，只有「模式类意图」的查询才额外放大（spec §39）。
 */
export function patternBoost(
  confidence: number,
  importance: number,
  supportCount: number,
  stability: number,
): number {
  const c = clamp01(confidence)
  const i = clamp01(importance)
  const s = clamp01(stability)
  const support = Math.min(6, Math.max(0, supportCount))
  const base = 0.85 + 0.3 * c + 0.12 * i + 0.05 * support
  return round4(Math.min(2, base * (0.9 + 0.2 * s)))
}

/** 模式类查询意图关键词（spec §39）：命中才给 Pattern 额外权重。 */
export const PATTERN_INTENT_TOKENS: readonly string[] = [
  '一直',
  '通常',
  '经常',
  '倾向',
  '习惯',
  '反复',
  '模式',
  '趋势',
  '总体',
  '一般',
  '总是',
  '往往',
  '一贯',
  '长期',
  '风格',
  '规律',
]

/** 查询是否在问「倾向/模式」，而不是问某件具体的事。 */
export function hasPatternIntent(query: string): boolean {
  const text = typeof query === 'string' ? query : ''
  return PATTERN_INTENT_TOKENS.some((token) => text.includes(token))
}

export interface MemoryRecallSource {
  searchLexical(
    scopeId: string,
    query: string,
    limit: number,
    options?: { includeSuperseded?: boolean },
  ): MemoryLexicalHit[]
  listByIds(ids: readonly string[]): SemanticMemory[]
}

/** Stage 4：Pattern 通道（描述性模式，数量远少于 Memory）。 */
export interface PatternRecallSource {
  searchLexical(
    scopeId: string,
    query: string,
    limit: number,
    options?: { includeSuperseded?: boolean },
  ): PatternLexicalHit[]
  listByIds(ids: readonly string[]): PatternMemory[]
}

export interface EvidenceRecallSource {
  listByMemory(memoryId: string): { evidenceType: string; evidenceId: string }[]
}

/** Pattern → 支持它的 Memory（证据链第二层）。 */
export interface PatternEvidenceRecallSource {
  listMemoryIds(patternId: string, relation?: 'supports' | 'contradicts', limit?: number): string[]
}

export interface RecallEngineDeps {
  experiences: ExperienceRepository
  episodes: EpisodeRepository
  lexical: Pick<LexicalRecall, 'search'>
  semantic: SemanticRecallProvider
  temporal: TemporalRecall
  weights: RecallWeights
  maxResults: number
  /** Memory 通道；缺省时只召回 Experience + Episode（Stage 2 行为）。 */
  memories?: MemoryRecallSource
  /** Pattern 通道；缺省时不召回描述性模式。 */
  patterns?: PatternRecallSource
  /** 证据链展开用；缺省时 expandEpisodes 退化为不做展开。 */
  evidence?: EvidenceRecallSource
  /** Pattern → Memory 展开用。 */
  patternEvidence?: PatternEvidenceRecallSource
  /** 是否默认展开证据（配置 recall.expandEpisodes）。 */
  expandEpisodes?: boolean
  /** 上下文召回通道（Stage 4.5）；缺省时弱查询不做上下文候选。 */
  contextual?: {
    search(scopeId: string, context: RecallRequest['context'], signal: 'normal' | 'weak' | 'empty'): ContextualCandidate[]
  }
  /** Episode 连续性关系（Stage 4.5）；缺省时不展开前后 Episode。 */
  relations?: {
    previous(scopeId: string, episodeId: string, limit?: number): EpisodeRelation[]
    next(scopeId: string, episodeId: string, limit?: number): EpisodeRelation[]
  }
  /** 弱查询判定阈值（配置 contextualRecall.weakQueryMaxLength）。 */
  weakQueryMaxLength?: number
  /** 连续性展开每方向上限（配置 episodeContinuity.maxExpansionDepth）。 */
  continuityMaxExpansion?: number
  /** 时间源（测试注入）；缺省用 Date.now —— Pattern 稳定度需要「现在」。 */
  now?: () => number
  /** 降级回调：默认打到 stderr，宿主可以接管写日志。 */
  onDegrade?: (channel: RecallChannel, error: unknown) => void
}

export type RecallChannel = 'lexical' | 'semantic' | 'memory' | 'pattern' | 'contextual'

export interface RecallEngineResult {
  hits: RecallHit[]
  /** 本次实际生效的归一化权重，方便调试「为什么这个分」。 */
  weights: ResolvedWeights
  /** 本次降级过的通道。 */
  degraded: RecallChannel[]
}

interface CandidateAccumulator {
  id: string
  type: RecallType
  lexical: number
  semantic: number | null
  /** 上下文召回给出的分数（只有弱查询时才会非 0）。 */
  contextual: number
  reasons: RecallReason[]
}

export class RecallEngine {
  private readonly deps: RecallEngineDeps

  constructor(deps: RecallEngineDeps) {
    this.deps = deps
  }

  async recall(request: RecallRequest, scopeId: string): Promise<RecallHit[]> {
    return (await this.recallDetailed(request, scopeId)).hits
  }

  async recallDetailed(request: RecallRequest, scopeId: string): Promise<RecallEngineResult> {
    const query = typeof request?.query === 'string' ? request.query.trim() : ''
    const weights = resolveWeights(this.deps.weights, this.deps.semantic.available)
    if (query.length === 0) {
      return { hits: [], weights, degraded: [] }
    }

    const limit = clampInt(request.limit ?? this.deps.maxResults, 1, MAX_LIMIT)
    const types = normalizeTypes(request.types)
    const window: TemporalWindow = { before: request.before, after: request.after }
    const hasWindow = this.deps.temporal.hasWindow(window)
    const laneLimit = Math.max(DEFAULT_LANE_LIMIT, limit * 4)
    const degraded: RecallChannel[] = []
    const wantsMemory = types.includes('memory') && this.deps.memories !== undefined
    const wantsPattern = types.includes('pattern') && this.deps.patterns !== undefined
    const patternIntent = hasPatternIntent(query)

    // ---- 1. 关键词通道：Experience/Episode FTS5（内部自带 LIKE 降级）----
    let lexicalHits: LexicalHit[] = []
    const lexicalTypes = types.filter((type): type is 'experience' | 'episode' => type !== 'memory')
    if (lexicalTypes.length > 0) {
      try {
        lexicalHits = this.deps.lexical.search(query, {
          scopeId,
          types: lexicalTypes,
          limit: laneLimit,
          after: request.after,
          before: request.before,
        })
      } catch (error) {
        degraded.push('lexical')
        this.degrade('lexical', error)
      }
    }

    // ---- 2. Memory 关键词通道：memories_fts（失败降级 LIKE，已在 repository 内处理）----
    let memoryHits: MemoryLexicalHit[] = []
    if (wantsMemory) {
      try {
        memoryHits = this.deps.memories!.searchLexical(scopeId, query, laneLimit, {
          includeSuperseded: request.includeSuperseded === true,
        })
      } catch (error) {
        degraded.push('memory')
        this.degrade('memory', error)
      }
    }

    // ---- 3. Pattern 关键词通道：patterns_fts（失败降级 LIKE，已在 repository 内处理）----
    let patternHits: PatternLexicalHit[] = []
    if (wantsPattern) {
      try {
        patternHits = this.deps.patterns!.searchLexical(scopeId, query, laneLimit, {
          includeSuperseded: request.includeSuperseded === true,
        })
      } catch (error) {
        degraded.push('pattern')
        this.degrade('pattern', error)
      }
    }

    // ---- 4. 语义通道：provider 不可用就整个跳过（不是错误）----
    let semanticHits: SemanticHit[] = []
    if (this.deps.semantic.available) {
      try {
        semanticHits = filterSemanticTypes(
          await this.deps.semantic.search(scopeId, query, laneLimit),
          types,
        )
      } catch (error) {
        degraded.push('semantic')
        this.degrade('semantic', error)
      }
    }

    // ---- 4b. 上下文通道（Stage 4.5）：只在「弱查询 + 有上下文」时启用 ----
    // 弱查询不解释、不改写 query；它只是换一个候选来源（谁在问、最近发生了什么）。
    const contextSignal = detectQuerySignal(query, {
      weakQueryMaxLength: this.deps.weakQueryMaxLength ?? 6,
    })
    let contextualHits: ContextualCandidate[] = []
    if (this.deps.contextual && request.context && contextSignal.signal === 'weak') {
      try {
        contextualHits = this.deps.contextual.search(scopeId, request.context, contextSignal.signal)
      } catch (error) {
        degraded.push('contextual')
        this.degrade('contextual', error)
      }
    }

    // ---- 5. 合并候选：id+type 去重，同一对象多路命中取各通道最大值 ----
    const accumulators = new Map<string, CandidateAccumulator>()
    const keyOf = (type: RecallType, id: string) => `${type}:${id}`

    for (const hit of lexicalHits) {
      const key = keyOf(hit.type, hit.id)
      const existing = accumulators.get(key)
      if (existing) {
        existing.lexical = Math.max(existing.lexical, hit.score)
      } else {
        accumulators.set(key, { id: hit.id, type: hit.type, lexical: hit.score, semantic: null, contextual: 0, reasons: [] })
      }
    }
    for (const hit of memoryHits) {
      const key = keyOf('memory', hit.memory.id)
      const existing = accumulators.get(key)
      if (existing) {
        existing.lexical = Math.max(existing.lexical, hit.score)
      } else {
        accumulators.set(key, { id: hit.memory.id, type: 'memory', lexical: hit.score, semantic: null, contextual: 0, reasons: [] })
      }
    }
    for (const hit of patternHits) {
      const key = keyOf('pattern', hit.pattern.id)
      const existing = accumulators.get(key)
      if (existing) {
        existing.lexical = Math.max(existing.lexical, hit.score)
      } else {
        accumulators.set(key, { id: hit.pattern.id, type: 'pattern', lexical: hit.score, semantic: null, contextual: 0, reasons: [] })
      }
    }
    for (const hit of semanticHits) {
      const key = keyOf(hit.type, hit.id)
      const existing = accumulators.get(key)
      if (existing) {
        existing.semantic = Math.max(existing.semantic ?? 0, hit.score)
      } else {
        accumulators.set(key, { id: hit.id, type: hit.type, lexical: 0, semantic: hit.score, contextual: 0, reasons: [] })
      }
    }
    for (const hit of contextualHits) {
      const key = keyOf(hit.type, hit.id)
      const existing = accumulators.get(key)
      if (existing) {
        existing.contextual = Math.max(existing.contextual, hit.score)
        if (!existing.reasons.some((reason) => reason.type === hit.reason.type)) existing.reasons.push(hit.reason)
      } else {
        accumulators.set(key, {
          id: hit.id,
          type: hit.type,
          lexical: 0,
          semantic: null,
          contextual: hit.score,
          reasons: [hit.reason],
        })
      }
    }
    if (accumulators.size === 0) return { hits: [], weights, degraded }

    // ---- 6. 载入对象本体（一次批量查询，避免 N+1）----
    const experienceIds: string[] = []
    const episodeIds: string[] = []
    const memoryIds: string[] = []
    const patternIds: string[] = []
    for (const acc of accumulators.values()) {
      if (acc.type === 'experience') experienceIds.push(acc.id)
      else if (acc.type === 'episode') episodeIds.push(acc.id)
      else if (acc.type === 'pattern') patternIds.push(acc.id)
      else memoryIds.push(acc.id)
    }
    const experiences = new Map<string, Experience>(
      this.deps.experiences.listByIds(experienceIds).map((item) => [item.id, item]),
    )
    const episodes = new Map<string, Episode>(
      this.deps.episodes.listByIds(episodeIds).map((item) => [item.id, item]),
    )
    const memories = new Map<string, SemanticMemory>(
      memoryIds.length > 0 && this.deps.memories
        ? this.deps.memories.listByIds(memoryIds).map((item) => [item.id, item])
        : [],
    )
    const patterns = new Map<string, PatternMemory>(
      patternIds.length > 0 && this.deps.patterns
        ? this.deps.patterns.listByIds(patternIds).map((item) => [item.id, item])
        : [],
    )

    // Episode 可能还没有 summary：用其前几条 Experience 文本作为可读内容与关键词依据。
    const episodeSampleIds = new Set<string>()
    for (const episode of episodes.values()) {
      for (const id of episode.experienceIds.slice(0, EPISODE_CONTENT_EXPERIENCES)) episodeSampleIds.add(id)
    }
    for (const id of experiences.keys()) episodeSampleIds.delete(id)
    const episodeSamples = new Map<string, Experience>(
      this.deps.experiences.listByIds([...episodeSampleIds]).map((item) => [item.id, item]),
    )

    // ---- 6. 补时间/重要性/会话/置信度信号，组装 reasons ----
    const candidates: FusionCandidate[] = []
    for (const acc of accumulators.values()) {
      const base = this.baseOf(acc, experiences, episodes, episodeSamples, memories, patterns)
      if (!base) continue
      const { content, at, importance, sessionId, intervalEnd, boost, memory, pattern, stability, createdAt } = base
      // 模式类查询（"我们架构上一直有什么倾向"）才额外放大 Pattern；具体问题不该被模式压过去（spec §38）。
      const candidateBoost = round4(Math.min(2.5, boost * (pattern && patternIntent ? 1.3 : 1)))
      if (hasWindow && !this.matchesWindow(at, intervalEnd, window)) continue

      const temporalSignal = this.deps.temporal.evaluate(at, window)
      const recency = this.deps.temporal.recencyScore(at)
      const reasons: RecallReason[] = [...acc.reasons]

      if (acc.lexical > 0) {
        reasons.push({
          type: 'keyword',
          score: round4(acc.lexical),
          detail: `关键词命中：${this.matchedKeywords(query, content).join('、')}`,
        })
      }
      if (acc.semantic !== null) {
        reasons.push({ type: 'semantic', score: round4(acc.semantic), detail: '语义相近' })
      }
      if (hasWindow) {
        reasons.push({
          type: 'temporal',
          score: round4(temporalSignal.score),
          detail: temporalSignal.detail ?? '落在请求时间范围内',
        })
      } else {
        reasons.push({
          type: 'temporal',
          score: round4(recency),
          detail: this.deps.temporal.describeAge(at),
        })
      }
      reasons.push({
        type: 'importance',
        score: round4(importance),
        detail: `重要性 ${round4(importance).toFixed(2)}`,
      })
      if (memory) {
        reasons.push({
          type: 'confidence',
          score: round4(memory.confidence),
          detail: `置信度 ${round4(memory.confidence).toFixed(2)}`,
        })
        reasons.push({
          type: 'reinforcement',
          score: round4(Math.min(1, memory.reinforcementCount / 5)),
          detail:
            memory.reinforcementCount > 0
              ? `已被 ${memory.reinforcementCount} 次整理强化`
              : '尚未被强化（首次形成）',
        })
      }
      if (pattern) {
        reasons.push({
          type: 'confidence',
          score: round4(pattern.confidence),
          detail: `置信度 ${round4(pattern.confidence).toFixed(2)}`,
        })
        reasons.push({
          type: 'support',
          score: round4(Math.min(1, pattern.supportCount / 5)),
          detail: `由 ${pattern.supportCount} 条长期知识支持`,
        })
        reasons.push({
          type: 'stability',
          score: round4(stability),
          detail: `稳定度 ${round4(stability).toFixed(2)}（支持越多、跨度越长越稳，反证越多越弱）`,
        })
      }
      if (request.sessionId && sessionId && sessionId === request.sessionId) {
        reasons.push({ type: 'session', detail: '同一次会话内产生' })
      }

      candidates.push({
        id: acc.id,
        type: acc.type,
        content,
        createdAt,
        importance,
        signals: {
          // 弱查询下上下文候选按相关性顶到最前；normal 查询 contextual 恒为 0，不影响原有排序。
          lexical: Math.max(acc.lexical, acc.contextual),
          semantic: acc.semantic,
          temporal: temporalSignal.score,
          importance,
          recency,
        },
        reasons,
        boost: candidateBoost,
      })
    }

    const hits = fuse(candidates, weights, limit)
    return { hits: this.expandHits(hits, request, scopeId), weights, degraded }
  }

  /**
   * 证据链展开（spec §38 / §44）：
   *   Memory → 支持它的 Episode；Episode → 它的 Experience。
   * 只展开一层、有上限，避免一次 recall 把整库原文倒出来。
   */
  private expandHits(hits: RecallHit[], request: RecallRequest, scopeId: string): RecallHit[] {
    const expandEvidence = request.expandEpisodes ?? this.deps.expandEpisodes ?? false
    const expandContinuity = request.expandContinuity === true && this.deps.relations !== undefined
    if (!expandEvidence && !expandContinuity) return hits

    return hits.map((hit) => {
      const parts: RecallHit[] = []
      if (expandEvidence) parts.push(...this.expandOne(hit))
      if (expandContinuity && hit.type === 'episode') parts.push(...this.expandContinuity(hit, scopeId))
      return parts.length > 0 ? { ...hit, expanded: parts } : hit
    })
  }

  /**
   * Episode 连续性展开（Stage 4.5）：命中一段经历时，把它前后相连的经历也带出来。
   * 只读 relation，不改写任何 Episode（relation 永远不是 evidence）。
   */
  private expandContinuity(hit: RecallHit, scopeId: string): RecallHit[] {
    const relations = this.deps.relations
    if (!relations) return []
    const limit = Math.max(1, Math.min(3, this.deps.continuityMaxExpansion ?? 2))
    const previous = relations.previous(scopeId, hit.id, limit)
    const next = relations.next(scopeId, hit.id, limit)
    const neighbors = new Map<string, EpisodeRelation>()
    for (const relation of previous) neighbors.set(relation.sourceEpisodeId, relation)
    for (const relation of next) neighbors.set(relation.targetEpisodeId, relation)
    if (neighbors.size === 0) return []
    const episodes = this.deps.episodes.listByIds([...neighbors.keys()])
    const out: RecallHit[] = []
    for (const episode of episodes) {
      const relation = neighbors.get(episode.id)
      if (!relation) continue
      const content = contentOfEpisode(episode)
      out.push({
        id: episode.id,
        type: 'episode',
        content,
        score: round4(Math.max(0.05, hit.score * 0.85)),
        createdAt: episode.endedAt ?? episode.lastExperienceAt ?? episode.startedAt,
        reasons: [
          {
            type: 'continuation',
            score: round4(relation.confidence),
            detail: `连续性关系 ${relation.relation}${relation.reason ? `：${relation.reason}` : ''}`,
          },
        ],
      })
    }
    out.sort((left, right) => left.createdAt - right.createdAt)
    return out
  }

  private expandOne(hit: RecallHit): RecallHit[] {
    if (hit.type === 'memory') {
      const evidence = this.deps.evidence
      if (!evidence) return []
      const episodeIds = uniqueStrings(
        evidence
          .listByMemory(hit.id)
          .filter((item) => item.evidenceType === 'episode')
          .map((item) => item.evidenceId),
      ).slice(0, DEFAULT_EXPAND_LIMIT)
      if (episodeIds.length === 0) return []
      return this.deps.episodes
        .listByIds(episodeIds)
        .map((episode) => this.expandedHit('episode', episode.id, this.episodeLabel(episode), episode.createdAt, hit, 'Memory 的证据 Episode'))
    }
    if (hit.type === 'pattern') {
      // Pattern → 支持它的 Memory（≤3）→ 每个 Memory 的证据 Episode（每条 ≤2，总计 ≤4）（spec §41）。
      const patternEvidence = this.deps.patternEvidence
      if (!patternEvidence) return []
      const memoryIds = uniqueStrings(patternEvidence.listMemoryIds(hit.id, 'supports', 8)).slice(
        0,
        DEFAULT_EXPAND_LIMIT,
      )
      if (memoryIds.length === 0) return []
      const memories = this.deps.memories ? this.deps.memories.listByIds(memoryIds) : []
      const expanded: RecallHit[] = memories.map((memory) =>
        this.expandedHit('memory', memory.id, memory.content, memory.createdAt, hit, 'Pattern 的支持知识'),
      )
      const evidence = this.deps.evidence
      if (!evidence) return expanded
      let episodeBudget = 4
      for (const memory of memories) {
        if (episodeBudget <= 0) break
        const episodeIds = uniqueStrings(
          evidence
            .listByMemory(memory.id)
            .filter((item) => item.evidenceType === 'episode')
            .map((item) => item.evidenceId),
        ).slice(0, 2)
        if (episodeIds.length === 0) continue
        for (const episode of this.deps.episodes.listByIds(episodeIds)) {
          if (episodeBudget <= 0) break
          episodeBudget -= 1
          expanded.push(
            this.expandedHit(
              'episode',
              episode.id,
              this.episodeLabel(episode),
              episode.createdAt,
              hit,
              'Pattern 支持知识的证据 Episode',
            ),
          )
        }
      }
      return expanded
    }
    if (hit.type === 'episode') {
      const experiences = this.deps.experiences.listByEpisode(hit.id).slice(0, DEFAULT_EXPAND_LIMIT)
      return experiences.map((experience) =>
        this.expandedHit(
          'experience',
          experience.id,
          experience.content,
          experience.observedAt || experience.createdAt,
          hit,
          'Episode 的原始 Experience',
        ),
      )
    }
    return []
  }

  private expandedHit(
    type: RecallType,
    id: string,
    content: string,
    createdAt: number,
    parent: RecallHit,
    detail: string,
  ): RecallHit {
    return {
      id,
      type,
      content,
      // 展开项不是独立命中：分数只用于前端排序，明确低于父结果。
      score: round4(parent.score * 0.9),
      createdAt,
      reasons: [
        { type: 'importance', score: round4(parent.score), detail },
        { type: 'keyword', detail: `来自命中 ${parent.id}` },
      ],
    }
  }

  private episodeLabel(episode: Episode): string {
    const title = typeof episode.title === 'string' ? episode.title.trim() : ''
    return title.length > 0 ? title : episode.id
  }

  private baseOf(
    acc: CandidateAccumulator,
    experiences: Map<string, Experience>,
    episodes: Map<string, Episode>,
    episodeSamples: Map<string, Experience>,
    memories: Map<string, SemanticMemory>,
    patterns: Map<string, PatternMemory>,
  ): {
    content: string
    at: number
    importance: number
    sessionId?: string
    intervalEnd: number
    createdAt: number
    boost: number
    memory?: SemanticMemory
    pattern?: PatternMemory
    stability: number
  } | null {
    if (acc.type === 'experience') {
      const experience = experiences.get(acc.id)
      if (!experience) return null
      const at = experience.observedAt || experience.createdAt
      return {
        content: experience.content,
        at,
        importance: experience.importance,
        sessionId: experience.sessionId,
        intervalEnd: at,
        createdAt: experience.createdAt,
        boost: 1,
        stability: 0,
      }
    }
    if (acc.type === 'memory') {
      const memory = memories.get(acc.id)
      if (!memory) return null
      // validFrom 用事件时间（Episode 时间），不是整理作业的执行时间（spec §56）。
      const at = memory.validFrom ?? memory.createdAt
      return {
        content: memory.content,
        at,
        importance: memory.importance,
        intervalEnd: memory.validUntil ?? at,
        createdAt: memory.createdAt,
        boost: memoryBoost(memory.confidence, memory.importance, memory.reinforcementCount),
        memory,
        stability: 0,
      }
    }
    if (acc.type === 'pattern') {
      const pattern = patterns.get(acc.id)
      if (!pattern) return null
      const stability = stabilityScore(pattern, (this.deps.now ?? Date.now)())
      // 时间用模式最后被观察到的时刻：模式不是「发生了一次」，而是「一直如此」。
      const at = pattern.lastObservedAt || pattern.createdAt
      return {
        content: pattern.content,
        at,
        importance: pattern.importance,
        intervalEnd: at,
        createdAt: pattern.createdAt,
        boost: patternBoost(pattern.confidence, pattern.importance, pattern.supportCount, stability),
        pattern,
        stability,
      }
    }
    const episode = episodes.get(acc.id)
    if (!episode) return null
    const content = this.episodeContent(episode, episodeSamples, experiences)
    return {
      content: content.trim().length > 0 ? content : (episode.title ?? episode.id),
      at: episode.startedAt,
      importance: episode.importance,
      intervalEnd: episode.endedAt ?? episode.startedAt,
      createdAt: episode.createdAt,
      boost: 1,
      stability: 0,
    }
  }

  /** Experience 是时间点；Episode 是区间，所以窗口用区间相交判定。 */
  private matchesWindow(at: number, intervalEnd: number, window: TemporalWindow): boolean {
    const end = Math.max(at, intervalEnd)
    if (typeof window.after === 'number' && end <= window.after) return false
    if (typeof window.before === 'number' && at >= window.before) return false
    return true
  }

  private degrade(channel: RecallChannel, error: unknown): void {
    if (this.deps.onDegrade) {
      this.deps.onDegrade(channel, error)
      return
    }
    console.error(`[memory-sea] ${channel} 通道失败，已降级：${errorMessage(error)}`)
  }

  /**
   * Episode 的可读文本：有 summary 用 summary；否则标题 + 前几条经历原文。
   * 跳过与标题重复、以及彼此重复的行 —— 单条经历时标题和正文常常是同一句。
   */
  private episodeContent(
    episode: Episode,
    samples: Map<string, Experience>,
    loaded: Map<string, Experience>,
  ): string {
    const summary = typeof episode.summary === 'string' ? episode.summary.trim() : ''
    if (summary.length > 0) return summary
    const title = typeof episode.title === 'string' ? episode.title.trim() : ''
    const lines: string[] = []
    if (title.length > 0) lines.push(title)
    for (const id of episode.experienceIds.slice(0, EPISODE_CONTENT_EXPERIENCES)) {
      const experience = loaded.get(id) ?? samples.get(id)
      if (!experience) continue
      const text = experience.content.trim()
      if (text.length === 0) continue
      if (lines.includes(text)) continue
      lines.push(text)
    }
    return lines.join(String.fromCharCode(10))
  }

  /** 理由里的「关键词命中：a、b」——取查询与内容共有的词，去重后按出现顺序。 */
  private matchedKeywords(query: string, content: string): string[] {
    const queryTokens = new Set(tokenize(query))
    const matched: string[] = []
    const seen = new Set<string>()
    for (const token of tokenize(content)) {
      if (token.length < 2) continue
      if (!queryTokens.has(token)) continue
      if (seen.has(token)) continue
      seen.add(token)
      matched.push(token)
      if (matched.length >= 3) break
    }
    if (matched.length === 0) return [query.slice(0, 12)]
    return matched
  }
}

// ------------------------------------------------------------------ 内部

/** 缺省召回全部对象：Experience/Episode 是证据层，Memory 是知识，Pattern 是长期模式（spec §37）。 */
function normalizeTypes(types: RecallType[] | undefined): RecallType[] {
  const allowed = new Set<RecallType>(['experience', 'episode', 'memory', 'pattern'])
  const requested = Array.isArray(types) ? types.filter((type) => allowed.has(type)) : []
  return requested.length > 0
    ? (uniqueStrings(requested) as RecallType[])
    : ['experience', 'episode', 'memory', 'pattern']
}

function filterSemanticTypes(hits: SemanticHit[], types: readonly RecallType[]): SemanticHit[] {
  const allowed = new Set(types)
  return hits.filter((hit) => allowed.has(hit.type))
}

function uniqueStrings<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function contentOfEpisode(episode: Episode): string {
  const summary = typeof episode.summary === 'string' ? episode.summary.trim() : ''
  if (summary.length > 0) return summary
  const title = typeof episode.title === 'string' ? episode.title.trim() : ''
  return title.length > 0 ? title : '（无摘要 Episode）'
}
