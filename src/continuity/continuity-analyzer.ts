/**
 * continuity-analyzer.ts —— 确定性 Episode 连续性判定（Stage 4.5）。
 *
 * 输出 `EpisodeLink` 列表（不是自由文本），由调用方决定是否写库。
 * 设计原则（spec §23 / §24 / §25）：
 *   - 先有确定性候选，再谈关系；LLM 版以后作为可选增强。
 *   - 关系必须带 0..1 confidence，并且给出人类可读 reason。
 *   - `continues` 需要「同一参与者/线程」+「话题或语义确实接续」+「时间接近」同时成立；
 *     同一人聊考试 vs 聊游戏最多 `same_thread`，绝不 `continues`（spec §26）。
 */

import type { EpisodeRelationType } from '../types.js'
import type { ContinuityCandidate, ContinuityContext, EpisodeProfile } from './candidate-finder.js'

export interface EpisodeLink {
  sourceEpisodeId: string
  targetEpisodeId: string
  relation: EpisodeRelationType
  confidence: number
  reason: string
}

export interface ContinuityAnalyzerSettings {
  /** 低于这个置信度不建立关系。 */
  minConfidence: number
  /** 判定 continues 需要的置信度。 */
  continuesThreshold: number
  /** 判定 followup 需要的置信度。 */
  followupThreshold: number
  /** 单次最多输出多少条关系（稀缺性控制，spec §74）。 */
  maxLinksPerEpisode: number
}

export const DEFAULT_CONTINUITY_SETTINGS: ContinuityAnalyzerSettings = {
  minConfidence: 0.45,
  continuesThreshold: 0.62,
  followupThreshold: 0.5,
  maxLinksPerEpisode: 2,
}

export interface EpisodeContinuityAnalyzer {
  analyze(context: ContinuityContext): EpisodeLink[]
}

/** 未来计划 / 待续话题的措辞。 */
const PLAN_MARKERS: readonly string[] = [
  '下周',
  '下个月',
  '明天',
  '后天',
  '这周',
  '本月',
  '月底',
  '准备',
  '打算',
  '计划',
  '即将',
  '我要',
  '考试',
  '复试',
  '面试',
  '出差',
  '上线',
  '发布',
  '报名',
  '等结果',
  '还没',
]

/** 一周内才可能算「连续经历」；更久的事件最多算同一线程。 */
const CONTINUES_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export class RuleBasedContinuityAnalyzer implements EpisodeContinuityAnalyzer {
  private readonly settings: ContinuityAnalyzerSettings

  constructor(settings: Partial<ContinuityAnalyzerSettings> = {}) {
    this.settings = { ...DEFAULT_CONTINUITY_SETTINGS, ...settings }
  }

  analyze(context: ContinuityContext): EpisodeLink[] {
    const trigger = context.trigger
    const links: EpisodeLink[] = []
    for (const candidate of context.candidates) {
      const link = this.evaluate(trigger, candidate)
      if (!link) continue
      if (link.confidence < this.settings.minConfidence) continue
      links.push(link)
    }
    links.sort((left, right) => right.confidence - left.confidence)
    // 「稀缺」：每个 Episode 只保留最强的少量关系。
    return links.slice(0, Math.max(1, this.settings.maxLinksPerEpisode))
  }

  private evaluate(trigger: EpisodeProfile, candidate: ContinuityCandidate): EpisodeLink | null {
    const other = candidate.profile
    // 强身份：显式 actorId 或平台稳定用户 ID；弱身份：只有历史 viewerId。
    // 「延续/后续」必须建立在强身份上，否则一个不透明 ID 的重合不足以说明是同一事件。
    const strongActors = intersect(trigger.strongActorIds, other.strongActorIds)
    const sharedActors = intersect(trigger.actorIds, other.actorIds)
    const sharedThreads = intersect(trigger.threadKeys, other.threadKeys)
    const sameParticipant = strongActors.length > 0 || sharedThreads.length > 0
    const sameThreadOnly = !sameParticipant && sharedActors.length > 0

    const similarity = candidate.similarity
    const tokenOverlap = jaccard(trigger.tokens, other.tokens)
    const sharedTopics = intersect(trigger.topics, other.topics)
    const topicOverlap = sharedTopics.length > 0 ? Math.min(1, sharedTopics.length / 3) : 0
    const planContinuity = hasPlanContinuity(trigger.text, other.text)
    const temporal = temporalScore(candidate.gapMs)

    const affinity = clamp01(
      0.32 * (sameParticipant ? 1 : 0) +
        0.2 * similarity +
        0.18 * topicOverlap +
        0.14 * tokenOverlap +
        0.1 * temporal +
        0.16 * (planContinuity ? 1 : 0),
    )

    // 完全没有共同兴趣点时，即使同一个人也不建立关系；
    // 这防止「同一个人的所有 Episode 都被连起来」（spec §26）。
    const sharesContent = similarity >= 0.18 || topicOverlap >= 0.34 || planContinuity || tokenOverlap >= 0.22
    if (!sameParticipant && !sharesContent) return null
    if (!sharesContent && similarity < 0.12) return null

    if (
      sameParticipant &&
      sharesContent &&
      temporal >= 0.35 &&
      affinity >= this.settings.continuesThreshold &&
      (candidate.gapMs <= CONTINUES_WINDOW_MS || planContinuity)
    ) {
      return {
        sourceEpisodeId: other.episode.id,
        targetEpisodeId: trigger.episode.id,
        relation: 'continues',
        confidence: round4(Math.max(affinity, this.settings.continuesThreshold)),
        reason: describe('延续', sameParticipant, planContinuity, sharedTopics, similarity, candidate.gapMs),
      }
    }
    if (sameParticipant && affinity >= this.settings.followupThreshold) {
      return {
        sourceEpisodeId: other.episode.id,
        targetEpisodeId: trigger.episode.id,
        relation: 'followup',
        confidence: round4(affinity),
        reason: describe('后续', sameParticipant, planContinuity, sharedTopics, similarity, candidate.gapMs),
      }
    }
    if (sharesContent && topicOverlap >= 0.34) {
      return {
        sourceEpisodeId: other.episode.id,
        targetEpisodeId: trigger.episode.id,
        relation: 'same_topic',
        confidence: round4(Math.min(affinity, 0.6)),
        reason: describe('同话题', false, planContinuity, sharedTopics, similarity, candidate.gapMs),
      }
    }
    if (sameParticipant || sameThreadOnly) {
      return {
        sourceEpisodeId: other.episode.id,
        targetEpisodeId: trigger.episode.id,
        relation: 'same_thread',
        confidence: round4(Math.min(affinity, 0.55)),
        reason: describe('同一参与者', true, false, sharedTopics, similarity, candidate.gapMs),
      }
    }
    return null
  }
}

/** 两条文本是否都在谈同一件「未来/进行中的事」。 */
export function hasPlanContinuity(left: string, right: string): boolean {
  const leftMarkers = PLAN_MARKERS.filter((marker) => left.includes(marker))
  if (leftMarkers.length === 0) return false
  const rightHasPlan = PLAN_MARKERS.some((marker) => right.includes(marker))
  if (rightHasPlan) {
    // 共享具体计划词（复试/考试/面试/项目名…）比「都有计划」更有说服力。
    const specific = ['复试', '考试', '面试', '报名', '上线', '发布', '出差', '答辩', '体检']
    return specific.some((word) => left.includes(word) && right.includes(word)) || true
  }
  // 一边计划、一边收尾（结束/完成/结果）也算接续。
  const endings = ['结束', '完成', '完了', '结果', '考完', '刚']
  return endings.some((word) => right.includes(word))
}

function temporalScore(gapMs: number): number {
  if (!Number.isFinite(gapMs) || gapMs < 0) return 0
  const day = 24 * 60 * 60 * 1000
  if (gapMs <= day) return 1
  if (gapMs <= 3 * day) return 0.8
  if (gapMs <= 7 * day) return 0.6
  if (gapMs <= 30 * day) return 0.25
  return 0.05
}

function describe(
  label: string,
  sameParticipant: boolean,
  planContinuity: boolean,
  sharedTopics: readonly string[],
  similarity: number,
  gapMs: number,
): string {
  const parts: string[] = [label]
  if (sameParticipant) parts.push('same actor/thread')
  if (planContinuity) parts.push('future plan follow-up')
  if (sharedTopics.length > 0) parts.push(`shared topic ${sharedTopics.slice(0, 2).join('/')}`)
  if (similarity >= 0.18) parts.push(`text similarity ${similarity.toFixed(2)}`)
  parts.push(formatGap(gapMs))
  return parts.join(' · ')
}

function formatGap(gapMs: number): string {
  if (!Number.isFinite(gapMs)) return '间距未知'
  const minutes = Math.round(gapMs / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟 apart`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时 apart`
  return `${Math.round(hours / 24)} 天 apart`
}

function intersect(left: readonly string[], right: readonly string[]): string[] {
  if (left.length === 0 || right.length === 0) return []
  const set = new Set(right)
  return [...new Set(left.filter((value) => set.has(value)))]
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0
  const a = new Set(left)
  const b = new Set(right)
  let intersection = 0
  for (const value of a) if (b.has(value)) intersection += 1
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
