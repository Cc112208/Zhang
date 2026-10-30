/**
 * fusion.ts —— 多路召回融合（spec §11）。
 *
 * 第一版权重：0.45 lexical + 0.25 semantic + 0.12 temporal + 0.10 importance + 0.08 recency。
 * semantic 不可用时，把它的权重去掉后**重新归一化**其余四路 —— 不是直接报错、也不是分数整体变小。
 *
 * 这一层只做数学：加权求和、排序、组装 reasons。不查库、不解析查询。
 */

import type { RecallHit, RecallReason, RecallType } from '../types.js'

export interface RecallWeights {
  lexicalWeight: number
  semanticWeight: number
  temporalWeight: number
  importanceWeight: number
  recencyWeight: number
}

export interface ResolvedWeights {
  lexical: number
  semantic: number
  temporal: number
  importance: number
  recency: number
  semanticAvailable: boolean
  /** true = 因为 semantic 不可用而重新归一化过（理由里会体现）。 */
  renormalized: boolean
}

export interface FusionSignals {
  lexical: number
  /** null = 本轮没有语义通道（provider 不可用或没命中）。 */
  semantic: number | null
  temporal: number
  importance: number
  recency: number
}

export interface FusionCandidate {
  id: string
  type: RecallType
  content: string
  createdAt: number
  importance: number
  signals: FusionSignals
  reasons: RecallReason[]
  /**
   * 类型专属加成（spec §34–§37）：Memory 用 confidence × importance × reinforcement 的乘性加成，
   * Experience / Episode 恒为 1。放在这里而不是改公式，是为了让「为什么这条排在前面」仍然可解释。
   */
  boost?: number
}

/** 归一化权重。所有通道都不可用时退化为均匀权重，保证总有可比较的分。 */
export function resolveWeights(weights: RecallWeights, semanticAvailable: boolean): ResolvedWeights {
  const raw = {
    lexical: clamp01(weights.lexicalWeight),
    semantic: semanticAvailable ? clamp01(weights.semanticWeight) : 0,
    temporal: clamp01(weights.temporalWeight),
    importance: clamp01(weights.importanceWeight),
    recency: clamp01(weights.recencyWeight),
  }
  const sum = raw.lexical + raw.semantic + raw.temporal + raw.importance + raw.recency
  const renormalized = !semanticAvailable && weights.semanticWeight > 0

  if (sum <= 0) {
    const even = 1 / 4
    return {
      lexical: even,
      semantic: 0,
      temporal: even,
      importance: even,
      recency: even,
      semanticAvailable,
      renormalized,
    }
  }
  return {
    lexical: raw.lexical / sum,
    semantic: raw.semantic / sum,
    temporal: raw.temporal / sum,
    importance: raw.importance / sum,
    recency: raw.recency / sum,
    semanticAvailable,
    renormalized,
  }
}

/**
 * 单候选的分：各通道信号 × 归一化权重，再乘类型加成（默认 1）。
 * boost 只作用于最终分，不改变各通道理由里的原始信号分 —— 可解释性优先。
 */
export function signalScore(signals: FusionSignals, weights: ResolvedWeights, boost = 1): number {
  const semantic = signals.semantic ?? 0
  const base =
    weights.lexical * clamp01(signals.lexical) +
    weights.semantic * clamp01(semantic) +
    weights.temporal * clamp01(signals.temporal) +
    weights.importance * clamp01(signals.importance) +
    weights.recency * clamp01(signals.recency)
  return Math.round(clamp01(clamp01(base) * clampBoost(boost)) * 10_000) / 10_000
}

/** 排序 + 截断 + 组装 RecallHit。排序必须稳定：同分按时间新→旧，再按 id 保证可复现。 */
export function fuse(
  candidates: readonly FusionCandidate[],
  weights: ResolvedWeights,
  limit: number,
): RecallHit[] {
  const scored = candidates.map((candidate) => ({
    candidate,
    score: signalScore(candidate.signals, weights, candidate.boost ?? 1),
  }))

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.candidate.createdAt !== a.candidate.createdAt) return b.candidate.createdAt - a.candidate.createdAt
    return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0
  })

  return scored.slice(0, Math.max(0, limit)).map(({ candidate, score }) => ({
    id: candidate.id,
    type: candidate.type,
    content: candidate.content,
    score,
    createdAt: candidate.createdAt,
    reasons: ensureReasons(candidate.reasons, candidate.signals),
  }))
}

/** 可解释性底线（spec §3.6）：任何 hit 至少有一条理由。 */
function ensureReasons(reasons: readonly RecallReason[], signals: FusionSignals): RecallReason[] {
  if (reasons.length > 0) return [...reasons]
  return [
    {
      type: 'importance',
      score: clamp01(signals.importance),
      detail: '无关键词/语义命中，仅由重要性与新鲜度进入候选',
    },
  ]
}

/** 加成必须 bounded：不能出现「一条 Memory 因为 confidence 高就无限膨胀」。 */
function clampBoost(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(2.5, Math.max(0.1, value))
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
