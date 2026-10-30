/**
 * candidate-finder.ts —— Consolidation 的候选发现（spec §15 / §16 / §17）。
 *
 * 设计要点：
 *   - 只依赖 Scope + FTS/词法 + topics + 时间，不依赖 embedding。
 *     embedding 只作为未来增强，不是正确性依赖。
 *   - 候选数量有硬上限（默认最多 8 个相关 Episode、12 条相关 Memory），
 *     绝不把整个项目库塞给 LLM。
 *   - 纯确定性打分：同样的数据永远得到同样的候选，方便测试与复现。
 */

import type { ConsolidationContext, Episode, SemanticMemory } from '../types.js'
import type { EpisodeRepository } from '../storage/repositories/episode-repository.js'
import { EvidenceRepository } from '../memory/evidence-repository.js'
import { MemoryRepository } from '../memory/memory-repository.js'
import { bigramSimilarity, extractKeywords } from '../recall/tokenizer.js'

const DAY = 24 * 60 * 60 * 1000

export interface CandidateFinderOptions {
  maxRelatedEpisodes: number
  maxRelatedMemories: number
  /** 只看这个时间窗内的 Episode（默认 45 天），太老的经历不该被反复整理。 */
  recencyWindowMs?: number
}

export interface CandidateFinderDeps {
  episodes: EpisodeRepository
  memories: MemoryRepository
  evidence: EvidenceRepository
  now?: () => number
}

export class ConsolidationCandidateFinder {
  private readonly episodes: EpisodeRepository
  private readonly memories: MemoryRepository
  private readonly evidence: EvidenceRepository
  private readonly now: () => number

  constructor(deps: CandidateFinderDeps) {
    this.episodes = deps.episodes
    this.memories = deps.memories
    this.evidence = deps.evidence
    this.now = deps.now ?? (() => Date.now())
  }

  /** 为一个已经关闭的 Episode 构建整理上下文。 */
  buildContext(episode: Episode, options: CandidateFinderOptions): ConsolidationContext {
    const scopeId = episode.scopeId ?? 'global'
    const maxEpisodes = clampInt(options.maxRelatedEpisodes, 1, 32)
    const maxMemories = clampInt(options.maxRelatedMemories, 1, 64)
    const windowMs = options.recencyWindowMs ?? 45 * DAY
    const now = this.now()

    const relatedEpisodes = this.findRelatedEpisodes(episode, scopeId, maxEpisodes, windowMs, now)
    const relatedMemories = this.findRelatedMemories(episode, scopeId, maxMemories, relatedEpisodes)
    return { scopeId, episode, relatedEpisodes, relatedMemories }
  }

  /** 相关 Episode：话题重合 + 文本相似 + 时间接近，三条通道加权后取前 N。 */
  private findRelatedEpisodes(
    episode: Episode,
    scopeId: string,
    limit: number,
    windowMs: number,
    now: number,
  ): Episode[] {
    const anchorAt = episode.lastExperienceAt ?? episode.endedAt ?? episode.startedAt
    // 只看同一 scope 最近的 Episode，避免全表扫描（候选上限的另一半保障）。
    const pool = this.episodes.recent(scopeId, { limit: 120 })
    const scored: Array<{ episode: Episode; score: number }> = []
    const topics = new Set(episode.topics.map((topic) => topic.toLowerCase()))
    const anchorText = episodeText(episode)

    for (const candidate of pool) {
      if (candidate.id === episode.id) continue
      const candidateAt = candidate.lastExperienceAt ?? candidate.endedAt ?? candidate.startedAt
      const age = Math.abs(anchorAt - candidateAt)
      if (age > windowMs) continue

      let topicScore = 0
      if (topics.size > 0) {
        const shared = candidate.topics.filter((topic) => topics.has(topic.toLowerCase())).length
        topicScore = shared / topics.size
      }
      const textScore = bigramSimilarity(anchorText, episodeText(candidate))
      const timeScore = Math.max(0, 1 - age / windowMs)
      const score = round4(0.5 * topicScore + 0.3 * textScore + 0.2 * timeScore)
      if (score <= 0) continue
      scored.push({ episode: candidate, score })
    }

    return scored
      .sort((left, right) => right.score - left.score || left.episode.id.localeCompare(right.episode.id))
      .slice(0, limit)
      .map((row) => row.episode)
  }

  /** 相关 Memory：词法召回优先，再加上「支持了相关 Episode」的知识（证据路径）。 */
  private findRelatedMemories(
    episode: Episode,
    scopeId: string,
    limit: number,
    relatedEpisodes: readonly Episode[],
  ): SemanticMemory[] {
    const query = memoryQueryText(episode)
    const byId = new Map<string, SemanticMemory>()

    if (query.length > 0) {
      for (const hit of this.memories.searchLexical(scopeId, query, limit)) byId.set(hit.memory.id, hit.memory)
    }
    for (const related of relatedEpisodes) {
      for (const memoryId of this.evidence.listMemoryIdsByEvidence('episode', related.id)) {
        if (byId.has(memoryId)) continue
        const memory = this.memories.getById(memoryId)
        if (memory && memory.status === 'active') byId.set(memory.id, memory)
      }
    }
    // 兜底：高重要度的 active 知识也进候选（避免纯词法漏掉同义表达）。
    if (byId.size < limit) {
      for (const memory of this.memories.findActive(scopeId, limit)) {
        if (byId.size >= limit) break
        if (!byId.has(memory.id) && memory.importance >= 0.7) byId.set(memory.id, memory)
      }
    }

    return [...byId.values()]
      .sort((left, right) => right.importance - left.importance || left.id.localeCompare(right.id))
      .slice(0, limit)
  }
}

/** Episode 参与相似度比较的文本（不含运行时注入行）。 */
export function episodeText(episode: Episode): string {
  const parts = [episode.title ?? '', episode.summary ?? '', ...episode.topics]
  return parts.filter((part) => part.trim().length > 0).join(' ')
}

/** 给 Memory 词法召回用的查询串：标题 + 摘要 + 主题 + 摘要里的关键词。 */
export function memoryQueryText(episode: Episode): string {
  const seed = [episode.title ?? '', episode.summary ?? '', episode.topics.join(' ')].join(' ').trim()
  if (seed.length === 0) return ''
  return [seed, ...extractKeywords(seed, 6)].join(' ')
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
