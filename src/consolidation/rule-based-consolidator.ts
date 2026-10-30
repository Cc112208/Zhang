/**
 * rule-based-consolidator.ts —— 无 LLM 也能工作的确定性整理器（spec §29）。
 *
 * 目标不是「聪明」，而是「不撒谎」：
 *   - 只识别强信号措辞（决定 / 结论 / 必须 / 禁止 / 以后 / 优先 …）。
 *   - 能 reinforce 就绝不 create（避免重复知识）。
 *   - 只有明确的时间变化措辞才 supersede；语境不明就 contradict。
 *   - 绝大多数 Episode 应该 no_op（spec §25）。
 */

import type {
  ConsolidationContext,
  ConsolidationOperation,
  ConsolidationResult,
  MemoryConsolidator,
  MemoryKind,
  SemanticMemory,
} from '../types.js'
import { bigramSimilarity, extractKeywords, normalize } from '../recall/tokenizer.js'
import { splitSentences } from '../util/text.js'
import { singleLine } from '../memory/memory-normalizer.js'
import {
  hasDecisionWording,
  hasSupersedeWording,
  hasWeakChangeWording,
  inferMemoryKind,
  initialConfidence,
  importanceFromEpisodes,
  needsRepeatedEvidence,
  sharesDomain,
} from '../memory/memory-lifecycle.js'
import { looksLikeStructuredText, looksLikeToolOutput, stripRuntimeLines } from '../util/text.js'

export interface RuleBasedConsolidatorOptions {
  minConfidence: number
  autoSupersede: boolean
  requireMultipleEvidenceForPreference: boolean
  /** 单次整理最多产出多少操作（防止一个长 Episode 炸出 20 条知识）。 */
  maxOperations?: number
  /** 判定「同一条知识」的相似度阈值。 */
  duplicateSimilarity?: number
}

const DEFAULT_OPTIONS: RuleBasedConsolidatorOptions = {
  minConfidence: 0.5,
  autoSupersede: true,
  requireMultipleEvidenceForPreference: true,
  maxOperations: 3,
  duplicateSimilarity: 0.55,
}

export class RuleBasedConsolidator implements MemoryConsolidator {
  readonly name = 'rule-based'
  readonly configured = true

  private readonly options: RuleBasedConsolidatorOptions

  constructor(options: Partial<RuleBasedConsolidatorOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  async consolidate(context: ConsolidationContext): Promise<ConsolidationResult> {
    const statements = candidateStatements(context)
    if (statements.length === 0) {
      return { operations: [{ type: 'noop', reason: '没有可整理的自然语言陈述' }] }
    }

    const operations: ConsolidationOperation[] = []
    const maxOperations = this.options.maxOperations ?? 3
    const importance = Math.max(importanceFromEpisodes([context.episode]), 0.35)

    for (const statement of statements) {
      if (operations.length >= maxOperations) break
      const match = bestMemoryMatch(statement, context.relatedMemories, this.options.duplicateSimilarity ?? 0.55)
      const related = match ?? bestDomainMatch(statement, context.relatedMemories)
      const kind = inferMemoryKind(statement)
      const evidenceEpisodeIds = evidenceIds(context, related?.memory, statement)

      // 1) 明确的时间变化：只有开启 autoSupersede 且确有旧知识时才 supersede。
      //    这里的 related 允许「同一领域 + 措辞不同的新决定」命中旧知识（例如 SQLite → PostgreSQL），
      //    否则旧结论会永远 active，历史就无法正确保留。
      if (hasSupersedeWording(statement) && related && this.options.autoSupersede) {
        operations.push({
          type: 'supersede',
          memoryId: related.memory.id,
          kind: related.memory.kind,
          ...(related.memory.subject ? { subject: related.memory.subject } : {}),
          content: singleLine(statement),
          confidence: initialConfidence({ evidenceCount: 1, episodeImportance: importance, explicitDecision: true }),
          importance,
          evidenceEpisodeIds,
        })
        continue
      }

      // 2) 已有高度相似（或同一领域且都是决定类措辞）的知识：reinforce，而不是 create 重复知识。
      if (related && (related.score >= (this.options.duplicateSimilarity ?? 0.55) || this.isDomainReinforce(statement, related.memory))) {
        // 2a) 「这次/暂时/先试」+ 相似旧知识 = 冲突但不确定 → contradict。
        if (hasWeakChangeWording(statement) && !hasDecisionWording(statement)) {
          operations.push({ type: 'contradict', memoryId: related.memory.id, evidenceEpisodeIds })
          continue
        }
        operations.push({
          type: 'reinforce',
          memoryId: related.memory.id,
          evidenceEpisodeIds,
        })
        continue
      }

      // 3) 新知识：必须有强信号，并且过得了「重复证据 / 高重要度」门槛。
      if (!isKnowledgeWorthy(statement, kind, importance, this.options)) continue
      const confidence = initialConfidence({
        evidenceCount: evidenceEpisodeIds.length,
        episodeImportance: importance,
        explicitDecision: hasDecisionWording(statement),
      })
      if (confidence < this.options.minConfidence) continue
      operations.push({
        type: 'create',
        kind,
        content: singleLine(statement),
        confidence,
        importance,
        evidenceEpisodeIds,
      })
    }

    if (operations.length === 0) {
      return { operations: [{ type: 'noop', reason: '没有达到长期知识门槛的陈述' }] }
    }
    return { operations }
  }

  /**
   * 领域内强化：同一个技术领域的决定类知识，措辞不同但结论一致时也算支持。
   * 只允许「有明确决定措辞」的陈述强化 decision/constraint/principle 类记忆，
   * 避免把两条无关的偏好互相加强。
   */
  private isDomainReinforce(statement: string, memory: SemanticMemory): boolean {
    if (memory.status !== 'active') return false
    if (!hasDecisionWording(statement)) return false
    if (!DOMAIN_REINFORCE_KINDS.has(memory.kind)) return false
    return sharesDomain(statement, memory.content)
  }
}

const DOMAIN_REINFORCE_KINDS = new Set<MemoryKind>(['decision', 'constraint', 'principle', 'goal'])

/** 同一领域的旧知识（用于 supersede / reinforce 的兜底关联）。 */
export function bestDomainMatch(
  statement: string,
  memories: readonly SemanticMemory[],
): MemoryMatch | null {
  let best: MemoryMatch | null = null
  for (const memory of memories) {
    if (memory.status !== 'active') continue
    if (!sharesDomain(statement, memory.content)) continue
    const score = round4(0.6 + memory.confidence * 0.2)
    if (!best || score > best.score) best = { memory, score }
  }
  return best
}

/** 从 Episode 的标题/摘要里取出可以成为知识的单句（过滤工具输出与运行时注入行）。 */
export function candidateStatements(context: ConsolidationContext): string[] {
  // 摘要信息量最大、也最完整，优先取它；标题常被 trimTitle 截断（以「…」结尾），
  // 只能作为摘要为空时的兜底，绝不能把半句话存成长期知识。
  const sources = [context.episode.summary ?? '', context.episode.title ?? '']
  const out: string[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    const cleaned = stripRuntimeLines(source)
    for (const sentence of splitSentences(cleaned)) {
      const value = singleLine(sentence, 400)
      if (value.length < 6) continue
      if (value.endsWith('…') || value.endsWith('...')) continue
      if (looksLikeStructuredText(value) || looksLikeToolOutput(value)) continue
      const key = normalize(value)
      if (key.length === 0 || seen.has(key)) continue
      seen.add(key)
      out.push(value)
    }
  }
  return out
}

/** 是否值得成为长期知识（spec §26 / §27）。 */
export function isKnowledgeWorthy(
  statement: string,
  kind: MemoryKind,
  importance: number,
  options: Pick<RuleBasedConsolidatorOptions, 'requireMultipleEvidenceForPreference'>,
): boolean {
  const explicitDecision = hasDecisionWording(statement)
  if (kind === 'other' && !explicitDecision) return false
  // 偏好/信念/原则/关系：默认要求重复证据，除非措辞极其明确。
  if (needsRepeatedEvidence(kind, options) && !explicitDecision) {
    return importance >= 0.85
  }
  // 单条 Episode 立知识需要：明确决定措辞，或高重要度 + 具体类型。
  return explicitDecision || importance >= 0.7
}

export interface MemoryMatch {
  memory: SemanticMemory
  score: number
}

/** 在已有知识里找最像的一条（文本相似 + 关键词重合，取较大值）。 */
export function bestMemoryMatch(
  statement: string,
  memories: readonly SemanticMemory[],
  threshold: number,
): MemoryMatch | null {
  const normalized = normalize(statement)
  const keywords = new Set(extractKeywords(statement, 8))
  let best: MemoryMatch | null = null
  for (const memory of memories) {
    if (memory.status !== 'active') continue
    const textScore = bigramSimilarity(normalized, normalize(memory.content))
    const memoryKeywords = extractKeywords(memory.content, 8)
    const shared = memoryKeywords.filter((keyword) => keywords.has(keyword)).length
    const keywordScore = keywords.size === 0 ? 0 : shared / Math.min(keywords.size, memoryKeywords.length || 1)
    const score = round4(Math.max(textScore, keywordScore * 0.9))
    if (score < threshold) continue
    if (!best || score > best.score) best = { memory, score }
  }
  return best
}

function evidenceIds(context: ConsolidationContext, memory: SemanticMemory | undefined, statement: string): string[] {
  const ids = [context.episode.id]
  // 相关 Episode 只有在文本确实支持同一陈述时才算证据 —— 不把时间接近当证据。
  for (const related of context.relatedEpisodes) {
    const text = [related.title ?? '', related.summary ?? ''].join(' ')
    if (text.length === 0) continue
    if (bigramSimilarity(normalize(statement), normalize(text)) >= 0.4) ids.push(related.id)
  }
  return unique(ids)
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))]
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
