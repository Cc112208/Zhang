/**
 * lexical-recall.ts —— FTS5 关键词召回（spec §12）。
 *
 * 检索字段：Experience.content；Episode.title + summary（summary 为空时由 EpisodeBuilder
 * 把 Experience 原文拼进 body 列，见 episode-repository.refreshSearchIndex）。
 *
 * 降级（spec §21）：FTS 不可用 / MATCH 语法出错时自动走普通 SQLite LIKE（instr）检索。
 * 本模块只负责「谁命中、命中多强」，不做跨 lane 融合。
 */

import type { RecallType } from '../types.js'
import type { MemoryDatabase, SqlValue } from '../storage/database.js'
import { TABLES, scopeWhere } from '../storage/schema.js'
import type { EpisodeRepository } from '../storage/repositories/episode-repository.js'
import type { ExperienceRepository } from '../storage/repositories/experience-repository.js'
import { likeTerms, toFtsQuery } from './tokenizer.js'

export interface LexicalQueryOptions {
  scopeId: string
  types?: readonly RecallType[]
  limit?: number
  after?: number
  before?: number
}

export interface LexicalHit {
  id: string
  type: RecallType
  /** 0..1。FTS 用 bm25 强度做饱和映射；LIKE fallback 用命中词数量估计。 */
  score: number
  /** 内部诊断用：bm25 强度或命中词数量。 */
  strength: number
}

const DEFAULT_LANE_LIMIT = 40

export class LexicalRecall {
  private readonly db: MemoryDatabase
  private readonly experiences: ExperienceRepository
  private readonly episodes: EpisodeRepository

  constructor(deps: {
    db: MemoryDatabase
    experiences: ExperienceRepository
    episodes: EpisodeRepository
  }) {
    this.db = deps.db
    this.experiences = deps.experiences
    this.episodes = deps.episodes
  }

  get ftsAvailable(): boolean {
    return this.db.ftsAvailable
  }

  search(query: string, options: LexicalQueryOptions): LexicalHit[] {
    const types = options.types ?? ['experience', 'episode']
    const limit = clampLimit(options.limit)
    const hits: LexicalHit[] = []

    for (const type of types) {
      if (type === 'experience') hits.push(...this.searchExperiences(query, options, limit))
      else hits.push(...this.searchEpisodes(query, options, limit))
    }
    return hits
  }

  // ---------------------------------------------------------------- Experience lane

  private searchExperiences(query: string, options: LexicalQueryOptions, limit: number): LexicalHit[] {
    if (this.db.ftsAvailable) {
      const ftsHits = this.ftsSearch('experience', query, options, limit)
      if (ftsHits !== null) return ftsHits
    }
    return this.likeSearchExperiences(query, options, limit)
  }

  private searchEpisodes(query: string, options: LexicalQueryOptions, limit: number): LexicalHit[] {
    if (this.db.ftsAvailable) {
      const ftsHits = this.ftsSearch('episode', query, options, limit)
      if (ftsHits !== null) return ftsHits
    }
    return this.likeSearchEpisodes(query, options, limit)
  }

  /** 返回 null 表示 FTS 路径不可用（语法错误等），调用方转 LIKE。 */
  private ftsSearch(
    type: RecallType,
    query: string,
    options: LexicalQueryOptions,
    limit: number,
  ): LexicalHit[] | null {
    const match = toFtsQuery(query)
    if (!match) return []

    // 作用域过滤要带表名前缀（这里同时 join 了 FTS 表与主表）。
    const scoped = scopeWhere(options.scopeId, type === 'experience' ? 'experiences' : 'episodes')
    const params: SqlValue[] = [match, ...scoped.params]
    const timeClause: string[] = []
    if (typeof options.after === 'number') {
      timeClause.push(`${type === 'experience' ? 'experiences.observed_at' : 'COALESCE(episodes.ended_at, episodes.started_at)'} > ?`)
      params.push(options.after)
    }
    if (typeof options.before === 'number') {
      timeClause.push(`${type === 'experience' ? 'experiences.observed_at' : 'COALESCE(episodes.ended_at, episodes.started_at)'} < ?`)
      params.push(options.before)
    }
    params.push(limit)

    const sql =
      type === 'experience'
        ? `SELECT ${TABLES.experienceFts}.experience_id AS id, bm25(${TABLES.experienceFts}) AS rank
           FROM ${TABLES.experienceFts}
           JOIN ${TABLES.experiences} ON ${TABLES.experiences}.id = ${TABLES.experienceFts}.experience_id
           WHERE ${TABLES.experienceFts} MATCH ?
             AND ${scoped.clause}
             ${timeClause.map((clause) => `AND ${clause}`).join(' ')}
           ORDER BY rank ASC
           LIMIT ?`
        : `SELECT ${TABLES.episodeFts}.episode_id AS id, bm25(${TABLES.episodeFts}) AS rank
           FROM ${TABLES.episodeFts}
           JOIN ${TABLES.episodes} ON ${TABLES.episodes}.id = ${TABLES.episodeFts}.episode_id
           WHERE ${TABLES.episodeFts} MATCH ?
             AND ${scoped.clause}
             ${timeClause.map((clause) => `AND ${clause}`).join(' ')}
           ORDER BY rank ASC
           LIMIT ?`

    try {
      const rows = this.db.all<{ id: string; rank: number }>(sql, ...params)
      // bm25 的绝对值随语料规模/文档长度漂移（小库里常见 1e-6 量级），
      // 直接做 strength/(strength+2) 会把真实命中压成 0 分。这里按「本次查询的最强命中」
      // 做相对饱和：最强=1，其它命中落在 0.35..1，保证「命中了」在融合分里看得见。
      const strengths = rows.map((row) => Math.max(0, -Number(row.rank ?? 0)))
      const top = strengths.reduce((max, value) => Math.max(max, value), 0)
      return rows.map((row, index) => {
        const strength = strengths[index] ?? 0
        const score = top > 0 && strength > 0 ? Math.round((0.35 + 0.65 * (strength / top)) * 1e4) / 1e4 : 0
        return { id: row.id, type, strength, score }
      })
    } catch (error) {
      console.warn(`[memory-sea] FTS 查询失败，降级 LIKE: ${(error as Error).message}`)
      return null
    }
  }

  private likeSearchExperiences(query: string, options: LexicalQueryOptions, limit: number): LexicalHit[] {
    const terms = likeTerms(query)
    const rows = this.experiences.findByLike(options.scopeId, terms, {
      limit,
      ...(typeof options.after === 'number' ? { after: options.after } : {}),
      ...(typeof options.before === 'number' ? { before: options.before } : {}),
    })
    return rows.map((row) => {
      const matched = terms.filter((term) => row.content.includes(term)).length
      const strength = matched
      return { id: row.id, type: 'experience' as const, strength, score: likeScore(matched, terms.length) }
    })
  }

  private likeSearchEpisodes(query: string, options: LexicalQueryOptions, limit: number): LexicalHit[] {
    const terms = likeTerms(query)
    const rows = this.episodes.findByLike(options.scopeId, terms, {
      limit,
      ...(typeof options.after === 'number' ? { after: options.after } : {}),
      ...(typeof options.before === 'number' ? { before: options.before } : {}),
    })
    return rows.map((row) => {
      const haystack = `${row.title ?? ''} ${row.summary ?? ''} ${row.topics.join(' ')}`
      const matched = terms.filter((term) => haystack.includes(term)).length
      return { id: row.id, type: 'episode' as const, strength: matched, score: likeScore(matched, terms.length) }
    })
  }
}

function likeScore(matched: number, total: number): number {
  if (matched === 0 || total === 0) return 0
  // 命中占比 60% + 绝对命中数 40%，两者都饱和到 1。
  return Math.min(1, 0.6 * (matched / total) + 0.4 * Math.min(1, matched / 3))
}

function clampLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LANE_LIMIT
  return Math.min(200, Math.max(1, Math.round(value)))
}
