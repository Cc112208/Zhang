/**
 * memory-repository.ts —— memories 表的唯一访问入口（spec §32）。
 *
 * 与 ExperienceRepository 的关键区别：
 *   - Experience.content 绝对不可改写；Memory 是派生知识，允许 updateContent。
 *   - Memory 必须带 Evidence（由 evidence-repository 负责，这里只保证不会写出无证据的语义）。
 *   - 历史不删除：supersede 只改 status / superseded_by / valid_until。
 */

import type {
  CreateMemoryInput,
  MemoryKind,
  MemoryLexicalHit,
  MemoryQuery,
  MemoryReviewStatus,
  MemoryStatus,
  ProcessingStatus,
  SemanticMemory,
} from '../types.js'
import type { MemoryDatabase, SqlValue } from '../storage/database.js'
import {
  asMemoryKind,
  asMemoryReviewStatus,
  asMemoryStatus,
  asProcessingStatus,
  scopeWhere,
  type MemoryRow,
} from '../storage/schema.js'
import { likeTerms, toFtsQuery, toFtsText } from '../recall/tokenizer.js'
import { createMemoryId, normalizeMemoryContent } from './memory-normalizer.js'

const COLUMNS = [
  'id',
  'scope_id',
  'kind',
  'subject',
  'content',
  'normalized_content',
  'confidence',
  'importance',
  'status',
  'valid_from',
  'valid_until',
  'created_at',
  'updated_at',
  'last_reinforced_at',
  'last_accessed_at',
  'reinforcement_count',
  'access_count',
  'superseded_by',
  'embedding_status',
  'last_reviewed_at',
  'review_status',
].join(', ')

export interface MemoryRepositoryDeps {
  db: MemoryDatabase
  now?: () => number
}

export class MemoryRepository {
  private readonly db: MemoryDatabase
  private readonly now: () => number

  constructor(deps: MemoryRepositoryDeps) {
    this.db = deps.db
    this.now = deps.now ?? (() => Date.now())
  }

  /** 创建一条知识。id 由调用方给（applier 需要先知道 id 才能写 evidence），缺省自动生成。 */
  create(input: CreateMemoryInput): SemanticMemory {
    const at = this.now()
    const content = input.content.trim()
    const id = input.id ?? createMemoryId()
    const normalized = input.normalizedContent ?? normalizeMemoryContent(content)
    const memory: SemanticMemory = {
      id,
      scopeId: input.scopeId,
      kind: input.kind,
      ...(input.subject ? { subject: input.subject } : {}),
      content,
      normalizedContent: normalized,
      confidence: clamp01(input.confidence ?? 0.6),
      importance: clamp01(input.importance ?? 0.5),
      status: 'active',
      ...(input.validFrom === undefined ? { validFrom: at } : { validFrom: input.validFrom }),
      createdAt: at,
      updatedAt: at,
      reinforcementCount: 0,
      accessCount: 0,
      embeddingStatus: input.embeddingStatus ?? 'pending',
      reviewStatus: 'fresh',
    }
    this.db.run(
      `INSERT INTO memories (${COLUMNS}) VALUES (${placeholders(21)})`,
      memory.id,
      memory.scopeId,
      memory.kind,
      memory.subject ?? null,
      memory.content,
      memory.normalizedContent ?? null,
      memory.confidence,
      memory.importance,
      memory.status,
      memory.validFrom ?? null,
      memory.validUntil ?? null,
      memory.createdAt,
      memory.updatedAt,
      memory.lastReinforcedAt ?? null,
      memory.lastAccessedAt ?? null,
      memory.reinforcementCount,
      memory.accessCount,
      memory.supersededBy ?? null,
      memory.embeddingStatus,
      memory.lastReviewedAt ?? null,
      memory.reviewStatus ?? 'fresh',
    )
    this.refreshSearchIndex(memory.id)
    return memory
  }

  getById(id: string): SemanticMemory | null {
    const row = this.db.get<MemoryRow>(`SELECT ${COLUMNS} FROM memories WHERE id = ?`, id)
    return row ? mapMemoryRow(row) : null
  }

  listByIds(ids: readonly string[]): SemanticMemory[] {
    if (ids.length === 0) return []
    const rows: MemoryRow[] = []
    for (let start = 0; start < ids.length; start += 400) {
      const chunk = ids.slice(start, start + 400)
      const placeholders = chunk.map(() => '?').join(', ')
      rows.push(
        ...this.db.all<MemoryRow>(`SELECT ${COLUMNS} FROM memories WHERE id IN (${placeholders})`, ...(chunk as SqlValue[])),
      )
    }
    const byId = new Map(rows.map((row) => [row.id, mapMemoryRow(row)]))
    const out: SemanticMemory[] = []
    for (const id of ids) {
      const memory = byId.get(id)
      if (memory) out.push(memory)
    }
    return out
  }

  findActive(scopeId: string, limit = 50): SemanticMemory[] {
    const scope = scopeWhere(scopeId)
    const rows = this.db.all<MemoryRow>(
      `SELECT ${COLUMNS} FROM memories WHERE ${scope.clause} AND status = 'active'
       ORDER BY importance DESC, updated_at DESC LIMIT ?`,
      ...scope.params,
      clampLimit(limit),
    )
    return rows.map(mapMemoryRow)
  }

  /** 按状态 / 类型列出知识；默认只看 active（spec §41 的 includeSuperseded 在这里体现）。 */
  list(scopeId: string, query: MemoryQuery = {}): SemanticMemory[] {
    const scope = scopeWhere(scopeId)
    const clauses: string[] = [scope.clause]
    const params: SqlValue[] = [...scope.params]
    const statuses = toArray(query.status)
    if (statuses.length > 0) {
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`)
      params.push(...statuses)
    } else if (!query.includeSuperseded) {
      clauses.push("status = 'active'")
    }
    const kinds = toArray(query.kind)
    if (kinds.length > 0) {
      clauses.push(`kind IN (${kinds.map(() => '?').join(', ')})`)
      params.push(...kinds)
    }
    params.push(clampLimit(query.limit ?? 50))
    const rows = this.db.all<MemoryRow>(
      `SELECT ${COLUMNS} FROM memories WHERE ${clauses.join(' AND ')}
       ORDER BY importance DESC, updated_at DESC LIMIT ?`,
      ...params,
    )
    return rows.map(mapMemoryRow)
  }

  /** dedup 用：同 scope 下归一化内容完全一致的知识（含 superseded，历史也要看见）。 */
  findByNormalized(scopeId: string, normalizedContent: string, limit = 5): SemanticMemory[] {
    if (normalizedContent.length === 0) return []
    const scope = scopeWhere(scopeId)
    const rows = this.db.all<MemoryRow>(
      `SELECT ${COLUMNS} FROM memories WHERE ${scope.clause} AND normalized_content = ?
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC LIMIT ?`,
      ...scope.params,
      normalizedContent,
      clampLimit(limit),
    )
    return rows.map(mapMemoryRow)
  }

  /**
   * 词法召回：Memory FTS 优先，失败/不可用降级 LIKE（spec §8、§35）。
   * 分数按本次查询最强命中做相对饱和，避免小库里 bm25 量级把真实命中压成 0。
   */
  searchLexical(scopeId: string, query: string, limit = 20, options: { includeSuperseded?: boolean } = {}): MemoryLexicalHit[] {
    const trimmed = query.trim()
    if (trimmed.length === 0) return []
    const statusClause = options.includeSuperseded ? '' : " AND memories.status = 'active'"
    if (this.db.memoryFtsAvailable) {
      const match = toFtsQuery(trimmed)
      if (match) {
        try {
          const scope = scopeWhere(scopeId, 'memories')
          const rows = this.db.all<{ id: string; rank: number }>(
            `SELECT memories_fts.memory_id AS id, bm25(memories_fts) AS rank
               FROM memories_fts
               JOIN memories ON memories.id = memories_fts.memory_id
              WHERE memories_fts MATCH ? AND ${scope.clause}${statusClause}
              ORDER BY rank ASC LIMIT ?`,
            match,
            ...scope.params,
            clampLimit(limit),
          )
          const hits = rows
            .map((row) => ({ id: row.id, strength: Math.max(0, -Number(row.rank ?? 0)) }))
            .filter((row) => row.strength > 0)
          const top = hits.reduce((max, row) => Math.max(max, row.strength), 0)
          return hits.map((row) => ({
            memory: this.getById(row.id) as SemanticMemory,
            score: round4(0.35 + 0.65 * (row.strength / top)),
            strength: round4(row.strength),
          })).filter((hit) => hit.memory !== null)
        } catch {
          // FTS 出错只是精度问题，继续走 LIKE。
        }
      }
    }
    return this.searchLike(scopeId, trimmed, limit, options)
  }

  /** 普通 SQLite fallback：不依赖 FTS5 也能按关键词召回语义记忆。 */
  private searchLike(scopeId: string, query: string, limit: number, options: { includeSuperseded?: boolean }): MemoryLexicalHit[] {
    const terms = likeTerms(query, 8)
    if (terms.length === 0) return []
    const scope = scopeWhere(scopeId)
    const clauses = terms
      .map(() => "(instr(lower(content), lower(?)) > 0 OR instr(lower(COALESCE(subject, '')), lower(?)) > 0)")
      .join(' OR ')
    const params: SqlValue[] = []
    for (const term of terms) params.push(term, term)
    const statusClause = options.includeSuperseded ? '' : " AND status = 'active'"
    const rows = this.db.all<MemoryRow>(
      `SELECT ${COLUMNS} FROM memories WHERE ${scope.clause} AND (${clauses})${statusClause}
       ORDER BY importance DESC, updated_at DESC LIMIT ?`,
      ...scope.params,
      ...params,
      clampLimit(limit),
    )
    return rows.map((row) => ({
      memory: mapMemoryRow(row),
      score: round4(Math.min(1, 0.45 + 0.15 * terms.length)),
      strength: round4(Math.min(1, 0.2 * terms.length)),
    }))
  }

  /** 被新证据支持：计数分开维护（spec §53：reinforcementCount 与 evidence 数量不是一回事）。 */
  reinforce(memoryId: string, options: { confidenceDelta?: number; at?: number } = {}): SemanticMemory | null {
    const at = options.at ?? this.now()
    const current = this.getById(memoryId)
    if (!current) return null
    const delta = clamp01(options.confidenceDelta ?? 0.15)
    const confidence = clamp01(1 - (1 - current.confidence) * (1 - delta))
    this.db.run(
      `UPDATE memories
          SET reinforcement_count = reinforcement_count + 1,
              last_reinforced_at = ?,
              confidence = ?,
              updated_at = ?,
              review_status = 'fresh'
        WHERE id = ?`,
      at,
      confidence,
      at,
      memoryId,
    )
    return this.getById(memoryId)
  }

  /** 同一事实变完整时更新内容（证据链保留在原 evidence 行上，不会被覆盖）。 */
  updateContent(
    memoryId: string,
    patch: { content?: string; subject?: string | null; confidence?: number; importance?: number; kind?: MemoryKind },
    at = this.now(),
  ): SemanticMemory | null {
    const sets: string[] = []
    const params: SqlValue[] = []
    const push = (column: string, value: SqlValue): void => {
      sets.push(`${column} = ?`)
      params.push(value)
    }
    if (patch.content !== undefined) {
      const content = patch.content.trim()
      push('content', content)
      push('normalized_content', normalizeMemoryContent(content))
    }
    if (patch.subject !== undefined) push('subject', patch.subject)
    if (patch.kind !== undefined) push('kind', patch.kind)
    if (patch.confidence !== undefined) push('confidence', clamp01(patch.confidence))
    if (patch.importance !== undefined) push('importance', clamp01(patch.importance))
    if (sets.length === 0) return this.getById(memoryId)
    push('updated_at', at)
    params.push(memoryId)
    this.db.run(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, ...params)
    this.refreshSearchIndex(memoryId)
    return this.getById(memoryId)
  }

  /** 旧知识不删除：标 superseded 并指向替代者（spec §23 / §55）。 */
  markSuperseded(oldMemoryId: string, newMemoryId: string, at = this.now()): SemanticMemory | null {
    this.db.run(
      `UPDATE memories
          SET status = 'superseded',
              superseded_by = ?,
              valid_until = COALESCE(valid_until, ?),
              updated_at = ?
        WHERE id = ? AND status = 'active'`,
      newMemoryId,
      at,
      at,
      oldMemoryId,
    )
    return this.getById(oldMemoryId)
  }

  setStatus(memoryId: string, status: MemoryStatus, at = this.now()): void {
    this.db.run('UPDATE memories SET status = ?, updated_at = ? WHERE id = ?', status, at, memoryId)
  }

  /** 召回访问计数（不参与评分公式的核心，只作为后续 Dream 的输入）。 */
  incrementAccess(memoryIds: readonly string[], at = this.now()): void {
    if (memoryIds.length === 0) return
    this.db.transaction(() => {
      for (const id of memoryIds) {
        this.db.run('UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?', at, id)
      }
    })
  }

  setEmbeddingStatus(memoryId: string, status: ProcessingStatus): void {
    this.db.run('UPDATE memories SET embedding_status = ? WHERE id = ?', status, memoryId)
  }

  listPendingEmbedding(scopeId: string, limit = 50): SemanticMemory[] {
    const scope = scopeWhere(scopeId)
    const rows = this.db.all<MemoryRow>(
      `SELECT ${COLUMNS} FROM memories WHERE ${scope.clause} AND embedding_status = 'pending'
       ORDER BY updated_at ASC LIMIT ?`,
      ...scope.params,
      clampLimit(limit),
    )
    return rows.map(mapMemoryRow)
  }

  /** Memory FTS 文档 = content + subject（中文由 JS bigram 预切）。 */
  refreshSearchIndex(memoryId: string): void {
    if (!this.db.memoryFtsAvailable) return
    try {
      const row = this.db.get<{ content: string; subject: string | null }>(
        'SELECT content, subject FROM memories WHERE id = ?',
        memoryId,
      )
      if (!row) return
      this.db.run('DELETE FROM memories_fts WHERE memory_id = ?', memoryId)
      this.db.run(
        'INSERT INTO memories_fts (memory_id, content, subject) VALUES (?, ?, ?)',
        memoryId,
        toFtsText(row.content),
        toFtsText(row.subject ?? ''),
      )
    } catch {
      // Memory FTS 只是召回增强，失败不影响知识本身。
    }
  }

  stats(scopeId: string): { active: number; superseded: number; stale: number; total: number } {
    const scope = scopeWhere(scopeId)
    const rows = this.db.all<{ status: string; total: number }>(
      `SELECT status, COUNT(*) AS total FROM memories WHERE ${scope.clause} GROUP BY status`,
      ...scope.params,
    )
    const out = { active: 0, superseded: 0, stale: 0, total: 0 }
    for (const row of rows) {
      const count = Number(row.total ?? 0)
      out.total += count
      if (row.status === 'active') out.active += count
      else if (row.status === 'superseded') out.superseded += count
      else if (row.status === 'stale') out.stale += count
    }
    return out
  }

  count(scopeId: string): number {
    const scope = scopeWhere(scopeId)
    const row = this.db.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM memories WHERE ${scope.clause}`,
      ...scope.params,
    )
    return Number(row?.total ?? 0)
  }

  countActive(scopeId: string): number {
    const scope = scopeWhere(scopeId)
    const row = this.db.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM memories WHERE ${scope.clause} AND status = 'active'`,
      ...scope.params,
    )
    return Number(row?.total ?? 0)
  }

  listScopeIds(): string[] {
    return this.db
      .all<{ scope_id: string }>('SELECT DISTINCT scope_id FROM memories ORDER BY scope_id')
      .map((row) => row.scope_id)
  }

  // ------------------------------------------------------------------ Review（spec §31–§35）

  /**
   * 标记某条知识已经复核过。
   *   决策 keep        → review_status='reviewed'（仍然是 active）
   *   决策 mark_stale  → review_status='stale'（status 由调用方一起改成 stale）
   */
  markReviewed(memoryId: string, status: MemoryReviewStatus, at = this.now()): SemanticMemory | null {
    this.db.run(
      'UPDATE memories SET last_reviewed_at = ?, review_status = ?, updated_at = ? WHERE id = ?',
      at,
      status,
      at,
      memoryId,
    )
    return this.getById(memoryId)
  }

  setReviewStatus(memoryId: string, status: MemoryReviewStatus, at = this.now()): void {
    this.db.run('UPDATE memories SET review_status = ?, updated_at = ? WHERE id = ?', status, at, memoryId)
  }

  /**
   * Review 到期扫描（spec §34）：
   *   - 只看 active（superseded / stale 不再复核）；
   *   - 只看"很久没有被新证据支持"的知识（last_reinforced_at 优先，其次 created_at）；
   *   - 已经标成 review_due 的不重复排队。
   *
   * 注意：久不等于错（spec §33）。这里只是"该看看了"，不改 status。
   */
  listDueForReview(
    scopeId: string,
    options: { staleAfterMs: number; limit?: number; now?: number },
  ): SemanticMemory[] {
    const scope = scopeWhere(scopeId)
    const now = options.now ?? this.now()
    const threshold = now - Math.max(0, options.staleAfterMs)
    const rows = this.db.all<MemoryRow>(
      `SELECT ${COLUMNS} FROM memories
        WHERE ${scope.clause}
          AND status = 'active'
          AND review_status IN ('fresh', 'reviewed')
          AND COALESCE(last_reinforced_at, created_at) < ?
        ORDER BY COALESCE(last_reinforced_at, created_at) ASC LIMIT ?`,
      ...scope.params,
      threshold,
      clampLimit(options.limit ?? 20),
    )
    return rows.map(mapMemoryRow)
  }

  countDueForReview(scopeId: string, staleAfterMs: number, now = this.now()): number {
    const scope = scopeWhere(scopeId)
    const threshold = now - Math.max(0, staleAfterMs)
    const row = this.db.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM memories
        WHERE ${scope.clause} AND status = 'active' AND review_status IN ('fresh', 'reviewed')
          AND COALESCE(last_reinforced_at, created_at) < ?`,
      ...scope.params,
      threshold,
    )
    return Number(row?.total ?? 0)
  }
}

export function mapMemoryRow(row: MemoryRow): SemanticMemory {
  return {
    id: row.id,
    scopeId: row.scope_id,
    kind: asMemoryKind(row.kind),
    ...(row.subject ? { subject: row.subject } : {}),
    content: row.content,
    ...(row.normalized_content ? { normalizedContent: row.normalized_content } : {}),
    confidence: clamp01(Number(row.confidence)),
    importance: clamp01(Number(row.importance)),
    status: asMemoryStatus(row.status),
    ...(row.valid_from === null || row.valid_from === undefined ? {} : { validFrom: Number(row.valid_from) }),
    ...(row.valid_until === null || row.valid_until === undefined ? {} : { validUntil: Number(row.valid_until) }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.last_reinforced_at === null || row.last_reinforced_at === undefined
      ? {}
      : { lastReinforcedAt: Number(row.last_reinforced_at) }),
    ...(row.last_accessed_at === null || row.last_accessed_at === undefined
      ? {}
      : { lastAccessedAt: Number(row.last_accessed_at) }),
    reinforcementCount: Number(row.reinforcement_count ?? 0),
    accessCount: Number(row.access_count ?? 0),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    embeddingStatus: asProcessingStatus(row.embedding_status, 'pending'),
    ...(row.last_reviewed_at === null || row.last_reviewed_at === undefined
      ? {}
      : { lastReviewedAt: Number(row.last_reviewed_at) }),
    reviewStatus: asMemoryReviewStatus(row.review_status),
  }
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ')
}

function toArray<T extends string>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return 50
  return Math.min(10_000, Math.max(1, Math.round(value)))
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
