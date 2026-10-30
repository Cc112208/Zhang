/**
 * rule-based-pattern-analyzer.ts —— 无 LLM 也能工作的结构化 Pattern 分析器（spec §14–§22）。
 *
 * 核心认识（spec §15）：Pattern 不是「文本重复」，而是「行为 / 决策结构重复」。
 *   「先用 SQLite，避免额外部署」/「暂不引 Redis」/「保持单进程」
 *   文本完全不同，但共享同一个结构概念：避免过早基础设施复杂化。
 * 所以这里不比较原文相似度，而是复用 pattern-lifecycle 里的概念映射表，
 * 把「文本相似」升级成「结构相似」。
 *
 * 安全边界（spec §22 / §25 / §26）：
 *   - 单条 Memory 永远不能生成 Pattern（minSupport 默认 3，且 dominantConcept 自己也有硬下限 2）；
 *   - 已有模式优先 reinforce / weaken，而不是 create 出一堆重复知识；
 *   - 只有一组明确的互斥结构（本地/避免复杂度 ↔ 转向托管云）才 weaken，不做花哨的冲突推断；
 *   - 输出永远是描述性文案，不含任何可执行能力（Pattern is descriptive. Skill is executable.）。
 *
 * 本文件是纯函数 + 一个 async 包装：不碰数据库、不碰网络、不抛错。
 */

import type {
  PatternAnalysisResult,
  PatternAnalyzer,
  PatternContext,
  PatternMemory,
  PatternOperation,
  PatternStatus,
  SemanticMemory,
} from '../types.js'
import { bigramSimilarity } from '../recall/tokenizer.js'
import {
  conceptById,
  conceptsOf,
  dominantConcept,
  initialPatternConfidence,
  sharedConcepts,
  type PatternConcept,
} from '../pattern/pattern-lifecycle.js'

export interface RuleBasedPatternAnalyzerOptions {
  /** 至少多少条 Memory 共享同一概念结构才允许成为 Pattern（硬下限 2）。 */
  minSupport: number
  /** candidate → active 的置信度门槛。分析器只负责「提议 create」，是否 active 由 applier 决定。 */
  activationThreshold: number
  /** 生成 Pattern 的最低置信度；低于它宁可 noop。 */
  minConfidence: number
  /** 单次分析最多产出多少操作（防止一条 Memory 触发一堆操作）。 */
  maxOperations: number
}

const DEFAULT_OPTIONS: RuleBasedPatternAnalyzerOptions = {
  minSupport: 3,
  activationThreshold: 0.7,
  minConfidence: 0.55,
  maxOperations: 2,
}

/** 只有这三个「本地 / 避免复杂度」类概念与「转向托管云」互斥。 */
const CLOUD_OPPOSED_CONCEPTS: readonly string[] = [
  'local_first',
  'avoid_infra_complexity',
  'avoid_extra_services',
]

/** 分析器只处理这三种状态的 Pattern：superseded / stale / archived 不应再被强化。 */
const MATCHABLE_STATUSES: readonly PatternStatus[] = ['active', 'candidate', 'weakened']

const STATUS_RANK: Partial<Record<PatternStatus, number>> = {
  active: 3,
  candidate: 2,
  weakened: 1,
}

export class RuleBasedPatternAnalyzer implements PatternAnalyzer {
  readonly name = 'rule-based'
  readonly configured = true

  private readonly options: RuleBasedPatternAnalyzerOptions

  constructor(options: Partial<RuleBasedPatternAnalyzerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  async analyze(context: PatternContext): Promise<PatternAnalysisResult> {
    try {
      return this.analyzeSync(context)
    } catch {
      // 约定：分析器绝不把异常抛给 service；单次分析失败就当作没有可提取的模式。
      return { operations: [{ type: 'noop', reason: '规则式模式分析失败' }] }
    }
  }

  private analyzeSync(context: PatternContext): PatternAnalysisResult {
    const minSupport = Math.max(2, this.options.minSupport)
    const memories = uniqueMemories([...context.relatedMemories, context.triggerMemory])
    const texts = uniqueTexts(memories.map((memory) => memory.content))

    // 1) 先问：这批知识里是否存在「反复出现的结构」？单个话题、单条知识都不算。
    const dominant = dominantConcept(texts, this.options.minSupport)
    if (!dominant) {
      return noop('没有足够多的知识共享同一模式结构')
    }
    const concept = conceptById(dominant.conceptId)
    if (!concept) {
      return noop(`模式概念表里找不到概念 ${dominant.conceptId}`)
    }

    // 2) 命中的支持者必须真的包含该概念；数量仍不足就 noop，绝不从单条 Memory 造 Pattern。
    const supporters = memories.filter((memory) => conceptsOf(memory.content).includes(concept.id))
    if (supporters.length < minSupport) {
      return noop(`支持概念 ${concept.id} 的知识只有 ${supporters.length} 条，不足 ${minSupport} 条`)
    }

    // 3) 已有同一概念家族的 Pattern：优先强化（或对反证弱化），而不是 create 重复知识。
    const existing = findFamilyPattern(context.existingPatterns, concept)
    if (existing) {
      if (contradictsExistingPattern(existing, context.triggerMemory)) {
        // 不足以推翻模式，只说明「没这么强」：weaken 只降置信度，状态变更交给 applier。
        return capOperations(
          [
            {
              type: 'weaken',
              patternId: existing.id,
              contradictingMemoryIds: [context.triggerMemory.id],
              confidenceDelta: 0.1,
            },
          ],
          this.options.maxOperations,
        )
      }
      // candidate 且支持者已达标时仍然是 reinforce —— 是否升到 active 由 applier 的激活门槛决定。
      return capOperations(
        [
          {
            type: 'reinforce',
            patternId: existing.id,
            supportingMemoryIds: supporters.map((memory) => memory.id),
          },
        ],
        this.options.maxOperations,
      )
    }

    // 4) 全新模式：置信度来自「多条证据的平均置信度 + 支持度加成」，重要性取最高的一条。
    const confidence = initialPatternConfidence(supporters)
    if (confidence < this.options.minConfidence) {
      return noop('支持证据的置信度不足以生成模式')
    }
    const subject = nonEmpty(context.triggerMemory.subject)
    const operation: PatternOperation = {
      type: 'create',
      kind: concept.kind,
      content: concept.statement,
      confidence,
      importance: round4(Math.max(0, ...supporters.map((memory) => clamp01(memory.importance)))),
      supportingMemoryIds: supporters.map((memory) => memory.id),
      // 只继承 trigger 的主体限定，避免把项目决策说成人格（spec §25）。
      ...(subject ? { subject } : {}),
    }
    return capOperations([operation], this.options.maxOperations)
  }
}

/** 同一概念家族的已有 Pattern（状态可匹配、概念重合或 kind+文本相近）。 */
export function findFamilyPattern(
  patterns: readonly PatternMemory[],
  concept: PatternConcept,
): PatternMemory | null {
  let best: PatternMemory | null = null
  let bestScore = -1
  for (const pattern of patterns) {
    const rank = STATUS_RANK[pattern.status]
    if (rank === undefined || !MATCHABLE_STATUSES.includes(pattern.status)) continue
    if (!isSameConceptFamily(pattern, concept)) continue
    const score = rank * 10 + clamp01(pattern.confidence)
    if (score > bestScore) {
      bestScore = score
      best = pattern
    }
  }
  return best
}

/**
 * 判定已有 Pattern 是否属于目标概念家族。
 * 两条路（任一成立即可）：
 *   1. 概念层：Pattern 文案与概念 statement 共享至少一个概念 id（跨措辞也能认出来）；
 *   2. 文本层：kind 一致且 bigram 相似度 > 0.25（概念表没覆盖新领域时的兜底）。
 */
export function isSameConceptFamily(pattern: PatternMemory, concept: PatternConcept): boolean {
  const text = `${pattern.content} ${pattern.subject ?? ''}`.trim()
  if (sharedConcepts(text, concept.statement).length > 0) return true
  return pattern.kind === concept.kind && bigramSimilarity(pattern.content, concept.statement) > 0.25
}

/**
 * 反证识别：trigger 明确在说「转向托管云」，而旧模式是本地优先 / 避免复杂度。
 * 只做这一组互斥，避免把「相关」误判成「矛盾」。
 */
export function contradictsExistingPattern(pattern: PatternMemory, trigger: SemanticMemory): boolean {
  if (!conceptsOf(trigger.content).includes('hosted_cloud_shift')) return false
  const patternConcepts = conceptsOf(`${pattern.content} ${pattern.subject ?? ''}`)
  return patternConcepts.some((id) => CLOUD_OPPOSED_CONCEPTS.includes(id))
}

function capOperations(
  operations: readonly PatternOperation[],
  maxOperations: number,
): PatternAnalysisResult {
  const limit = Math.max(0, Math.floor(maxOperations))
  const capped = operations.slice(0, limit)
  if (capped.length === 0) return noop('操作上限为 0，没有可输出的操作')
  return { operations: capped }
}

function noop(reason: string): PatternAnalysisResult {
  return { operations: [{ type: 'noop', reason }] }
}

/** 同一 id 只算一次（trigger 可能恰好也在 relatedMemories 里）。 */
function uniqueMemories(memories: readonly SemanticMemory[]): SemanticMemory[] {
  const seen = new Set<string>()
  const out: SemanticMemory[] = []
  for (const memory of memories) {
    if (!memory || typeof memory.id !== 'string' || memory.id.length === 0) continue
    if (seen.has(memory.id)) continue
    seen.add(memory.id)
    out.push(memory)
  }
  return out
}

/** 同一段文本只贡献一次支持度，避免重复内容把支撑数灌水。 */
function uniqueTexts(texts: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const text of texts) {
    const value = typeof text === 'string' ? text.trim() : ''
    if (value.length === 0 || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
