/**
 * pattern-repository.ts —— patterns 表的唯一访问入口（spec §56）。
 *
 * 与 MemoryRepository 的对应关系：
 *   - MemoryRepository 管理「我知道什么」；PatternRepository 管理「多个知识共同反映了什么」。
 *   - Pattern 同样是**派生知识**，内容可以在 supersede 时被新 Pattern 取代，但历史不删除。
 *   - Pattern 必须由 >= minSupport 个 Semantic Memory 支持，证据由 pattern-evidence-repository 维护。
 *
 * **Pattern is descriptive. Skill is executable.** 这里没有任何执行 / 策略应用能力。
 */
import { asPatternKind, asPatternStatus, asProcessingStatus, scopeWhere, } from '../storage/schema.js';
import { likeTerms, toFtsQuery, toFtsText } from '../recall/tokenizer.js';
import { createPatternId, normalizePatternContent } from './pattern-normalizer.js';
import { reinforcedConfidence, weakenedConfidence } from './pattern-lifecycle.js';
const COLUMNS = [
    'id',
    'scope_id',
    'kind',
    'subject',
    'domain',
    'content',
    'normalized_content',
    'confidence',
    'importance',
    'support_count',
    'contradiction_count',
    'status',
    'first_observed_at',
    'last_observed_at',
    'created_at',
    'updated_at',
    'last_reinforced_at',
    'last_reviewed_at',
    'last_accessed_at',
    'access_count',
    'superseded_by',
    'embedding_status',
].join(', ');
export class PatternRepository {
    db;
    now;
    constructor(deps) {
        this.db = deps.db;
        this.now = deps.now ?? (() => Date.now());
    }
    create(input) {
        const at = this.now();
        const content = input.content.trim();
        const id = input.id ?? createPatternId();
        const normalized = input.normalizedContent ?? normalizePatternContent(content);
        const pattern = {
            id,
            scopeId: input.scopeId,
            kind: input.kind,
            ...(input.subject ? { subject: input.subject } : {}),
            ...(input.domain ? { domain: input.domain } : {}),
            content,
            normalizedContent: normalized,
            confidence: clamp01(input.confidence ?? 0.6),
            importance: clamp01(input.importance ?? 0.5),
            supportCount: Math.max(0, Math.round(input.supportCount ?? 0)),
            contradictionCount: Math.max(0, Math.round(input.contradictionCount ?? 0)),
            status: input.status ?? 'candidate',
            firstObservedAt: input.firstObservedAt ?? at,
            lastObservedAt: input.lastObservedAt ?? at,
            createdAt: at,
            updatedAt: at,
            accessCount: 0,
            embeddingStatus: input.embeddingStatus ?? 'pending',
        };
        this.db.run(`INSERT INTO patterns (${COLUMNS}) VALUES (${placeholders(22)})`, pattern.id, pattern.scopeId, pattern.kind, pattern.subject ?? null, pattern.domain ?? null, pattern.content, pattern.normalizedContent ?? null, pattern.confidence, pattern.importance, pattern.supportCount, pattern.contradictionCount, pattern.status, pattern.firstObservedAt, pattern.lastObservedAt, pattern.createdAt, pattern.updatedAt, pattern.lastReinforcedAt ?? null, pattern.lastReviewedAt ?? null, pattern.lastAccessedAt ?? null, pattern.accessCount, pattern.supersededBy ?? null, pattern.embeddingStatus);
        this.refreshSearchIndex(pattern.id);
        return pattern;
    }
    getById(id) {
        const row = this.db.get(`SELECT ${COLUMNS} FROM patterns WHERE id = ?`, id);
        return row ? mapPatternRow(row) : null;
    }
    listByIds(ids) {
        if (ids.length === 0)
            return [];
        const rows = [];
        for (let start = 0; start < ids.length; start += 400) {
            const chunk = ids.slice(start, start + 400);
            const list = chunk.map(() => '?').join(', ');
            rows.push(...this.db.all(`SELECT ${COLUMNS} FROM patterns WHERE id IN (${list})`, ...chunk));
        }
        const byId = new Map(rows.map((row) => [row.id, mapPatternRow(row)]));
        const out = [];
        for (const id of ids) {
            const pattern = byId.get(id);
            if (pattern)
                out.push(pattern);
        }
        return out;
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
        else if (!query.includeSuperseded) {
            clauses.push("status IN ('candidate', 'active', 'weakened')");
        }
        const kinds = toArray(query.kind);
        if (kinds.length > 0) {
            clauses.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
            params.push(...kinds);
        }
        params.push(clampLimit(query.limit ?? 50));
        const rows = this.db.all(`SELECT ${COLUMNS} FROM patterns WHERE ${clauses.join(' AND ')}
        ORDER BY status = 'active' DESC, support_count DESC, importance DESC, updated_at DESC LIMIT ?`, ...params);
        return rows.map(mapPatternRow);
    }
    findActive(scopeId, limit = 50) {
        const scope = scopeWhere(scopeId);
        const rows = this.db.all(`SELECT ${COLUMNS} FROM patterns WHERE ${scope.clause} AND status = 'active'
        ORDER BY support_count DESC, confidence DESC, updated_at DESC LIMIT ?`, ...scope.params, clampLimit(limit));
        return rows.map(mapPatternRow);
    }
    /** Dedup / 重复分析用：未被历史淘汰的模式（candidate 也要看，否则会重复造候选）。 */
    findCandidates(scopeId, limit = 50) {
        const scope = scopeWhere(scopeId);
        const rows = this.db.all(`SELECT ${COLUMNS} FROM patterns
        WHERE ${scope.clause} AND status IN ('candidate', 'active', 'weakened')
        ORDER BY support_count DESC, updated_at DESC LIMIT ?`, ...scope.params, clampLimit(limit));
        return rows.map(mapPatternRow);
    }
    findByNormalized(scopeId, normalizedContent, limit = 5) {
        if (normalizedContent.length === 0)
            return [];
        const scope = scopeWhere(scopeId);
        const rows = this.db.all(`SELECT ${COLUMNS} FROM patterns WHERE ${scope.clause} AND normalized_content = ?
        ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END, updated_at DESC LIMIT ?`, ...scope.params, normalizedContent, clampLimit(limit));
        return rows.map(mapPatternRow);
    }
    /** Pattern FTS 优先，失败降级 LIKE（与 Memory 同一套中文 bigram 方案，spec §10）。 */
    searchLexical(scopeId, query, limit = 20, options = {}) {
        const trimmed = query.trim();
        if (trimmed.length === 0)
            return [];
        const statusClause = options.includeSuperseded
            ? ''
            : " AND patterns.status IN ('candidate', 'active', 'weakened')";
        if (this.db.patternFtsAvailable) {
            const match = toFtsQuery(trimmed);
            if (match) {
                try {
                    const scope = scopeWhere(scopeId, 'patterns');
                    const rows = this.db.all(`SELECT patterns_fts.pattern_id AS id, bm25(patterns_fts) AS rank
               FROM patterns_fts
               JOIN patterns ON patterns.id = patterns_fts.pattern_id
              WHERE patterns_fts MATCH ? AND ${scope.clause}${statusClause}
              ORDER BY rank ASC LIMIT ?`, match, ...scope.params, clampLimit(limit));
                    const hits = rows
                        .map((row) => ({ id: row.id, strength: Math.max(0, -Number(row.rank ?? 0)) }))
                        .filter((row) => row.strength > 0);
                    const top = hits.reduce((max, row) => Math.max(max, row.strength), 0);
                    if (hits.length > 0 && top > 0) {
                        const out = [];
                        for (const hit of hits) {
                            const pattern = this.getById(hit.id);
                            if (!pattern)
                                continue;
                            out.push({ pattern, score: round4(0.35 + 0.65 * (hit.strength / top)), strength: round4(hit.strength) });
                        }
                        return out;
                    }
                }
                catch {
                    // FTS 只是精度增强，出错继续 LIKE。
                }
            }
        }
        return this.searchLike(scopeId, trimmed, limit, options);
    }
    searchLike(scopeId, query, limit, options) {
        const terms = likeTerms(query, 8);
        if (terms.length === 0)
            return [];
        const scope = scopeWhere(scopeId);
        const clauses = terms
            .map(() => "(instr(lower(content), lower(?)) > 0 OR instr(lower(COALESCE(subject, '')), lower(?)) > 0)")
            .join(' OR ');
        const params = [];
        for (const term of terms)
            params.push(term, term);
        const statusClause = options.includeSuperseded ? '' : " AND status IN ('candidate', 'active', 'weakened')";
        const rows = this.db.all(`SELECT ${COLUMNS} FROM patterns WHERE ${scope.clause} AND (${clauses})${statusClause}
        ORDER BY support_count DESC, importance DESC LIMIT ?`, ...scope.params, ...params, clampLimit(limit));
        return rows.map((row) => ({
            pattern: mapPatternRow(row),
            score: round4(Math.min(1, 0.45 + 0.15 * terms.length)),
            strength: round4(Math.min(1, 0.2 * terms.length)),
        }));
    }
    /**
     * 被新证据强化（spec §19）：support_count 只按**真实新增的 evidence 条数**增长，
     * 同一 Memory 重复分析不会重复计数（evidence 唯一键保证）。
     */
    reinforce(patternId, options) {
        const current = this.getById(patternId);
        if (!current)
            return null;
        const at = options.at ?? this.now();
        const added = Math.max(0, Math.round(options.evidenceAdded));
        const confidence = reinforcedConfidence(current.confidence, options.confidenceDelta ?? 0.12);
        const observedAt = Math.max(current.lastObservedAt, options.observedAt ?? at);
        this.db.run(`UPDATE patterns
          SET support_count = support_count + ?,
              confidence = ?,
              last_observed_at = ?,
              last_reinforced_at = ?,
              updated_at = ?
        WHERE id = ?`, added, confidence, observedAt, at, at, patternId);
        return this.getById(patternId);
    }
    /** 被反证弱化（spec §20）：contradiction_count 增长、confidence 下降，状态先不动。 */
    weaken(patternId, options) {
        const current = this.getById(patternId);
        if (!current)
            return null;
        const at = options.at ?? this.now();
        const added = Math.max(0, Math.round(options.evidenceAdded));
        const confidence = weakenedConfidence(current.confidence, options.confidenceDelta ?? 0.1);
        this.db.run(`UPDATE patterns
          SET contradiction_count = contradiction_count + ?,
              confidence = ?,
              updated_at = ?
        WHERE id = ?`, added, confidence, at, patternId);
        return this.getById(patternId);
    }
    setStatus(patternId, status, at = this.now()) {
        this.db.run('UPDATE patterns SET status = ?, updated_at = ? WHERE id = ?', status, at, patternId);
        return this.getById(patternId);
    }
    markActive(patternId, at = this.now()) {
        return this.setStatus(patternId, 'active', at);
    }
    markWeakened(patternId, at = this.now()) {
        return this.setStatus(patternId, 'weakened', at);
    }
    markStale(patternId, at = this.now()) {
        return this.setStatus(patternId, 'stale', at);
    }
    /** 旧模式不删除：标 superseded 并指向替代者，first/lastObserved 保留历史。 */
    markSuperseded(oldPatternId, newPatternId, at = this.now()) {
        this.db.run(`UPDATE patterns
          SET status = 'superseded',
              superseded_by = ?,
              updated_at = ?
        WHERE id = ? AND status IN ('candidate', 'active', 'weakened')`, newPatternId, at, oldPatternId);
        return this.getById(oldPatternId);
    }
    markReviewed(patternId, at = this.now()) {
        this.db.run('UPDATE patterns SET last_reviewed_at = ?, updated_at = ? WHERE id = ?', at, at, patternId);
    }
    incrementAccess(patternIds, at = this.now()) {
        if (patternIds.length === 0)
            return;
        this.db.transaction(() => {
            for (const id of patternIds) {
                this.db.run('UPDATE patterns SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?', at, id);
            }
        });
    }
    setEmbeddingStatus(patternId, status) {
        this.db.run('UPDATE patterns SET embedding_status = ? WHERE id = ?', status, patternId);
    }
    listPendingEmbedding(scopeId, limit = 50) {
        const scope = scopeWhere(scopeId);
        const rows = this.db.all(`SELECT ${COLUMNS} FROM patterns WHERE ${scope.clause} AND embedding_status = 'pending'
        ORDER BY updated_at ASC LIMIT ?`, ...scope.params, clampLimit(limit));
        return rows.map(mapPatternRow);
    }
    refreshSearchIndex(patternId) {
        if (!this.db.patternFtsAvailable)
            return;
        try {
            const row = this.db.get('SELECT content, subject FROM patterns WHERE id = ?', patternId);
            if (!row)
                return;
            this.db.run('DELETE FROM patterns_fts WHERE pattern_id = ?', patternId);
            this.db.run('INSERT INTO patterns_fts (pattern_id, content, subject) VALUES (?, ?, ?)', patternId, toFtsText(row.content), toFtsText(row.subject ?? ''));
        }
        catch {
            // Pattern FTS 只是召回增强，失败不影响模式本身。
        }
    }
    /** 状态统计（spec §79 的 status.patterns）。 */
    stats(scopeId) {
        const scope = scopeWhere(scopeId);
        const rows = this.db.all(`SELECT status, COUNT(*) AS total FROM patterns WHERE ${scope.clause} GROUP BY status`, ...scope.params);
        const out = { candidate: 0, active: 0, weakened: 0, stale: 0, superseded: 0, total: 0 };
        for (const row of rows) {
            const count = Number(row.total ?? 0);
            out.total += count;
            if (row.status === 'candidate')
                out.candidate += count;
            else if (row.status === 'active')
                out.active += count;
            else if (row.status === 'weakened')
                out.weakened += count;
            else if (row.status === 'stale')
                out.stale += count;
            else if (row.status === 'superseded')
                out.superseded += count;
        }
        return out;
    }
    count(scopeId) {
        const scope = scopeWhere(scopeId);
        const row = this.db.get(`SELECT COUNT(*) AS total FROM patterns WHERE ${scope.clause}`, ...scope.params);
        return Number(row?.total ?? 0);
    }
    countActive(scopeId) {
        const scope = scopeWhere(scopeId);
        const row = this.db.get(`SELECT COUNT(*) AS total FROM patterns WHERE ${scope.clause} AND status = 'active'`, ...scope.params);
        return Number(row?.total ?? 0);
    }
    /** 库里出现过的 scope（启动维护要遍历它，spec §82 的历史数据可见性问题）。 */
    listScopeIds() {
        return this.db
            .all('SELECT DISTINCT scope_id FROM patterns WHERE scope_id IS NOT NULL')
            .map((row) => row.scope_id);
    }
    /** Review 扫描：长期没有新的支持证据的模式（active / weakened）。 */
    listDueForReview(scopeId, options) {
        const scope = scopeWhere(scopeId);
        const now = options.now ?? this.now();
        const threshold = now - Math.max(0, options.staleAfterMs);
        const rows = this.db.all(`SELECT ${COLUMNS} FROM patterns
        WHERE ${scope.clause}
          AND status IN ('active', 'weakened')
          AND COALESCE(last_reinforced_at, last_observed_at, created_at) < ?
        ORDER BY COALESCE(last_reinforced_at, last_observed_at, created_at) ASC LIMIT ?`, ...scope.params, threshold, clampLimit(options.limit ?? 20));
        return rows.map(mapPatternRow);
    }
}
export function mapPatternRow(row) {
    return {
        id: row.id,
        scopeId: row.scope_id,
        kind: asPatternKind(row.kind),
        ...(row.subject ? { subject: row.subject } : {}),
        ...(row.domain ? { domain: row.domain } : {}),
        content: row.content,
        ...(row.normalized_content ? { normalizedContent: row.normalized_content } : {}),
        confidence: clamp01(Number(row.confidence ?? 0.5)),
        importance: clamp01(Number(row.importance ?? 0.5)),
        supportCount: Math.max(0, Number(row.support_count ?? 0)),
        contradictionCount: Math.max(0, Number(row.contradiction_count ?? 0)),
        status: asPatternStatus(row.status),
        firstObservedAt: Number(row.first_observed_at ?? 0),
        lastObservedAt: Number(row.last_observed_at ?? 0),
        createdAt: Number(row.created_at ?? 0),
        updatedAt: Number(row.updated_at ?? 0),
        ...(row.last_reinforced_at === null || row.last_reinforced_at === undefined
            ? {}
            : { lastReinforcedAt: Number(row.last_reinforced_at) }),
        ...(row.last_reviewed_at === null || row.last_reviewed_at === undefined
            ? {}
            : { lastReviewedAt: Number(row.last_reviewed_at) }),
        ...(row.last_accessed_at === null || row.last_accessed_at === undefined
            ? {}
            : { lastAccessedAt: Number(row.last_accessed_at) }),
        accessCount: Math.max(0, Number(row.access_count ?? 0)),
        ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
        embeddingStatus: asProcessingStatus(row.embedding_status, 'pending'),
    };
}
function placeholders(count) {
    return new Array(count).fill('?').join(', ');
}
function toArray(value) {
    if (value === undefined)
        return [];
    return Array.isArray(value) ? [...value] : [value];
}
function clamp01(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.min(1, Math.max(0, value));
}
function round4(value) {
    return Math.round(value * 10_000) / 10_000;
}
function clampLimit(value) {
    if (!Number.isFinite(value))
        return 50;
    return Math.min(10_000, Math.max(1, Math.round(value)));
}
