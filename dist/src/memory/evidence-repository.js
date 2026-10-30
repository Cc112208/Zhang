/**
 * evidence-repository.ts —— memory_evidence 与 memory_relations 的唯一访问入口
 * （spec §7 / §33 / §54）。
 *
 * 两个硬约束：
 *   1. 证据是一等公民：一行证据 = 一个可查询的关系，绝不塞进 JSON。
 *   2. 证据写入幂等：PK(memory_id, evidence_type, evidence_id, relation) +
 *      INSERT OR IGNORE，重复整理同一个 Episode 不会重复添加证据。
 */
import { asEvidenceRelation, asEvidenceType, scopeWhere, } from '../storage/schema.js';
const EVIDENCE_COLUMNS = 'memory_id, evidence_type, evidence_id, relation, weight, created_at';
export class EvidenceRepository {
    db;
    now;
    constructor(deps) {
        this.db = deps.db;
        this.now = deps.now ?? (() => Date.now());
    }
    /** 幂等写入：同一 (memory, evidence, relation) 只保留一行。 */
    insert(input) {
        const result = this.db.run(`INSERT OR IGNORE INTO memory_evidence (${EVIDENCE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`, input.memoryId, input.evidenceType, input.evidenceId, input.relation, clampWeight(input.weight ?? 1), input.createdAt ?? this.now());
        return result.changes > 0;
    }
    /** 批量写入（Consolidation 一次操作可能带多个 Episode 证据）。 */
    insertMany(memoryId, evidenceType, evidenceIds, relation, weight = 1) {
        let inserted = 0;
        this.db.transaction(() => {
            for (const evidenceId of unique(evidenceIds)) {
                if (this.insert({ memoryId, evidenceType, evidenceId, relation, weight }))
                    inserted += 1;
            }
        });
        return inserted;
    }
    listByMemory(memoryId) {
        const rows = this.db.all(`SELECT ${EVIDENCE_COLUMNS} FROM memory_evidence WHERE memory_id = ? ORDER BY created_at ASC`, memoryId);
        return rows.map(mapEvidenceRow);
    }
    countByMemory(memoryId) {
        const row = this.db.get('SELECT COUNT(*) AS total FROM memory_evidence WHERE memory_id = ?', memoryId);
        return Number(row?.total ?? 0);
    }
    hasEvidence(memoryId, evidenceType, evidenceId, relation) {
        const row = relation
            ? this.db.get('SELECT memory_id FROM memory_evidence WHERE memory_id = ? AND evidence_type = ? AND evidence_id = ? AND relation = ?', memoryId, evidenceType, evidenceId, relation)
            : this.db.get('SELECT memory_id FROM memory_evidence WHERE memory_id = ? AND evidence_type = ? AND evidence_id = ?', memoryId, evidenceType, evidenceId);
        return Boolean(row);
    }
    /** evidence → memories 反向查询（「这个 Episode 支持了哪些知识」）。 */
    listMemoryIdsByEvidence(evidenceType, evidenceId, options = {}) {
        const clauses = ['evidence_type = ?', 'evidence_id = ?'];
        const params = [evidenceType, evidenceId];
        if (options.relation) {
            clauses.push('relation = ?');
            params.push(options.relation);
        }
        params.push(clampLimit(options.limit ?? 200));
        return this.db
            .all(`SELECT DISTINCT memory_id FROM memory_evidence WHERE ${clauses.join(' AND ')}
          ORDER BY created_at ASC LIMIT ?`, ...params)
            .map((row) => row.memory_id);
    }
    /** Episode 支持的全部知识（含关系型，供 recall 展开与 inspect 使用）。 */
    listEvidenceFor(evidenceType, evidenceId) {
        const rows = this.db.all(`SELECT ${EVIDENCE_COLUMNS} FROM memory_evidence WHERE evidence_type = ? AND evidence_id = ?
        ORDER BY created_at ASC`, evidenceType, evidenceId);
        return rows.map(mapEvidenceRow);
    }
    // ------------------------------------------------------------- memory ↔ memory
    /** 记录知识之间的关系（supersede / contradict / related），幂等覆盖权重。 */
    recordRelation(fromMemoryId, toMemoryId, relation, weight = 1) {
        this.db.run(`INSERT INTO memory_relations (from_memory_id, to_memory_id, relation, weight, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(from_memory_id, to_memory_id, relation)
       DO UPDATE SET weight = excluded.weight`, fromMemoryId, toMemoryId, relation, clampWeight(weight), this.now());
    }
    listRelations(fromMemoryId) {
        return this.db
            .all('SELECT to_memory_id, relation, weight, created_at FROM memory_relations WHERE from_memory_id = ? ORDER BY created_at ASC', fromMemoryId)
            .map((row) => ({
            toMemoryId: row.to_memory_id,
            relation: row.relation,
            weight: Number(row.weight ?? 1),
            createdAt: Number(row.created_at ?? 0),
        }));
    }
    countRelations(scopeId) {
        // memory_relations 没有 scope 列，按 from 端记忆所属 scope 统计。
        const scope = scopeWhere(scopeId, 'memories');
        const row = this.db.get(`SELECT COUNT(*) AS total FROM memory_relations
         JOIN memories ON memories.id = memory_relations.from_memory_id
        WHERE ${scope.clause}`, ...scope.params);
        return Number(row?.total ?? 0);
    }
}
export function mapEvidenceRow(row) {
    return {
        memoryId: row.memory_id,
        evidenceType: asEvidenceType(row.evidence_type),
        evidenceId: row.evidence_id,
        relation: asEvidenceRelation(row.relation),
        weight: clampWeight(Number(row.weight ?? 1)),
        createdAt: Number(row.created_at ?? 0),
    };
}
function unique(values) {
    return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}
function clampWeight(value) {
    if (!Number.isFinite(value))
        return 1;
    return Math.min(1, Math.max(0.1, value));
}
function clampLimit(value) {
    if (!Number.isFinite(value))
        return 200;
    return Math.min(10_000, Math.max(1, Math.round(value)));
}
