/**
 * attempt-repository.ts —— skill_attempts / skill_outcome_evidence / skill_reviews 的访问层。
 *
 * 三条不可退让的约束：
 *   1. 外部幂等键：UNIQUE(scope_id, external_key)，同一执行重试不会变成两次尝试；
 *   2. 完成的 Attempt 不可静默改写：complete 只在 planned/running 上生效，
 *      更正必须新开一条带 corrections_attempt_id 的 Attempt；
 *   3. 审核记录 append-only：没有 updateReview / deleteReview。
 */

import { randomUUID } from 'node:crypto'
import type {
  EvidenceType,
  SkillAttempt,
  SkillAttemptResult,
  SkillAttemptStatus,
  SkillAttribution,
  SkillOutcomeEvidence,
  SkillOutcomeRelation,
  SkillReviewDecision,
  SkillReviewRecord,
  SuccessCriterion,
} from '../types.js'
import type { MemoryDatabase, SqlValue } from '../storage/database.js'
import { scopeWhere } from '../storage/schema.js'

const ATTEMPT_COLUMNS = [
  'id',
  'scope_id',
  'candidate_id',
  'version_id',
  'external_key',
  'status',
  'result',
  'attribution',
  'success_criteria_snapshot_json',
  'started_at',
  'ended_at',
  'note',
  'corrections_attempt_id',
  'created_at',
  'updated_at',
].join(', ')

const OUTCOME_COLUMNS = [
  'attempt_id',
  'scope_id',
  'version_id',
  'evidence_type',
  'evidence_id',
  'relation',
  'attribution',
  'weight',
  'observed_at',
  'created_at',
].join(', ')

const REVIEW_COLUMNS = [
  'id',
  'scope_id',
  'candidate_id',
  'version_id',
  'decision',
  'reviewer',
  'reason',
  'from_status',
  'to_status',
  'created_at',
].join(', ')

interface AttemptRow {
  id: string
  scope_id: string
  candidate_id: string
  version_id: string
  external_key: string
  status: string
  result: string | null
  attribution: string
  success_criteria_snapshot_json: string
  started_at: number
  ended_at: number | null
  note: string | null
  corrections_attempt_id: string | null
  created_at: number
  updated_at: number
}

interface OutcomeRow {
  attempt_id: string
  scope_id: string
  version_id: string
  evidence_type: string
  evidence_id: string
  relation: string
  attribution: string
  weight: number
  observed_at: number
  created_at: number
}

interface ReviewRow {
  id: string
  scope_id: string
  candidate_id: string
  version_id: string
  decision: string
  reviewer: string
  reason: string
  from_status: string
  to_status: string
  created_at: number
}

export interface CreateAttemptInput {
  id?: string
  scopeId: string
  candidateId: string
  versionId: string
  externalKey: string
  status?: SkillAttemptStatus
  attribution?: SkillAttribution
  successCriteriaSnapshot?: readonly SuccessCriterion[]
  startedAt: number
  endedAt?: number
  note?: string
  correctionsAttemptId?: string
  createdAt?: number
}

export interface CompleteAttemptInput {
  result: SkillAttemptResult
  attribution?: SkillAttribution
  endedAt?: number
  note?: string
}

export interface NewOutcomeEvidence {
  evidenceType: EvidenceType | 'manual'
  evidenceId: string
  relation: SkillOutcomeRelation
  attribution?: SkillAttribution
  weight?: number
  observedAt?: number
}

export class SkillAttemptRepository {
  private readonly db: MemoryDatabase
  private readonly now: () => number

  constructor(deps: { db: MemoryDatabase; now?: () => number }) {
    this.db = deps.db
    this.now = deps.now ?? (() => Date.now())
  }

  /** 幂等创建：命中 (scope_id, external_key) 时返回已有尝试，created=false。 */
  create(input: CreateAttemptInput): { attempt: SkillAttempt; created: boolean } {
    const at = input.createdAt ?? this.now()
    const id = input.id ?? `ska_${randomUUID()}`
    const result = this.db.run(
      `INSERT OR IGNORE INTO skill_attempts (${ATTEMPT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.scopeId,
      input.candidateId,
      input.versionId,
      input.externalKey,
      input.status ?? 'planned',
      null,
      input.attribution ?? 'none',
      JSON.stringify(input.successCriteriaSnapshot ?? []),
      input.startedAt,
      input.endedAt ?? null,
      input.note ?? null,
      input.correctionsAttemptId ?? null,
      at,
      at,
    )
    if (result.changes > 0) {
      const created = this.getById(input.scopeId, id)
      if (created) return { attempt: created, created: true }
    }
    const existing = this.getByExternalKey(input.scopeId, input.externalKey)
    if (!existing) throw new Error(`创建 Attempt 失败且找不到已有记录: ${input.externalKey}`)
    return { attempt: existing, created: false }
  }

  getById(scopeId: string, id: string): SkillAttempt | null {
    const row = this.db.get<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM skill_attempts WHERE id = ? AND scope_id = ?`,
      id,
      scopeId,
    )
    return row ? mapAttemptRow(row) : null
  }

  getByIdAnyScope(id: string): SkillAttempt | null {
    const row = this.db.get<AttemptRow>(`SELECT ${ATTEMPT_COLUMNS} FROM skill_attempts WHERE id = ?`, id)
    return row ? mapAttemptRow(row) : null
  }

  getByExternalKey(scopeId: string, externalKey: string): SkillAttempt | null {
    const row = this.db.get<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM skill_attempts WHERE scope_id = ? AND external_key = ?`,
      scopeId,
      externalKey,
    )
    return row ? mapAttemptRow(row) : null
  }

  setStatus(id: string, status: SkillAttemptStatus, at = this.now()): boolean {
    const result = this.db.run(
      `UPDATE skill_attempts SET status = ?, updated_at = ?
        WHERE id = ? AND status NOT IN ('completed', 'aborted')`,
      status,
      at,
      id,
    )
    return result.changes > 0
  }

  /**
   * 完成一次尝试。已经 completed/aborted 的记录不会被改写（返回 false），
   * 需要更正时由调用方新开一条带 correctionsAttemptId 的尝试。
   */
  complete(id: string, input: CompleteAttemptInput): boolean {
    const at = input.endedAt ?? this.now()
    const result = this.db.run(
      `UPDATE skill_attempts
          SET status = 'completed', result = ?, attribution = COALESCE(?, attribution),
              ended_at = ?, note = COALESCE(?, note), updated_at = ?
        WHERE id = ? AND status IN ('planned', 'running')`,
      input.result,
      input.attribution ?? null,
      at,
      input.note ?? null,
      at,
      id,
    )
    return result.changes > 0
  }

  abort(id: string, note?: string, at = this.now()): boolean {
    const result = this.db.run(
      `UPDATE skill_attempts SET status = 'aborted', note = COALESCE(?, note), ended_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('planned', 'running')`,
      note ?? null,
      at,
      at,
      id,
    )
    return result.changes > 0
  }

  list(scopeId: string, options: { versionId?: string; candidateId?: string; limit?: number } = {}): SkillAttempt[] {
    const scope = scopeWhere(scopeId)
    const clauses: string[] = [scope.clause]
    const params: SqlValue[] = [...scope.params]
    if (options.versionId) {
      clauses.push('version_id = ?')
      params.push(options.versionId)
    }
    if (options.candidateId) {
      clauses.push('candidate_id = ?')
      params.push(options.candidateId)
    }
    params.push(clampLimit(options.limit ?? 200))
    return this.db
      .all<AttemptRow>(
        `SELECT ${ATTEMPT_COLUMNS} FROM skill_attempts WHERE ${clauses.join(' AND ')}
          ORDER BY started_at DESC LIMIT ?`,
        ...params,
      )
      .map(mapAttemptRow)
  }

  countStats(scopeId: string): { total: number; completed: number } {
    const row = this.db.get<{ total: number; completed: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
         FROM skill_attempts WHERE scope_id = ?`,
      scopeId,
    )
    return { total: Number(row?.total ?? 0), completed: Number(row?.completed ?? 0) }
  }

  // ------------------------------------------------------------ Outcome Evidence

  /** 幂等写入：同一 (attempt, evidence_type, evidence_id) 只保留一行。 */
  addOutcome(attemptId: string, scopeId: string, versionId: string, input: NewOutcomeEvidence): boolean {
    const at = this.now()
    const result = this.db.run(
      `INSERT OR IGNORE INTO skill_outcome_evidence (${OUTCOME_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      attemptId,
      scopeId,
      versionId,
      input.evidenceType,
      input.evidenceId,
      input.relation,
      input.attribution ?? 'direct',
      clampWeight(input.weight ?? 1),
      input.observedAt ?? at,
      at,
    )
    return result.changes > 0
  }

  listOutcome(attemptId: string): SkillOutcomeEvidence[] {
    return this.db
      .all<OutcomeRow>(
        `SELECT ${OUTCOME_COLUMNS} FROM skill_outcome_evidence WHERE attempt_id = ? ORDER BY observed_at ASC`,
        attemptId,
      )
      .map(mapOutcomeRow)
  }

  listOutcomeByVersion(scopeId: string, versionId: string, limit = 500): SkillOutcomeEvidence[] {
    return this.db
      .all<OutcomeRow>(
        `SELECT ${OUTCOME_COLUMNS} FROM skill_outcome_evidence WHERE scope_id = ? AND version_id = ?
          ORDER BY observed_at ASC LIMIT ?`,
        scopeId,
        versionId,
        clampLimit(limit),
      )
      .map(mapOutcomeRow)
  }

  /** 一次取回某版本所有尝试的证据，供成熟度评估用（避免 N+1 查询）。 */
  outcomeByAttempt(scopeId: string, versionId: string): Map<string, SkillOutcomeEvidence[]> {
    const map = new Map<string, SkillOutcomeEvidence[]>()
    for (const item of this.listOutcomeByVersion(scopeId, versionId)) {
      const list = map.get(item.attemptId)
      if (list) list.push(item)
      else map.set(item.attemptId, [item])
    }
    return map
  }

  // ------------------------------------------------------------------ Reviews

  createReview(input: {
    id?: string
    scopeId: string
    candidateId: string
    versionId: string
    decision: SkillReviewDecision
    reviewer: string
    reason: string
    fromStatus: string
    toStatus: string
    createdAt?: number
  }): SkillReviewRecord {
    const at = input.createdAt ?? this.now()
    const review: SkillReviewRecord = {
      id: input.id ?? `skr_${randomUUID()}`,
      scopeId: input.scopeId,
      candidateId: input.candidateId,
      versionId: input.versionId,
      decision: input.decision,
      reviewer: input.reviewer,
      reason: input.reason,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      createdAt: at,
    }
    this.db.run(
      `INSERT INTO skill_reviews (${REVIEW_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      review.id,
      review.scopeId,
      review.candidateId,
      review.versionId,
      review.decision,
      review.reviewer,
      review.reason,
      review.fromStatus,
      review.toStatus,
      review.createdAt,
    )
    return review
  }

  listReviews(scopeId: string, candidateId: string, limit = 100): SkillReviewRecord[] {
    return this.db
      .all<ReviewRow>(
        `SELECT ${REVIEW_COLUMNS} FROM skill_reviews WHERE scope_id = ? AND candidate_id = ?
          ORDER BY created_at ASC LIMIT ?`,
        scopeId,
        candidateId,
        clampLimit(limit),
      )
      .map(mapReviewRow)
  }

  latestReview(scopeId: string, candidateId: string): SkillReviewRecord | null {
    const row = this.db.get<ReviewRow>(
      `SELECT ${REVIEW_COLUMNS} FROM skill_reviews WHERE scope_id = ? AND candidate_id = ?
        ORDER BY created_at DESC LIMIT 1`,
      scopeId,
      candidateId,
    )
    return row ? mapReviewRow(row) : null
  }
}

export function mapAttemptRow(row: AttemptRow): SkillAttempt {
  return {
    id: row.id,
    scopeId: row.scope_id,
    candidateId: row.candidate_id,
    versionId: row.version_id,
    externalKey: row.external_key,
    status: row.status as SkillAttemptStatus,
    ...(row.result ? { result: row.result as SkillAttemptResult } : {}),
    attribution: row.attribution as SkillAttribution,
    successCriteriaSnapshot: parseJson<SuccessCriterion[]>(row.success_criteria_snapshot_json, []),
    startedAt: Number(row.started_at ?? 0),
    ...(row.ended_at ? { endedAt: Number(row.ended_at) } : {}),
    ...(row.note ? { note: row.note } : {}),
    ...(row.corrections_attempt_id ? { correctionsAttemptId: row.corrections_attempt_id } : {}),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  }
}

export function mapOutcomeRow(row: OutcomeRow): SkillOutcomeEvidence {
  return {
    attemptId: row.attempt_id,
    scopeId: row.scope_id,
    versionId: row.version_id,
    evidenceType: row.evidence_type as SkillOutcomeEvidence['evidenceType'],
    evidenceId: row.evidence_id,
    relation: row.relation as SkillOutcomeRelation,
    attribution: row.attribution as SkillAttribution,
    weight: clampWeight(Number(row.weight ?? 1)),
    observedAt: Number(row.observed_at ?? 0),
    createdAt: Number(row.created_at ?? 0),
  }
}

function mapReviewRow(row: ReviewRow): SkillReviewRecord {
  return {
    id: row.id,
    scopeId: row.scope_id,
    candidateId: row.candidate_id,
    versionId: row.version_id,
    decision: row.decision as SkillReviewDecision,
    reviewer: row.reviewer,
    reason: row.reason,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    createdAt: Number(row.created_at ?? 0),
  }
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function clampWeight(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(1, Math.max(0.1, value))
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return 50
  return Math.min(10_000, Math.max(1, Math.round(value)))
}
