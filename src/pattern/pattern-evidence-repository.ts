/**
 * pattern-evidence-repository.ts —— pattern_evidence 表的唯一访问入口
 * （spec §6 / §57）。
 *
 * Pattern 的证据优先指向 Semantic Memory，而不是直接指向所有原始 Experience：
 *
 *   Pattern → Semantic Memory → Episode → Experience
 *
 * 这样「这个模式是怎么来的」可以一路下钻到原始经历，而不需要 Pattern 自己记住几十条 Experience。
 *
 * 两向查询都必须存在：
 *   - pattern → memories（模式由哪些知识支持 / 反对）
 *   - memory → patterns（这条知识参与了哪些模式）
 */

import type { PatternEvidence, PatternEvidenceRelation } from '../types.js'
import type { MemoryDatabase, SqlValue } from '../storage/database.js'
import { asPatternEvidenceRelation, type PatternEvidenceRow } from '../storage/schema.js'

const COLUMNS = 'pattern_id, memory_id, relation, weight, created_at'

export interface PatternEvidenceRepositoryDeps {
  db: MemoryDatabase
  now?: () => number
}

export class PatternEvidenceRepository {
  private readonly db: MemoryDatabase
  private readonly now: () => number

  constructor(deps: PatternEvidenceRepositoryDeps) {
    this.db = deps.db
    this.now = deps.now ?? (() => Date.now())
  }

  /** 幂等写入：同一 (pattern, memory, relation) 只保留一行。 */
  insert(input: {
    patternId: string
    memoryId: string
    relation: PatternEvidenceRelation
    weight?: number
    createdAt?: number
  }): boolean {
    const result = this.db.run(
      `INSERT OR IGNORE INTO pattern_evidence (${COLUMNS}) VALUES (?, ?, ?, ?, ?)`,
      input.patternId,
      input.memoryId,
      input.relation,
      clampWeight(input.weight ?? 1),
      input.createdAt ?? this.now(),
    )
    return result.changes > 0
  }

  /**
   * 批量写入，返回**真正新增**的条数。
   * 这个返回值是 Pattern 幂等的关键：support_count 只在真的新增证据时才增长（spec §53）。
   */
  insertMany(
    patternId: string,
    memoryIds: readonly string[],
    relation: PatternEvidenceRelation,
    weight = 1,
  ): number {
    let inserted = 0
    this.db.transaction(() => {
      for (const memoryId of unique(memoryIds)) {
        if (this.insert({ patternId, memoryId, relation, weight })) inserted += 1
      }
    })
    return inserted
  }

  listByPattern(patternId: string): PatternEvidence[] {
    const rows = this.db.all<PatternEvidenceRow>(
      `SELECT ${COLUMNS} FROM pattern_evidence WHERE pattern_id = ? ORDER BY created_at ASC`,
      patternId,
    )
    return rows.map(mapPatternEvidenceRow)
  }

  listByMemory(memoryId: string): PatternEvidence[] {
    const rows = this.db.all<PatternEvidenceRow>(
      `SELECT ${COLUMNS} FROM pattern_evidence WHERE memory_id = ? ORDER BY created_at ASC`,
      memoryId,
    )
    return rows.map(mapPatternEvidenceRow)
  }

  countByPattern(patternId: string, relation?: PatternEvidenceRelation): number {
    const row = relation
      ? this.db.get<{ total: number }>(
          'SELECT COUNT(*) AS total FROM pattern_evidence WHERE pattern_id = ? AND relation = ?',
          patternId,
          relation,
        )
      : this.db.get<{ total: number }>('SELECT COUNT(*) AS total FROM pattern_evidence WHERE pattern_id = ?', patternId)
    return Number(row?.total ?? 0)
  }

  hasEvidence(patternId: string, memoryId: string, relation?: PatternEvidenceRelation): boolean {
    const row = relation
      ? this.db.get<{ pattern_id: string }>(
          'SELECT pattern_id FROM pattern_evidence WHERE pattern_id = ? AND memory_id = ? AND relation = ?',
          patternId,
          memoryId,
          relation,
        )
      : this.db.get<{ pattern_id: string }>(
          'SELECT pattern_id FROM pattern_evidence WHERE pattern_id = ? AND memory_id = ?',
          patternId,
          memoryId,
        )
    return Boolean(row)
  }

  /** 支持这条知识的全部模式（memory → patterns）。 */
  listPatternIdsByMemory(
    memoryId: string,
    options: { relation?: PatternEvidenceRelation; limit?: number } = {},
  ): string[] {
    const clauses = ['memory_id = ?']
    const params: SqlValue[] = [memoryId]
    if (options.relation) {
      clauses.push('relation = ?')
      params.push(options.relation)
    }
    params.push(clampLimit(options.limit ?? 200))
    return this.db
      .all<{ pattern_id: string }>(
        `SELECT DISTINCT pattern_id FROM pattern_evidence WHERE ${clauses.join(' AND ')}
          ORDER BY created_at ASC LIMIT ?`,
        ...params,
      )
      .map((row) => row.pattern_id)
  }

  /** 模式背后的知识 id（按 supports / contradicts 过滤，供 recall 展开与 inspect 使用）。 */
  listMemoryIds(
    patternId: string,
    relation: PatternEvidenceRelation = 'supports',
    limit = 200,
  ): string[] {
    return this.db
      .all<{ memory_id: string }>(
        `SELECT memory_id FROM pattern_evidence WHERE pattern_id = ? AND relation = ?
          ORDER BY created_at ASC LIMIT ?`,
        patternId,
        relation,
        clampLimit(limit),
      )
      .map((row) => row.memory_id)
  }

  /** 一个模式有多少条「类目内」证据（用于 status / 详情展示）。 */
  countByMemory(memoryId: string): number {
    const row = this.db.get<{ total: number }>('SELECT COUNT(*) AS total FROM pattern_evidence WHERE memory_id = ?', memoryId)
    return Number(row?.total ?? 0)
  }
}

export function mapPatternEvidenceRow(row: PatternEvidenceRow): PatternEvidence {
  return {
    patternId: row.pattern_id,
    memoryId: row.memory_id,
    relation: asPatternEvidenceRelation(row.relation),
    weight: clampWeight(Number(row.weight ?? 1)),
    createdAt: Number(row.created_at ?? 0),
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))]
}

function clampWeight(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(1, Math.max(0.1, value))
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return 200
  return Math.min(10_000, Math.max(1, Math.round(value)))
}
