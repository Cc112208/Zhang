/**
 * experience-repository.ts —— experiences 表的唯一访问入口。
 *
 * 设计约束（spec §1 / §8）：
 *   - **原始经历不可覆盖**：这里根本没有「更新 content」的方法。写入用 INSERT OR IGNORE，
 *     id 冲突时静默返回 false（上层据此判定重复捕获），绝不做 UPDATE content。
 *   - 唯一允许变更的列是结构性字段：episode_id（归属）与 embedding_status（后台处理状态）。
 *   - 所有查询都带 scope_id：Stage 2 的项目隔离在这里落地，而不是靠调用方自觉。
 */

import type { EmbeddingStatus, Experience, ExperienceSourceType, ExperienceRole } from '../../types.js'
import type { MemoryDatabase, SqlValue } from '../../storage/database.js'
import {
  asEmbeddingStatus,
  asRole,
  asSourceType,
  parseMetadata,
  serializeMetadata,
  scopeColumns,
  scopeWhere,
  type ExperienceRow,
} from '../../storage/schema.js'
import { toFtsText } from '../../recall/tokenizer.js'

const COLUMNS = [
  'id',
  'source_type',
  'source_id',
  'session_id',
  'turn_id',
  'role',
  'content',
  'created_at',
  'observed_at',
  'importance',
  'metadata_json',
  'episode_id',
  'embedding_status',
  'scope_type',
  'scope_id',
  'scope_root',
].join(', ')

export interface ExperienceQueryWindow {
  after?: number
  before?: number
}

export class ExperienceRepository {
  private readonly db: MemoryDatabase

  constructor(deps: { db: MemoryDatabase }) {
    this.db = deps.db
  }

  /**
   * 写入一条原始经历。
   * @returns true=新写入；false=id 已存在（重复捕获，原文保持不变）。
   */
  insert(experience: Experience, scopeId: string): boolean {
    const scope = scopeColumns({ type: 'project', id: scopeId })
    const result = this.db.run(
      `INSERT OR IGNORE INTO experiences (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      experience.id,
      experience.sourceType,
      experience.sourceId ?? null,
      experience.sessionId ?? null,
      experience.turnId ?? null,
      experience.role ?? null,
      experience.content,
      experience.createdAt,
      experience.observedAt,
      experience.importance,
      serializeMetadata(experience.metadata),
      experience.episodeId ?? null,
      experience.embeddingStatus,
      scope.scopeType,
      scope.scopeId,
      scope.scopeRoot,
    )
    if (result.changes === 0) return false

    if (this.db.ftsAvailable) {
      try {
        this.db.run(
          'INSERT INTO experience_fts (experience_id, content) VALUES (?, ?)',
          experience.id,
          toFtsText(experience.content),
        )
      } catch (error) {
        // FTS 写失败不能让 capture 失败：原文已经落库，最坏退化成 LIKE 检索。
        console.warn(`[memory-sea] FTS 索引写入失败: ${String(error)}`)
      }
    }
    return true
  }

  get(id: string): Experience | null {
    const row = this.db.get<ExperienceRow>(`SELECT ${COLUMNS} FROM experiences WHERE id = ?`, id)
    return row ? mapExperienceRow(row) : null
  }

  exists(id: string): boolean {
    return Boolean(this.db.get<{ id: string }>('SELECT id FROM experiences WHERE id = ?', id))
  }

  setEpisodeId(id: string, episodeId: string | null): void {
    this.db.run('UPDATE experiences SET episode_id = ? WHERE id = ?', episodeId, id)
  }

  setEmbeddingStatus(id: string, status: EmbeddingStatus): void {
    this.db.run('UPDATE experiences SET embedding_status = ? WHERE id = ?', status, id)
  }

  /** Episode 内的经历，按发生时间升序（证据链的稳定顺序）。 */
  listByEpisode(episodeId: string): Experience[] {
    const rows = this.db.all<ExperienceRow>(
      `SELECT ${COLUMNS} FROM experiences WHERE episode_id = ? ORDER BY observed_at ASC, created_at ASC, rowid ASC`,
      episodeId,
    )
    return rows.map(mapExperienceRow)
  }

  listByIds(ids: readonly string[]): Experience[] {
    if (ids.length === 0) return []
    const out: Experience[] = []
    // SQLite 变量上限保守取 400，避免大结果集一次绑定过多参数。
    for (let start = 0; start < ids.length; start += 400) {
      const chunk = ids.slice(start, start + 400)
      const placeholders = chunk.map(() => '?').join(', ')
      const rows = this.db.all<ExperienceRow>(
        `SELECT ${COLUMNS} FROM experiences WHERE id IN (${placeholders})`,
        ...(chunk as SqlValue[]),
      )
      out.push(...rows.map(mapExperienceRow))
    }
    return out
  }

  recent(scopeId: string, options: ExperienceQueryWindow & { limit?: number } = {}): Experience[] {
    const scope = scopeWhere(scopeId)
    const time = buildTimeFilters(options, 'observed_at')
    const limit = clampLimit(options.limit ?? 200)
    const rows = this.db.all<ExperienceRow>(
      `SELECT ${COLUMNS} FROM experiences WHERE ${scope.clause} AND ${time.clause}
       ORDER BY observed_at DESC, created_at DESC LIMIT ?`,
      ...scope.params,
      ...time.params,
      limit,
    )
    return rows.map(mapExperienceRow)
  }

  listBySession(sessionId: string, limit = 50): Experience[] {
    const rows = this.db.all<ExperienceRow>(
      `SELECT ${COLUMNS} FROM experiences WHERE session_id = ? ORDER BY observed_at ASC, created_at ASC LIMIT ?`,
      sessionId,
      clampLimit(limit),
    )
    return rows.map(mapExperienceRow)
  }

  /** FTS 不可用时的降级检索：纯 LIKE，能工作但精度低。 */
  findByLike(
    scopeId: string,
    terms: readonly string[],
    options: ExperienceQueryWindow & { limit?: number } = {},
  ): Experience[] {
    const cleaned = terms.filter((term) => term.length > 0)
    if (cleaned.length === 0) return []
    const scope = scopeWhere(scopeId)
    const time = buildTimeFilters(options, 'observed_at')
    const likeClause = cleaned.map(() => 'instr(lower(content), lower(?)) > 0').join(' OR ')
    const rows = this.db.all<ExperienceRow>(
      `SELECT ${COLUMNS} FROM experiences WHERE ${scope.clause} AND (${likeClause}) AND ${time.clause}
       ORDER BY observed_at DESC LIMIT ?`,
      ...scope.params,
      ...(cleaned as SqlValue[]),
      ...time.params,
      clampLimit(options.limit ?? 200),
    )
    return rows.map(mapExperienceRow)
  }

  /**
   * Scene 用：取最近 N 条（内层倒序），外层再按时间升序返回。
   * 内层必须把 rowid 显式选出来当排序列，否则外层引用 rowid 会报 no such column。
   */
  listForScene(scopeId: string, maxPoints: number): Experience[] {
    const scope = scopeWhere(scopeId)
    const rows = this.db.all<ExperienceRow>(
      `SELECT * FROM (
         SELECT ${COLUMNS}, rowid AS seq FROM experiences WHERE ${scope.clause}
         ORDER BY observed_at DESC, created_at DESC LIMIT ?
       ) ORDER BY observed_at ASC, seq ASC`,
      ...scope.params,
      clampLimit(maxPoints),
    )
    return rows.map(mapExperienceRow)
  }

  /** 后台 embedding 任务：找出还没处理过的经历（pending 或曾被标记 failed 的）。 */
  listPendingEmbedding(scopeId: string, limit = 50): Experience[] {
    const scope = scopeWhere(scopeId)
    const rows = this.db.all<ExperienceRow>(
      `SELECT ${COLUMNS} FROM experiences WHERE ${scope.clause} AND embedding_status = 'pending'
       ORDER BY observed_at ASC LIMIT ?`,
      ...scope.params,
      clampLimit(limit),
    )
    return rows.map(mapExperienceRow)
  }

  /**
   * 身份审计取样：按 observed_at 倒序取最近 N 条（只读）。
   * 回填 dry-run 与 status 报告共用同一口径，避免「报告说 A、实际改 B」。
   */
  listForAudit(scopeId: string, limit = 500): Experience[] {
    const scope = scopeWhere(scopeId)
    const rows = this.db.all<ExperienceRow>(
      `SELECT ${COLUMNS} FROM experiences WHERE ${scope.clause}
       ORDER BY observed_at DESC, id ASC LIMIT ?`,
      ...scope.params,
      clampLimit(limit),
    )
    return rows.map(mapExperienceRow)
  }

  /**
   * 只更新 metadata_json。Stage 4.6 的身份规范化回填专用：
   * 原始 content 是不可变证据，任何情况下都不在这里改。
   */
  updateMetadata(id: string, metadata: Record<string, unknown>): boolean {
    const result = this.db.run(
      'UPDATE experiences SET metadata_json = ? WHERE id = ?',
      serializeMetadata(metadata),
      id,
    )
    return Number(result.changes ?? 0) > 0
  }

  /** 数据库里出现过的全部 scope（启动时用于收割陈旧 Episode / 补排任务）。 */
  listScopeIds(): string[] {
    return this.db
      .all<{ scope_id: string }>(
        'SELECT DISTINCT scope_id FROM experiences WHERE scope_id IS NOT NULL ORDER BY scope_id',
      )
      .map((row) => row.scope_id)
  }

  count(scopeId: string): number {
    const scope = scopeWhere(scopeId)
    const row = this.db.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM experiences WHERE ${scope.clause}`,
      ...scope.params,
    )
    return Number(row?.total ?? 0)
  }
}

/** 行 → 领域对象。类型守卫全部走 schema.ts，避免脏数据让整条记录炸掉。 */
export function mapExperienceRow(row: ExperienceRow): Experience {
  return {
    id: row.id,
    sourceType: asSourceType(row.source_type),
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(asRole(row.role) ? { role: asRole(row.role) as ExperienceRole } : {}),
    content: row.content,
    createdAt: Number(row.created_at),
    observedAt: Number(row.observed_at),
    importance: clamp01(Number(row.importance)),
    metadata: parseMetadata(row.metadata_json),
    ...(row.episode_id ? { episodeId: row.episode_id } : {}),
    embeddingStatus: asEmbeddingStatus(row.embedding_status),
    ...(row.scope_id ? { scopeId: row.scope_id } : {}),
  }
}

/** 时间窗口 → WHERE 片段（after/before 都是闭区间，语义与 RecallRequest 一致）。 */
export function buildTimeFilters(
  options: ExperienceQueryWindow,
  column: string,
): { clause: string; params: SqlValue[] } {
  const parts: string[] = ['1 = 1']
  const params: SqlValue[] = []
  if (typeof options.after === 'number' && Number.isFinite(options.after)) {
    parts.push(`${column} >= ?`)
    params.push(options.after)
  }
  if (typeof options.before === 'number' && Number.isFinite(options.before)) {
    parts.push(`${column} <= ?`)
    params.push(options.before)
  }
  return { clause: parts.join(' AND '), params }
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return 200
  return Math.min(10_000, Math.max(1, Math.round(value)))
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 供上层判断来源类型是否值得进 Episode（保留导出，避免各处重复字面量）。 */
export function isKnownSourceType(value: unknown): value is ExperienceSourceType {
  return (
    value === 'chat' || value === 'tool' || value === 'manual' || value === 'diary' || value === 'file' || value === 'web'
  )
}
