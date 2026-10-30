/**
 * candidate-finder.ts —— 为「新 Episode 是否延续旧 Episode」准备确定性候选（Stage 4.5）。
 *
 * 流程：Episode close + summary ready → 同 scope 近期 Episode（lookback 内、按时间倒序）
 * → 提取每条的 actor / thread / topic / token / 文本特征 → 交给 analyzer 判定关系。
 *
 * 这里不做任何 LLM 调用，也不改写 Episode 内容（spec §21 / §22）。
 */

import type { Episode, Experience } from '../types.js'
import { knownActorIds, normalizeActorIdentity, strongActorIds } from './actor-identity.js'
import { bigramSimilarity, tokenize } from '../recall/tokenizer.js'

export interface ContinuityCandidateFinderDeps {
  episodes: {
    recent(scopeId: string, options?: { limit?: number }): Episode[]
  }
  experiences: {
    listByEpisode(episodeId: string): Experience[]
  }
  now: () => number
}

export interface EpisodeProfile {
  episode: Episode
  /** 所有可用身份（强 + 弱），用于 same_thread 级别的弱关联。 */
  actorIds: string[]
  /** 只含强身份（actorId / platformUserId）；continues/followup 必须基于它。 */
  strongActorIds: string[]
  /** 该 Episode 的身份证据强度：high 才允许判定「延续」。 */
  actorConfidence: 'high' | 'medium' | 'none'
  threadKeys: string[]
  topics: string[]
  tokens: string[]
  text: string
}

export interface ContinuityCandidate {
  profile: EpisodeProfile
  /** 与触发 Episode 的时间间隔（毫秒，非负）。 */
  gapMs: number
  /** 文本相似度（0..1），确定性的 bigram 相似度。 */
  similarity: number
}

export interface ContinuityContext {
  scopeId: string
  trigger: EpisodeProfile
  candidates: ContinuityCandidate[]
}

export interface ContinuityFinderOptions {
  lookbackMs?: number
  maxCandidates?: number
  /** 每个 Episode 最多读取多少条 Experience 做特征提取。 */
  maxExperiencesPerEpisode?: number
}

const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_MAX_CANDIDATES = 10
const DEFAULT_MAX_EXPERIENCES = 6
const MAX_TEXT_CHARS = 600

export class ContinuityCandidateFinder {
  private readonly deps: ContinuityCandidateFinderDeps

  constructor(deps: ContinuityCandidateFinderDeps) {
    this.deps = deps
  }

  build(scopeId: string, episode: Episode, options: ContinuityFinderOptions = {}): ContinuityContext {
    const lookbackMs = Math.max(1, options.lookbackMs ?? DEFAULT_LOOKBACK_MS)
    const maxCandidates = Math.max(1, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES)
    const maxExperiences = Math.max(1, options.maxExperiencesPerEpisode ?? DEFAULT_MAX_EXPERIENCES)
    const now = this.deps.now()
    const anchor = episodeAnchor(episode)
    const trigger = this.profileOf(episode, maxExperiences)

    // 多取一些以补偿过滤开销；最终只保留 lookback 内、且不是自己的 Episode。
    const pool = this.deps.episodes.recent(scopeId, { limit: Math.max(12, maxCandidates * 3) })
    const candidates: ContinuityCandidate[] = []
    for (const candidate of pool) {
      if (candidate.id === episode.id) continue
      if (candidate.status === 'open') continue
      const at = episodeAnchor(candidate)
      if (!Number.isFinite(at)) continue
      if (anchor - at > lookbackMs) continue
      const profile = this.profileOf(candidate, maxExperiences)
      candidates.push({
        profile,
        gapMs: Math.max(0, anchor - at),
        similarity: round4(bigramSimilarity(trigger.text, profile.text, MAX_TEXT_CHARS)),
      })
    }
    candidates.sort((left, right) => left.gapMs - right.gapMs)
    return {
      scopeId,
      trigger,
      candidates: candidates.slice(0, maxCandidates),
    }
  }

  /** 只把特征提到外部分析器，不在这里决定关系。 */
  profile(episode: Episode, options: { maxExperiencesPerEpisode?: number } = {}): EpisodeProfile {
    return this.profileOf(episode, Math.max(1, options.maxExperiencesPerEpisode ?? DEFAULT_MAX_EXPERIENCES))
  }

  private profileOf(episode: Episode, maxExperiences: number): EpisodeProfile {
    let experiences: Experience[] = []
    try {
      experiences = this.deps.experiences.listByEpisode(episode.id)
    } catch {
      experiences = []
    }
    const trimmed = experiences.slice(0, maxExperiences)
    const actorIds = new Set<string>()
    const strong = new Set<string>()
    const threadKeys = new Set<string>()
    for (const experience of experiences) {
      const metadata = experience.metadata ?? {}
      // 身份规范化统一走 actor-identity：昵称不参与，平台稳定 ID 优先。
      for (const actorId of knownActorIds(metadata)) actorIds.add(actorId)
      for (const actorId of strongActorIds(metadata)) strong.add(actorId)
      if (normalizeActorIdentity(metadata) === null && typeof metadata.actorId === 'string') {
        actorIds.add(metadata.actorId)
      }
      const threadKey = metadata.threadKey
      if (typeof threadKey === 'string' && threadKey.length > 0) threadKeys.add(threadKey)
    }
    const pieces: string[] = []
    if (episode.title) pieces.push(episode.title)
    if (episode.summary) pieces.push(episode.summary)
    for (const experience of trimmed) {
      if (typeof experience.content === 'string' && experience.content.length > 0) {
        pieces.push(experience.content)
      }
    }
    const text = pieces.join(' ').slice(0, MAX_TEXT_CHARS)
    const topics = [...new Set([...(episode.topics ?? []), ...tokenize(text).slice(0, 12)])]
    const actorConfidence = strong.size > 0 ? 'high' : actorIds.size > 0 ? 'medium' : 'none'
    return {
      episode,
      actorIds: [...actorIds],
      strongActorIds: [...strong],
      actorConfidence,
      threadKeys: [...threadKeys],
      topics: topics.slice(0, 16),
      tokens: tokenize(text).slice(0, 24),
      text,
    }
  }
}

export function episodeAnchor(episode: Episode): number {
  const value = episode.endedAt ?? episode.lastExperienceAt ?? episode.startedAt
  return Number.isFinite(value) ? Number(value) : Number.NaN
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
