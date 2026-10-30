/**
 * attempt-repository.ts —— skill_attempts / skill_outcome_evidence / skill_reviews 的访问层。
 *
 * 三条不可退让的约束：
 *   1. 外部幂等键：UNIQUE(scope_id, external_key)，同一执行重试不会变成两次尝试；
 *   2. 完成的 Attempt 不可静默改写：complete 只在 planned/running 上生效，
 *      更正必须新开一条带 corrections_attempt_id 的 Attempt；
 *   3. 审核记录 append-only：没有 updateReview / deleteReview。
 */
import { randomUUID } from 'node:crypto';
import { scopeWhere } from '../storage/schema.js';
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
].join(', ');
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
].join(', ');
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
].join(', ');
export class SkillAttemptRepository {
    db;
    now;
    constructor(deps) {
        this.db = deps.db;
        this.now = deps.now ?? (() => Date.now());
    }
    /** 幂等创建：命中 (scope_id, external_key) 时返回已有尝试，created=false。 */
    create(input) {
        const at = input.createdAt ?? this.now();
        const id = input.id ?? `ska_${randomUUID()}`;
        const result = this.db.run(`INSERT OR IGNORE INTO skill_attempts (${ATTEMPT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, input.scopeId, input.candidateId, input.versionId, input.externalKey, input.status ?? 'planned', null, input.attribution ?? 'none', JSON.stringify(input.successCriteriaSnapshot ?? []), input.startedAt, input.endedAt ?? null, input.note ?? null, input.correctionsAttemptId ?? null, at, at);
        if (result.changes > 0) {
            const created = this.getById(input.scopeId, id);
            if (created)
                return { attempt: created, created: true };
        }
        const existing = this.getByExternalKey(input.scopeId, input.externalKey);
        if (!existing)
            throw new Error(`创建 Attempt 失败且找不到已有记录: ${input.externalKey}`);
        return { attempt: existing, created: false };
    }
    getById(scopeId, id) {
        const row = this.db.get(`SELECT ${ATTEMPT_COLUMNS} FROM skill_attempts WHERE id = ? AND scope_id = ?`, id, scopeId);
        return row ? mapAttemptRow(row) : null;
    }
    getByIdAnyScope(id) {
        const row = this.db.get(`SELECT ${ATTEMPT_COLUMNS} FROM skill_attempts WHERE id = ?`, id);
        return row ? mapAttemptRow(row) : null;
    }
    getByExternalKey(scopeId, externalKey) {
        const row = this.db.get(`SELECT ${ATTEMPT_COLUMNS} FROM skill_attempts WHERE scope_id = ? AND external_key = ?`, scopeId, externalKey);
        return row ? mapAttemptRow(row) : null;
    }
    setStatus(id, status, at = this.now()) {
        const result = this.db.run(`UPDATE skill_attempts SET status = ?, updated_at = ?
        WHERE id = ? AND status NOT IN ('completed', 'aborted')`, status, at, id);
        return result.changes > 0;
    }
    /**
     * 完成一次尝试。已经 completed/aborted 的记录不会被改写（返回 false），
     * 需要更正时由调用方新开一条带 correctionsAttemptId 的尝试。
     */
    complete(id, input) {
        const at = input.endedAt ?? this.now();
        const result = this.db.run(`UPDATE skill_attempts
          SET status = 'completed', result = ?, attribution = COALESCE(?, attribution),
              ended_at = ?, note = COALESCE(?, note), updated_at = ?
        WHERE id = ? AND status IN ('planned', 'running')`, input.result, input.attribution ?? null, at, input.note ?? null, at, id);
        return result.changes > 0;
    }
    abort(id, note, at = this.now()) {
        const result = this.db.run(`UPDATE skill_attempts SET status = 'aborted', note = COALESCE(?, note), ended_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('planned', 'running')`, note ?? null, at, at, id);
        return result.changes > 0;
    }
    list(scopeId, options = {}) {
        const scope = scopeWhere(scopeId);
        const clauses = [scope.clause];
        const params = [...scope.params];
        if (options.versionId) {
            clauses.push('version_id = ?');
            params.push(options.versionId);
        }
        if (options.candidateId) {
            clauses.push('candidate_id = ?');
            params.push(options.candidateId);
        }
        params.push(clampLimit(options.limit ?? 200));
        return this.db
            .all(`SELECT ${ATTEMPT_COLUMNS} FROM skill_attempts WHERE ${clauses.join(' AND ')}
          ORDER BY started_at DESC LIMIT ?`, ...params)
            .map(mapAttemptRow);
    }
    countStats(scopeId) {
        const row = this.db.get(`SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
         FROM skill_attempts WHERE scope_id = ?`, scopeId);
        return { total: Number(row?.total ?? 0), completed: Number(row?.completed ?? 0) };
    }
    // ------------------------------------------------------------ Outcome Evidence
    /** 幂等写入：同一 (attempt, evidence_type, evidence_id) 只保留一行。 */
    addOutcome(attemptId, scopeId, versionId, input) {
        const at = this.now();
        const result = this.db.run(`INSERT OR IGNORE INTO skill_outcome_evidence (${OUTCOME_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, attemptId, scopeId, versionId, input.evidenceType, input.evidenceId, input.relation, input.attribution ?? 'direct', clampWeight(input.weight ?? 1), input.observedAt ?? at, at);
        return result.changes > 0;
    }
    listOutcome(attemptId) {
        return this.db
            .all(`SELECT ${OUTCOME_COLUMNS} FROM skill_outcome_evidence WHERE attempt_id = ? ORDER BY observed_at ASC`, attemptId)
            .map(mapOutcomeRow);
    }
    listOutcomeByVersion(scopeId, versionId, limit = 500) {
        return this.db
            .all(`SELECT ${OUTCOME_COLUMNS} FROM skill_outcome_evidence WHERE scope_id = ? AND version_id = ?
          ORDER BY observed_at ASC LIMIT ?`, scopeId, versionId, clampLimit(limit))
            .map(mapOutcomeRow);
    }
    /** 一次取回某版本所有尝试的证据，供成熟度评估用（避免 N+1 查询）。 */
    outcomeByAttempt(scopeId, versionId) {
        const map = new Map();
        for (const item of this.listOutcomeByVersion(scopeId, versionId)) {
            const list = map.get(item.attemptId);
            if (list)
                list.push(item);
            else
                map.set(item.attemptId, [item]);
        }
        return map;
    }
    // ------------------------------------------------------------------ Reviews
    createReview(input) {
        const at = input.createdAt ?? this.now();
        const review = {
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
        };
        this.db.run(`INSERT INTO skill_reviews (${REVIEW_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, review.id, review.scopeId, review.candidateId, review.versionId, review.decision, review.reviewer, review.reason, review.fromStatus, review.toStatus, review.createdAt);
        return review;
    }
    listReviews(scopeId, candidateId, limit = 100) {
        return this.db
            .all(`SELECT ${REVIEW_COLUMNS} FROM skill_reviews WHERE scope_id = ? AND candidate_id = ?
          ORDER BY created_at ASC LIMIT ?`, scopeId, candidateId, clampLimit(limit))
            .map(mapReviewRow);
    }
    latestReview(scopeId, candidateId) {
        const row = this.db.get(`SELECT ${REVIEW_COLUMNS} FROM skill_reviews WHERE scope_id = ? AND candidate_id = ?
        ORDER BY created_at DESC LIMIT 1`, scopeId, candidateId);
        return row ? mapReviewRow(row) : null;
    }
}
export function mapAttemptRow(row) {
    return {
        id: row.id,
        scopeId: row.scope_id,
        candidateId: row.candidate_id,
        versionId: row.version_id,
        externalKey: row.external_key,
        status: row.status,
        ...(row.result ? { result: row.result } : {}),
        attribution: row.attribution,
        successCriteriaSnapshot: parseJson(row.success_criteria_snapshot_json, []),
        startedAt: Number(row.started_at ?? 0),
        ...(row.ended_at ? { endedAt: Number(row.ended_at) } : {}),
        ...(row.note ? { note: row.note } : {}),
        ...(row.corrections_attempt_id ? { correctionsAttemptId: row.corrections_attempt_id } : {}),
        createdAt: Number(row.created_at ?? 0),
        updatedAt: Number(row.updated_at ?? 0),
    };
}
export function mapOutcomeRow(row) {
    return {
        attemptId: row.attempt_id,
        scopeId: row.scope_id,
        versionId: row.version_id,
        evidenceType: row.evidence_type,
        evidenceId: row.evidence_id,
        relation: row.relation,
        attribution: row.attribution,
        weight: clampWeight(Number(row.weight ?? 1)),
        observedAt: Number(row.observed_at ?? 0),
        createdAt: Number(row.created_at ?? 0),
    };
}
function mapReviewRow(row) {
    return {
        id: row.id,
        scopeId: row.scope_id,
        candidateId: row.candidate_id,
        versionId: row.version_id,
        decision: row.decision,
        reviewer: row.reviewer,
        reason: row.reason,
        fromStatus: row.from_status,
        toStatus: row.to_status,
        createdAt: Number(row.created_at ?? 0),
    };
}
function parseJson(raw, fallback) {
    if (typeof raw !== 'string' || raw.length === 0)
        return fallback;
    try {
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
function clampWeight(value) {
    if (!Number.isFinite(value))
        return 1;
    return Math.min(1, Math.max(0.1, value));
}
function clampLimit(value) {
    if (!Number.isFinite(value))
        return 50;
    return Math.min(10_000, Math.max(1, Math.round(value)));
}
