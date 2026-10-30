/**
 * memory-lifecycle.ts —— Semantic Memory 的生命周期规则（spec §23 / §24 / §52 / §53）。
 *
 * 这里只放纯函数与常量：
 *   - 置信度怎么长、怎么降（bounded [0,1]，一次 reinforce 绝不直接到 1.0）
 *   - 哪些知识类型必须先有重复证据
 *   - 哪些措辞表示「明确变化」（supersede 的信号）或「明确决定」（create 的信号）
 *
 * 不碰数据库、不碰 LLM，方便单测与替换。
 */

import type { MemoryKind, Episode } from '../types.js'
import { normalizeMemoryContent } from './memory-normalizer.js'

/** 偏好类知识更依赖重复证据（spec §27）。 */
const MULTI_EVIDENCE_KINDS = new Set<MemoryKind>(['preference', 'belief', 'principle', 'relationship'])

/** 明确决定/约束类措辞：单个高重要 Episode 就可以立知识（spec §26 的 A 条件）。 */
const DECISION_PATTERNS = [
  '决定',
  '决定了',
  '结论',
  '定了',
  '就这么',
  '改为',
  '改用',
  '采用',
  '先用',
  '使用',
  '不上',
  '不再',
  '禁止',
  '必须',
  '不要',
  '目标',
  '计划',
  '原则',
  '约定',
  '记住',
  '从现在开始',
  '以后',
]

/** 明确「时间上的变化」：只有这些才允许自动 supersede（spec §23 / §55）。 */
const SUPERSEDE_PATTERNS = [
  '从今天起',
  '从现在起',
  '从今以后',
  '已经迁移',
  '已迁移',
  '迁移到',
  '切换到',
  '换成',
  '改为使用',
  '不再使用',
  '改主意',
  '推翻',
]

/** 只是「这次用了」的表达，不足以判定长期策略变化 → contradiction（spec §24）。 */
const WEAK_CHANGE_PATTERNS = ['这次', '暂时', '临时', '先试', '试着', '也许', '可能']

export interface ConfidenceOptions {
  /** 参与的证据 Episode 数。 */
  evidenceCount: number
  /** 这些 Episode 的最高 importance。 */
  episodeImportance: number
  /** 是否有一条「明确决定」表述。 */
  explicitDecision: boolean
}

/**
 * 初始置信度：单个明确 Episode 落在 0.65–0.8；多证据逐步提高但不越过 0.95。
 * 公式可替换，但必须 bounded（spec §52）。
 */
export function initialConfidence(options: ConfidenceOptions): number {
  const explicit = options.explicitDecision ? 0.75 : 0.6
  const evidenceBoost = Math.min(0.15, Math.max(0, options.evidenceCount - 1) * 0.05)
  const importanceBoost = clamp01(options.episodeImportance) * 0.08
  return round4(clamp01(explicit + evidenceBoost + importanceBoost))
}

/** 新证据支持已有知识：1-(1-old)(1-delta)，永不超过 1（spec §52）。 */
export function reinforcedConfidence(current: number, delta = 0.15): number {
  const base = clamp01(current)
  const bump = clamp01(delta)
  return round4(clamp01(1 - (1 - base) * (1 - bump)))
}

/** 矛盾但未确认变化：降低置信度，保留 active（spec §24：不要假装知道答案）。 */
export function contradictedConfidence(current: number, weight = 0.1): number {
  const base = clamp01(current)
  const penalty = 0.05 + clamp01(weight) * 0.15
  return round4(clamp01(base - penalty))
}

/** Episode 证据的整体重要度：取最大而不是平均（一次重要讨论不应被日常闲聊稀释）。 */
export function importanceFromEpisodes(episodes: readonly Episode[]): number {
  if (episodes.length === 0) return 0.5
  return round4(clamp01(Math.max(...episodes.map((episode) => clamp01(episode.importance)))))
}

/** 该 kind 是否要求重复证据（spec §27）。 */
export function needsRepeatedEvidence(kind: MemoryKind, options: { requireMultipleEvidenceForPreference: boolean }): boolean {
  if (!options.requireMultipleEvidenceForPreference) return false
  return MULTI_EVIDENCE_KINDS.has(kind)
}

/**
 * 第一人称的个人计划 / 身份表达（「我下周要复试」「我叫张三」）。
 * 直播、日记这类场景里用户不会先说「决定」，但这是真正值得记住的个人事实。
 * 要求长度 >= 10，避免「我要这个」这类一句话噪声。
 */
const PERSONAL_PLAN_PATTERNS = ['我下周', '我这周', '我明天', '我下个月', '我要', '我准备', '我打算', '我叫', '我最近']

export function hasDecisionWording(text: string): boolean {
  if (DECISION_PATTERNS.some((pattern) => text.includes(pattern))) return true
  return text.length >= 10 && PERSONAL_PLAN_PATTERNS.some((pattern) => text.includes(pattern))
}

export function hasSupersedeWording(text: string): boolean {
  return SUPERSEDE_PATTERNS.some((pattern) => text.includes(pattern))
}

export function hasWeakChangeWording(text: string): boolean {
  return WEAK_CHANGE_PATTERNS.some((pattern) => text.includes(pattern))
}

/**
 * 从文本猜 knowledge kind（规则默认值，LLM 可以覆盖）。
 * 只在有明确信号时给出具体类型，否则 other —— 不假装聪明（spec §29）。
 */
export function inferMemoryKind(text: string): MemoryKind {
  const value = text.trim()
  if (value.length === 0) return 'other'
  if (/(决定|结论|采用|选用|先用|定为|定了)/.test(value)) return 'decision'
  if (/(必须|禁止|不要|不能|只允许|约束|限制)/.test(value)) return 'constraint'
  if (/(目标|计划|打算|接下来要|要完成)/.test(value)) return 'goal'
  if (/(喜欢|偏好|更喜欢|习惯|倾向|优先)/.test(value)) return 'preference'
  if (/(原则|理念|宗旨|一贯)/.test(value)) return 'principle'
  if (/(关系|朋友|同事|合作伙伴|认识)/.test(value)) return 'relationship'
  if (/(相信|认为|觉得|判断)/.test(value)) return 'belief'
  if (/(使用|采用|基于|位于|叫做|名为|版本|端口|路径|在.*项目)/.test(value)) return 'fact'
  return 'other'
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/**
 * 轻量领域词表（spec §29：不要假装聪明，但要让「同一决策领域」可判定）。
 *
 * 只覆盖 Memory Sea 真实会遇到的「技术选型」领域，用来在措辞差异很大时
 * 判断两条知识是否在谈同一类东西（例如「SQLite 存记忆」与「迁移到 PostgreSQL」）。
 * 这是规则，不是推断：没命中任何领域就不做任何关联。
 */
export const DOMAIN_LEXICON: Record<string, string> = {
  sqlite: 'storage',
  postgres: 'storage',
  postgresql: 'storage',
  mysql: 'storage',
  mongodb: 'storage',
  redis: 'storage',
  数据库: 'storage',
  存储: 'storage',
  向量库: 'storage',
  neo4j: 'graph',
  图数据库: 'graph',
  知识图谱: 'graph',
  qdrant: 'vector',
  pgvector: 'vector',
  embedding: 'vector',
  向量: 'vector',
  llm: 'model',
  大模型: 'model',
  提示词: 'prompt',
  memory: 'memory',
  记忆: 'memory',
  episode: 'memory',
  经历: 'memory',
  插件: 'harness',
  宿主: 'harness',
  deepseek: 'harness',
}

/** 文本命中的领域集合；没有任何领域命中时返回空集。 */
export function domainsOf(text: string): Set<string> {
  const normalized = normalizeMemoryContent(text)
  const domains = new Set<string>()
  for (const [term, domain] of Object.entries(DOMAIN_LEXICON)) {
    if (normalized.includes(term)) domains.add(domain)
  }
  return domains
}

/** 两段文本是否谈同一领域（交集非空）。 */
export function sharesDomain(a: string, b: string): boolean {
  const left = domainsOf(a)
  if (left.size === 0) return false
  for (const domain of domainsOf(b)) {
    if (left.has(domain)) return true
  }
  return false
}
