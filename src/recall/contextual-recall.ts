/**
 * contextual-recall.ts —— 上下文召回通道（Stage 4.5）。
 *
 * 它不根据 query 文本检索，而是根据「谁在问、是不是回访、最近发生了什么」
 * 从当前 scope 里取少量候选（spec §7 / §8）。因此它**只在弱查询时启用**：
 * 正常问题仍然以 lexical / semantic / memory / pattern 为主（spec §12）。
 *
 * 两条铁律：
 *   - Context is not query rewriting：这里不解释、不改写用户那句话。
 *   - Actor context is not permission to cross scope：scopeId 永远是硬过滤条件（spec §44）。
 */

import type {
  Episode,
  Experience,
  MemoryQuery,
  RecallContext,
  RecallReason,
  SemanticMemory,
} from '../types.js'
import { allowsContextualRecall } from './short-query-detector.js'
import type { QuerySignal } from '../types.js'

/** 未来计划 / 待续话题的措辞：这类记忆更适合在回访场景被想起（spec §11）。 */
const CONTINUATION_MARKERS: readonly string[] = [
  '下周',
  '下个月',
  '明天',
  '后天',
  '这周',
  '本周',
  '月底',
  '准备',
  '打算',
  '计划',
  '即将',
  '我要',
  '会去',
  '考试',
  '复试',
  '面试',
  '出差',
  '发布',
  '上线',
  '提交',
  '报名',
]

/** 说明「这件事还悬着」的措辞。 */
const UNRESOLVED_MARKERS: readonly string[] = ['还没', '没有', '未', '待', '等结果', '不知道', '不确定']

export interface ContextualRecallSettings {
  /** 一次最多给几个候选（默认 5，spec §55）。 */
  maxCandidates: number
  /** 回访参与者的加成倍数。 */
  returningActorBoost: number
  /** 近因衰减窗口：超过这个窗口的记忆逐渐降权。 */
  recentMemoryWindowMs: number
}

export interface ContextualRecallDeps {
  memories: {
    list(scopeId: string, query?: MemoryQuery): SemanticMemory[]
  }
  episodes: {
    listByIds(ids: readonly string[]): Episode[]
    recent(scopeId: string, options?: { limit?: number }): Episode[]
  }
  experiences: {
    listByIds(ids: readonly string[]): Experience[]
  }
  evidence: {
    listByMemory(memoryId: string): { evidenceType: string; evidenceId: string }[]
  }
  now: () => number
  settings: ContextualRecallSettings
}

export interface ContextualCandidate {
  id: string
  type: 'memory' | 'episode'
  score: number
  reason: RecallReason
}

interface Scored {
  candidate: ContextualCandidate
  createdAt: number
}

export class ContextualRecall {
  private readonly deps: ContextualRecallDeps

  constructor(deps: ContextualRecallDeps) {
    this.deps = deps
  }

  /**
   * 返回上下文候选（已按分数从高到低排序、已截断）。
   * 没有任何可用上下文时返回空数组 —— 绝不在无上下文时随机召回「最重要的记忆」（spec §43）。
   */
  search(scopeId: string, context: RecallContext | undefined, signal: QuerySignal): ContextualCandidate[] {
    if (!context) return []
    if (!allowsContextualRecall(signal)) return []
    const hasActor = typeof context.actorId === 'string' && context.actorId.length > 0
    const explicit = uniqueStrings([
      ...(context.recentMemoryIds ?? []),
      ...(context.recentEntityIds ?? []),
    ])
    if (!hasActor && explicit.length === 0) return []
    // 只有「回访」或「上层明确给出近期对象」才允许从上下文里捞记忆：
    // 一个陌生人的「你好」不应该把整个 scope 的重要记忆顶出来。
    if (context.returningActor !== true && explicit.length === 0) return []

    const limit = Math.max(1, Math.round(this.deps.settings.maxCandidates))
    const now = this.deps.now()
    const scored: Scored[] = []

    for (const candidate of this.memoryCandidates(scopeId, context, explicit, limit)) {
      const score = candidate.score
      if (score <= 0.04) continue
      scored.push({ candidate: { ...candidate, score: round4(score) }, createdAt: candidate.createdAt })
    }
    for (const candidate of this.episodeCandidates(scopeId, context, limit)) {
      if (candidate.score <= 0.04) continue
      scored.push({ candidate: { ...candidate, score: round4(candidate.score) }, createdAt: candidate.createdAt })
    }

    scored.sort((left, right) => right.candidate.score - left.candidate.score)
    const chosen: ContextualCandidate[] = []
    const seen = new Set<string>()
    for (const item of scored) {
      const key = `${item.candidate.type}:${item.candidate.id}`
      if (seen.has(key)) continue
      seen.add(key)
      chosen.push(item.candidate)
      if (chosen.length >= limit) break
    }
    return chosen
  }

  private *memoryCandidates(
    scopeId: string,
    context: RecallContext,
    explicit: readonly string[],
    limit: number,
  ): Generator<ContextualCandidate & { createdAt: number }> {
    let memories: SemanticMemory[] = []
    try {
      memories = this.deps.memories.list(scopeId, { status: 'active', limit: Math.max(8, limit * 4) })
    } catch {
      return
    }
    const actorId = context.actorId
    for (const memory of memories) {
      const explicitHit = explicit.includes(memory.id)
      let actorHit = false
      if (actorId) actorHit = this.memoryHasActor(memory, actorId)
      if (!explicitHit && !actorHit) continue

      const text = `${memory.subject ?? ''} ${memory.content}`
      const continuation = looksUnfinished(text)
      const recency = this.recencyFactor(memory.lastReinforcedAt ?? memory.updatedAt ?? memory.createdAt)
      const interaction = interactionBoost(context)
      const returning = context.returningActor === true ? this.deps.settings.returningActorBoost : 1
      const base = clamp01(memory.importance) * clamp01(memory.confidence)
      const boost = returning * interaction * (continuation ? 1.25 : 1)
      const score = clamp01((base * recency * boost) / 1.35)
      if (score <= 0.04) continue

      const reasonType = continuation ? 'continuation' : 'context'
      const detail = continuation
        ? 'returning actor 的近期未完成计划'
        : 'returning actor 的近期重要记忆'
      yield {
        id: memory.id,
        type: 'memory',
        score,
        createdAt: memory.createdAt,
        reason: { type: reasonType, score: round4(score), detail },
      }
    }
  }

  private *episodeCandidates(
    scopeId: string,
    context: RecallContext,
    limit: number,
  ): Generator<ContextualCandidate & { createdAt: number }> {
    const actorId = context.actorId
    if (!actorId) return
    let episodes: Episode[] = []
    try {
      episodes = this.deps.episodes.recent(scopeId, { limit: Math.max(6, limit * 2) })
    } catch {
      return
    }
    for (const episode of episodes) {
      if (episode.status === 'open') continue
      if (!this.episodeHasActor(episode, actorId)) continue
      const at = episode.endedAt ?? episode.lastExperienceAt ?? episode.startedAt
      const recency = this.recencyFactor(at)
      const interaction = interactionBoost(context)
      const returning = context.returningActor === true ? this.deps.settings.returningActorBoost : 1
      // Episode 只作为弱候选：具体知识 Memory 才是回访场景的主角（spec §45 / §47）。
      const score = clamp01((clamp01(episode.importance) * recency * interaction * returning) / 2.4)
      if (score <= 0.04) continue
      yield {
        id: episode.id,
        type: 'episode',
        score,
        createdAt: episode.createdAt,
        reason: {
          type: 'context',
          score: round4(score),
          detail: 'returning actor 的近期经历片段',
        },
      }
    }
  }

  private memoryHasActor(memory: SemanticMemory, actorId: string): boolean {
    let evidence: { evidenceType: string; evidenceId: string }[] = []
    try {
      evidence = this.deps.evidence.listByMemory(memory.id)
    } catch {
      return false
    }
    const episodeIds = evidence
      .filter((item) => item.evidenceType === 'episode')
      .map((item) => item.evidenceId)
    if (episodeIds.length === 0) return false
    return this.deps.episodes
      .listByIds(episodeIds.slice(0, 3))
      .some((episode) => this.episodeHasActor(episode, actorId))
  }

  private episodeHasActor(episode: Episode, actorId: string): boolean {
    const experienceIds = episode.experienceIds.slice(0, 5)
    if (experienceIds.length === 0) return false
    try {
      return this.deps.experiences
        .listByIds(experienceIds)
        .some((experience) => experience.metadata?.actorId === actorId)
    } catch {
      return false
    }
  }

  private recencyFactor(at: number): number {
    const window = Math.max(60_000, this.deps.settings.recentMemoryWindowMs)
    const age = Math.max(0, this.deps.now() - at)
    // 0.5 ~ 1.0：刚强化过的记忆更该被想起；很久以前的仍然不消失，只是不占前排。
    return 0.5 + 0.5 * Math.exp(-age / window)
  }
}

function interactionBoost(context: RecallContext): number {
  switch (context.interactionType) {
    case 'greeting':
      return 1.1
    case 'followup':
      return 1.2
    case 'question':
      return 1.05
    default:
      return 1
  }
}

/** 文本里出现未来计划 / 未完成措辞 → 这条知识有较高的继续潜力（spec §11）。 */
export function looksUnfinished(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false
  const planned = CONTINUATION_MARKERS.some((marker) => text.includes(marker))
  const unresolved = UNRESOLVED_MARKERS.some((marker) => text.includes(marker))
  return planned || unresolved
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))]
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
