/**
 * candidate-finder.ts —— Pattern 候选发现（Stage 4 spec §14 / §15）。
 *
 * 关键区别（这是 Stage 4 真正要解决的问题）：
 *   Pattern 不是「文本相似」，而是「行为 / 决策 / 偏好结构重复」。
 *
 *   "先用 SQLite 避免部署复杂度" / "暂不引 Redis" / "保持单进程"
 *   文本完全不同，但共享同一个结构概念：避免过早基础设施复杂化。
 *
 * 所以候选发现分两层：
 *   1. 词法层：FTS / bigram 找到「聊同一件事」的知识（保证证据在同一话题里）；
 *   2. 概念层：从 active 知识里捞共享 PATTERN_CONCEPTS 的条目（保证跨话题也能聚起来）。
 *
 * 本文件只负责**收集上下文**，不做判断——判断是 PatternAnalyzer 的职责。
 */

import type {
  PatternContext,
  PatternMemory,
  SemanticMemory,
} from '../types.js'
import type { MemoryRepository } from '../memory/memory-repository.js'
import type { PatternRepository } from '../pattern/pattern-repository.js'
import type { PatternEvidenceRepository } from '../pattern/pattern-evidence-repository.js'
import { conceptsOf, sharedConcepts } from '../pattern/pattern-lifecycle.js'

export interface PatternCandidateFinderDeps {
  memories: MemoryRepository
  patterns: PatternRepository
  evidence: PatternEvidenceRepository
  now?: () => number
}

export interface PatternDiscoveryOptions {
  maxRelatedMemories: number
  maxExistingPatterns: number
  /** 概念层额外捞多少条 active 知识（默认 60，够用且不拖慢 capture 之外的路径）。 */
  conceptPoolLimit?: number
}

export class PatternCandidateFinder {
  private readonly memories: MemoryRepository
  private readonly patterns: PatternRepository
  private readonly evidence: PatternEvidenceRepository
  private readonly now: () => number

  constructor(deps: PatternCandidateFinderDeps) {
    this.memories = deps.memories
    this.patterns = deps.patterns
    this.evidence = deps.evidence
    this.now = deps.now ?? (() => Date.now())
  }

  /**
   * 为一条被新写入/强化的 Semantic Memory 收集分析上下文。
   * 触发者本身一定在 relatedMemories 里（分析器需要它才能把「新证据」算进支持数）。
   */
  buildContext(triggerMemory: SemanticMemory, options: PatternDiscoveryOptions): PatternContext {
    const maxMemories = Math.max(1, Math.round(options.maxRelatedMemories))
    const maxPatterns = Math.max(0, Math.round(options.maxExistingPatterns))
    const query = queryText(triggerMemory)

    const selected = new Map<string, SemanticMemory>()
    selected.set(triggerMemory.id, triggerMemory)

    // 1) 词法相近的知识（同一话题 / 同一批决策）。
    for (const hit of this.memories.searchLexical(triggerMemory.scopeId, query, Math.max(4, maxMemories))) {
      if (selected.size >= maxMemories) break
      if (hit.memory.status !== 'active') continue
      selected.set(hit.memory.id, hit.memory)
    }

    // 2) 概念层：跨话题但结构相同的知识（SQLite / Redis / 单进程 → 同一个"避免复杂度"模式）。
    const triggerConcepts = new Set(conceptsOf(triggerMemory.content))
    if (triggerConcepts.size > 0) {
      const pool = this.memories.findActive(triggerMemory.scopeId, Math.max(20, options.conceptPoolLimit ?? 60))
      for (const candidate of pool) {
        if (selected.size >= maxMemories) break
        if (selected.has(candidate.id)) continue
        if (sharedConcepts(triggerMemory.content, candidate.content).length > 0) {
          selected.set(candidate.id, candidate)
        }
      }
    }

    const relatedMemories = [...selected.values()].slice(0, maxMemories)

    // 已有 Pattern：既看词法相近的，也看「已经由这批知识支持过」的（避免重复造候选）。
    const existing = new Map<string, PatternMemory>()
    if (maxPatterns > 0) {
      for (const hit of this.patterns.searchLexical(triggerMemory.scopeId, query, maxPatterns)) {
        if (existing.size >= maxPatterns) break
        existing.set(hit.pattern.id, hit.pattern)
      }
      for (const patternId of this.evidence.listPatternIdsByMemory(triggerMemory.id, { limit: maxPatterns })) {
        if (existing.size >= maxPatterns) break
        const pattern = this.patterns.getById(patternId)
        if (pattern && pattern.status !== 'superseded' && pattern.status !== 'archived') existing.set(pattern.id, pattern)
      }
      // 概念相近的候选（新 Memory 只是强化了同一个模式家族时，词法可能完全不重叠）。
      const family = this.matchPatternFamily(triggerMemory, relatedMemories, maxPatterns - existing.size)
      for (const pattern of family) {
        if (existing.size >= maxPatterns) break
        existing.set(pattern.id, pattern)
      }
    }

    return {
      scopeId: triggerMemory.scopeId,
      triggerMemory,
      relatedMemories,
      existingPatterns: [...existing.values()].slice(0, Math.max(0, maxPatterns)),
    }
  }

  /**
   * 按概念家族找已有 Pattern。
   * 例：trigger 是「不上 Neo4j」而已有 Pattern 是「避免额外服务」——两者都命中 avoid_ 家族。
   */
  private matchPatternFamily(trigger: SemanticMemory, related: readonly SemanticMemory[], limit: number): PatternMemory[] {
    if (limit <= 0) return []
    const texts = [trigger.content, ...related.filter((m) => m.id !== trigger.id).map((m) => m.content)]
    const triggerConcepts = new Set(texts.flatMap((text) => conceptsOf(text)))
    if (triggerConcepts.size === 0) return []
    const candidates = this.patterns.findCandidates(trigger.scopeId, Math.max(20, limit * 4))
    const out: PatternMemory[] = []
    for (const pattern of candidates) {
      const patternConcepts = conceptsOf(`${pattern.content} ${pattern.subject ?? ''}`)
      if (patternConcepts.some((concept) => triggerConcepts.has(concept))) out.push(pattern)
      if (out.length >= limit) break
    }
    return out
  }
}

/** 用于词法检索的查询文本：正文 + kind 提示，最多 200 字。 */
export function queryText(memory: SemanticMemory): string {
  const subject = memory.subject ? `${memory.subject} ` : ''
  const text = `${subject}${memory.content}`.trim()
  return text.length > 200 ? text.slice(0, 200) : text
}
