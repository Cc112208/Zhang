/**
 * evidence-repository.ts —— memory_evidence 与 memory_relations 的唯一访问入口
 * （spec §7 / §33 / §54）。
 *
 * 两个硬约束：
 *   1. 证据是一等公民：一行证据 = 一个可查询的关系，绝不塞进 JSON。
 *   2. 证据写入幂等：PK(memory_id, evidence_type, evidence_id, relation) +
 *      INSERT OR IGNORE，重复整理同一个 Episode 不会重复添加证据。
 */

import type {
  EvidenceRelation,
  EvidenceType,
  MemoryEvidence,
} from '../types.js'
import type { MemoryDatabase, SqlValue } from '../storage/database.js'
import {
  asEvidenceRelation,
  asEvidenceType,
  scopeWhere,
  type MemoryEvidenceRow,
} from '../storage/schema.js'

const EVIDENCE_COLUMNS = 'memory_id, evidence_type, evidence_id, relation, weight, created_at'

export interface EvidenceRepositoryDeps {
  db: MemoryDatabase
  now?: () => number
}

export class EvidenceRepository {
  private readonly db: MemoryDatabase
  private readonly now: () => number

  constructor(deps: EvidenceRepositoryDeps) {
    this.db = deps.db
    this.now = deps.now ?? (() => Date.now())
  }

  /** 幂等写入：同一 (memory, evidence, relation) 只保留一行。 */
  insert(input: {
    memoryId: string
    evidenceType: EvidenceType
    evidenceId: string
    relation: EvidenceRelation
    weight?: number
    createdAt?: number
  }): boolean {
    const result = this.db.run(
      `INSERT OR IGNORE INTO memory_evidence (${EVIDENCE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`,
      input.memoryId,
      input.evidenceType,
      input.evidenceId,
      input.relation,
      clampWeight(input.weight ?? 1),
      input.createdAt ?? this.now(),
    )
    return result.changes > 0
  }

  /** 批量写入（Consolidation 一次操作可能带多个 Episode 证据）。 */
  insertMany(
    memoryId: string,
    evidenceType: EvidenceType,
    evidenceIds: readonly string[],
    relation: EvidenceRelation,
    weight = 1,
  ): number {
    let inserted = 0
    this.db.transaction(() => {
      for (const evidenceId of unique(evidenceIds)) {
        if (this.insert({ memoryId, evidenceType, evidenceId, relation, weight })) inserted += 1
      }
    })
    return inserted
  }

  listByMemory(memoryId: string): MemoryEvidence[] {
    const rows = this.db.all<MemoryEvidenceRow>(
      `SELECT ${EVIDENCE_COLUMNS} FROM memory_evidence WHERE memory_id = ? ORDER BY created_at ASC`,
      memoryId,
    )
    return rows.map(mapEvidenceRow)
  }

  countByMemory(memoryId: string): number {
    const row = this.db.get<{ total: number }>(
      'SELECT COUNT(*) AS total FROM memory_evidence WHERE memory_id = ?',
      memoryId,
    )
    return Number(row?.total ?? 0)
  }

  hasEvidence(memoryId: string, evidenceType: EvidenceType, evidenceId: string, relation?: EvidenceRelation): boolean {
    const row = relation
      ? this.db.get<{ memory_id: string }>(
          'SELECT memory_id FROM memory_evidence WHERE memory_id = ? AND evidence_type = ? AND evidence_id = ? AND relation = ?',
          memoryId,
          evidenceType,
          evidenceId,
          relation,
        )
      : this.db.get<{ memory_id: string }>(
          'SELECT memory_id FROM memory_evidence WHERE memory_id = ? AND evidence_type = ? AND evidence_id = ?',
          memoryId,
          evidenceType,
          evidenceId,
        )
    return Boolean(row)
  }

  /** evidence → memories 反向查询（「这个 Episode 支持了哪些知识」）。 */
  listMemoryIdsByEvidence(
    evidenceType: EvidenceType,
    evidenceId: string,
    options: { relation?: EvidenceRelation; limit?: number } = {},
  ): string[] {
    const clauses = ['evidence_type = ?', 'evidence_id = ?']
    const params: SqlValue[] = [evidenceType, evidenceId]
    if (options.relation) {
      clauses.push('relation = ?')
      params.push(options.relation)
    }
    params.push(clampLimit(options.limit ?? 200))
    return this.db
      .all<{ memory_id: string }>(
        `SELECT DISTINCT memory_id FROM memory_evidence WHERE ${clauses.join(' AND ')}
          ORDER BY created_at ASC LIMIT ?`,
        ...params,
      )
      .map((row) => row.memory_id)
  }

  /** Episode 支持的全部知识（含关系型，供 recall 展开与 inspect 使用）。 */
  listEvidenceFor(evidenceType: EvidenceType, evidenceId: string): MemoryEvidence[] {
    const rows = this.db.all<MemoryEvidenceRow>(
      `SELECT ${EVIDENCE_COLUMNS} FROM memory_evidence WHERE evidence_type = ? AND evidence_id = ?
        ORDER BY created_at ASC`,
      evidenceType,
      evidenceId,
    )
    return rows.map(mapEvidenceRow)
  }

  // ------------------------------------------------------------- memory ↔ memory

  /** 记录知识之间的关系（supersede / contradict / related），幂等覆盖权重。 */
  recordRelation(fromMemoryId: string, toMemoryId: string, relation: string, weight = 1): void {
    this.db.run(
      `INSERT INTO memory_relations (from_memory_id, to_memory_id, relation, weight, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(from_memory_id, to_memory_id, relation)
       DO UPDATE SET weight = excluded.weight`,
      fromMemoryId,
      toMemoryId,
      relation,
      clampWeight(weight),
      this.now(),
    )
  }

  listRelations(fromMemoryId: string): Array<{ toMemoryId: string; relation: string; weight: number; createdAt: number }> {
    return this.db
      .all<{ to_memory_id: string; relation: string; weight: number; created_at: number }>(
        'SELECT to_memory_id, relation, weight, created_at FROM memory_relations WHERE from_memory_id = ? ORDER BY created_at ASC',
        fromMemoryId,
      )
      .map((row) => ({
        toMemoryId: row.to_memory_id,
        relation: row.relation,
        weight: Number(row.weight ?? 1),
        createdAt: Number(row.created_at ?? 0),
      }))
  }

  countRelations(scopeId: string): number {
    // memory_relations 没有 scope 列，按 from 端记忆所属 scope 统计。
    const scope = scopeWhere(scopeId, 'memories')
    const row = this.db.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM memory_relations
         JOIN memories ON memories.id = memory_relations.from_memory_id
        WHERE ${scope.clause}`,
      ...scope.params,
    )
    return Number(row?.total ?? 0)
  }
}

export function mapEvidenceRow(row: MemoryEvidenceRow): MemoryEvidence {
  return {
    memoryId: row.memory_id,
    evidenceType: asEvidenceType(row.evidence_type),
    evidenceId: row.evidence_id,
    relation: asEvidenceRelation(row.relation),
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
