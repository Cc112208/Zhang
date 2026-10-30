/**
 * candidate-repository.ts —— skill_candidates / skill_candidate_versions 的唯一访问入口。
 *
 * 约定（与 pattern/memory 仓储一致）：
 *   - 只负责数据访问，不做业务判断；
 *   - 所有查询都带 scope_id，绝不允许跨 Scope 读取；
 *   - 版本是不可变快照：这里没有 updateVersion，只有 createVersion / setVersionStatus。
 *
 * Approved is not validated：仓储层完全不理解「批准」的含义，只是一个状态字符串。
 */
import { randomUUID } from 'node:crypto';
import { scopeWhere } from '../storage/schema.js';
const CANDIDATE_COLUMNS = [
    'id',
    'scope_id',
    'source_pattern_id',
    'source_memory_ids_json',
    'title',
    'description',
    'kind',
    'status',
    'current_version_id',
    'latest_version_no',
    'provenance_changed',
    'review_due_at',
    'created_at',
    'updated_at',
].join(', ');
const VERSION_COLUMNS = [
    'id',
    'candidate_id',
    'scope_id',
    'version_no',
    'parent_version_id',
    'status',
    'title',
    'procedure_json',
    'trigger_json',
    'preconditions_json',
    'expected_outcomes_json',
    'exceptions_json',
    'limitations_json',
    'success_criteria_json',
    'evidence_snapshot_json',
    'change_reason',
    'created_by',
    'created_at',
    'updated_at',
].join(', ');
export class SkillCandidateRepository {
    db;
    now;
    constructor(deps) {
        this.db = deps.db;
        this.now = deps.now ?? (() => Date.now());
    }
    /** 交给 Database 的事务封装：Service 用来保证「审核记录 + 状态迁移」原子提交。 */
    transaction(fn) {
        return this.db.transaction(fn);
    }
    create(input) {
        const at = input.createdAt ?? this.now();
        const candidate = {
            id: input.id ?? `skc_${randomUUID()}`,
            scopeId: input.scopeId,
            ...(input.sourcePatternId ? { sourcePatternId: input.sourcePatternId } : {}),
            sourceMemoryIds: [...(input.sourceMemoryIds ?? [])],
            title: input.title.trim(),
            ...(input.description ? { description: input.description } : {}),
            kind: input.kind,
            status: input.status ?? 'drafting',
            latestVersionNo: 0,
            provenanceChanged: false,
            createdAt: at,
            updatedAt: at,
        };
        this.db.run(`INSERT INTO skill_candidates (${CANDIDATE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, candidate.id, candidate.scopeId, candidate.sourcePatternId ?? null, JSON.stringify(candidate.sourceMemoryIds), candidate.title, candidate.description ?? null, candidate.kind, candidate.status, null, 0, 0, null, candidate.createdAt, candidate.updatedAt);
        return candidate;
    }
    getById(scopeId, id) {
        const row = this.db.get(`SELECT ${CANDIDATE_COLUMNS} FROM skill_candidates WHERE id = ? AND scope_id = ?`, id, scopeId);
        return row ? mapCandidateRow(row) : null;
    }
    /** 不带 scope 的内部查询（Service 先拿到实体再校验 scope，用于给出明确错误）。 */
    getByIdAnyScope(id) {
        const row = this.db.get(`SELECT ${CANDIDATE_COLUMNS} FROM skill_candidates WHERE id = ?`, id);
        return row ? mapCandidateRow(row) : null;
    }
    findByPattern(scopeId, patternId) {
        const row = this.db.get(`SELECT ${CANDIDATE_COLUMNS} FROM skill_candidates WHERE scope_id = ? AND source_pattern_id = ?`, scopeId, patternId);
        return row ? mapCandidateRow(row) : null;
    }
    list(scopeId, query = {}) {
        const scope = scopeWhere(scopeId);
        const clauses = [scope.clause];
        const params = [...scope.params];
        const statuses = toArray(query.status);
        if (statuses.length > 0) {
            clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
            params.push(...statuses);
        }
        const kinds = toArray(query.kind);
        if (kinds.length > 0) {
            clauses.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
            params.push(...kinds);
        }
        params.push(clampLimit(query.limit ?? 50));
        const rows = this.db.all(`SELECT ${CANDIDATE_COLUMNS} FROM skill_candidates WHERE ${clauses.join(' AND ')}
        ORDER BY updated_at DESC LIMIT ?`, ...params);
        return rows.map(mapCandidateRow);
    }
    setStatus(id, status, at = this.now()) {
        const result = this.db.run('UPDATE skill_candidates SET status = ?, updated_at = ? WHERE id = ?', status, at, id);
        return result.changes > 0;
    }
    /** 版本落库后回写候选的当前版本指针。 */
    attachVersion(id, versionId, versionNo, at = this.now()) {
        const result = this.db.run(`UPDATE skill_candidates
          SET current_version_id = ?, latest_version_no = ?, updated_at = ?
        WHERE id = ?`, versionId, versionNo, at, id);
        return result.changes > 0;
    }
    markProvenanceChanged(id, changed, at = this.now()) {
        const result = this.db.run('UPDATE skill_candidates SET provenance_changed = ?, updated_at = ? WHERE id = ?', changed ? 1 : 0, at, id);
        return result.changes > 0;
    }
    touch(id, at = this.now()) {
        this.db.run('UPDATE skill_candidates SET updated_at = ? WHERE id = ?', at, id);
    }
    countStats(scopeId) {
        const rows = this.db.all('SELECT status, COUNT(*) AS total FROM skill_candidates WHERE scope_id = ? GROUP BY status', scopeId);
        const stats = {};
        let total = 0;
        for (const row of rows) {
            const value = Number(row.total ?? 0);
            stats[row.status] = value;
            total += value;
        }
        stats.total = total;
        return stats;
    }
    // ------------------------------------------------------------------ 版本
    createVersion(input) {
        const at = input.createdAt ?? this.now();
        const version = {
            id: input.id ?? `skv_${randomUUID()}`,
            candidateId: input.candidateId,
            scopeId: input.scopeId,
            versionNo: input.versionNo,
            ...(input.parentVersionId ? { parentVersionId: input.parentVersionId } : {}),
            status: input.status ?? 'draft',
            title: input.title.trim(),
            procedure: input.procedure,
            evidenceSnapshot: input.evidenceSnapshot,
            changeReason: input.changeReason.trim(),
            createdBy: input.createdBy.trim(),
            createdAt: at,
            updatedAt: at,
        };
        const { procedure } = version;
        this.db.run(`INSERT INTO skill_candidate_versions (${VERSION_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, version.id, version.candidateId, version.scopeId, version.versionNo, version.parentVersionId ?? null, version.status, version.title, JSON.stringify({ steps: procedure.steps }), JSON.stringify(procedure.triggers), JSON.stringify(procedure.preconditions), JSON.stringify(procedure.expectedOutcomes), JSON.stringify(procedure.exceptions), JSON.stringify(procedure.limitations), JSON.stringify(procedure.successCriteria), JSON.stringify(version.evidenceSnapshot), version.changeReason, version.createdBy, version.createdAt, version.updatedAt);
        return version;
    }
    nextVersionNo(candidateId) {
        const row = this.db.get('SELECT COALESCE(MAX(version_no), 0) + 1 AS next FROM skill_candidate_versions WHERE candidate_id = ?', candidateId);
        return Number(row?.next ?? 1);
    }
    getVersion(scopeId, id) {
        const row = this.db.get(`SELECT ${VERSION_COLUMNS} FROM skill_candidate_versions WHERE id = ? AND scope_id = ?`, id, scopeId);
        return row ? mapVersionRow(row) : null;
    }
    getVersionAnyScope(id) {
        const row = this.db.get(`SELECT ${VERSION_COLUMNS} FROM skill_candidate_versions WHERE id = ?`, id);
        return row ? mapVersionRow(row) : null;
    }
    listVersions(scopeId, candidateId, limit = 50) {
        return this.db
            .all(`SELECT ${VERSION_COLUMNS} FROM skill_candidate_versions
          WHERE scope_id = ? AND candidate_id = ? ORDER BY version_no ASC LIMIT ?`, scopeId, candidateId, clampLimit(limit))
            .map(mapVersionRow);
    }
    setVersionStatus(id, status, at = this.now()) {
        // 只允许状态迁移，不允许改内容：这里没有 updateVersion 是刻意的。
        const result = this.db.run('UPDATE skill_candidate_versions SET status = ?, updated_at = ? WHERE id = ?', status, at, id);
        return result.changes > 0;
    }
}
export function mapCandidateRow(row) {
    return {
        id: row.id,
        scopeId: row.scope_id,
        ...(row.source_pattern_id ? { sourcePatternId: row.source_pattern_id } : {}),
        sourceMemoryIds: parseJson(row.source_memory_ids_json, []),
        title: row.title,
        ...(row.description ? { description: row.description } : {}),
        kind: row.kind,
        status: row.status,
        ...(row.current_version_id ? { currentVersionId: row.current_version_id } : {}),
        latestVersionNo: Number(row.latest_version_no ?? 0),
        provenanceChanged: Number(row.provenance_changed ?? 0) === 1,
        ...(row.review_due_at ? { reviewDueAt: Number(row.review_due_at) } : {}),
        createdAt: Number(row.created_at ?? 0),
        updatedAt: Number(row.updated_at ?? 0),
    };
}
export function mapVersionRow(row) {
    return {
        id: row.id,
        candidateId: row.candidate_id,
        scopeId: row.scope_id,
        versionNo: Number(row.version_no ?? 0),
        ...(row.parent_version_id ? { parentVersionId: row.parent_version_id } : {}),
        status: row.status,
        title: row.title,
        procedure: {
            steps: parseProcedureSteps(row.procedure_json),
            triggers: parseJson(row.trigger_json, []),
            preconditions: parseJson(row.preconditions_json, []),
            expectedOutcomes: parseJson(row.expected_outcomes_json, []),
            exceptions: parseJson(row.exceptions_json, []),
            limitations: parseJson(row.limitations_json, []),
            successCriteria: parseJson(row.success_criteria_json, []),
        },
        evidenceSnapshot: parseJson(row.evidence_snapshot_json, {
            memoryIds: [],
            episodeIds: [],
            experienceIds: [],
            capturedAt: 0,
        }),
        changeReason: row.change_reason,
        createdBy: row.created_by,
        createdAt: Number(row.created_at ?? 0),
        updatedAt: Number(row.updated_at ?? 0),
    };
}
/** procedure_json 兼容两种历史形状：{steps:[...]} 或直接数组。 */
export function parseProcedureSteps(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed))
            return parsed;
        if (parsed && typeof parsed === 'object') {
            const steps = parsed.steps;
            if (Array.isArray(steps))
                return steps;
        }
    }
    catch {
        // 解析失败按空步骤处理：宁可显示「没有步骤」，也不要崩掉只读接口。
    }
    return [];
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
function toArray(value) {
    if (value === undefined)
        return [];
    return Array.isArray(value) ? value : [value];
}
function clampLimit(value) {
    if (!Number.isFinite(value))
        return 50;
    return Math.min(500, Math.max(1, Math.round(value)));
}
