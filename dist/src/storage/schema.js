/**
 * schema.ts —— 表结构在 TS 侧的唯一描述：行类型、表名、序列化辅助。
 *
 * 约束：这里不写业务逻辑，只做「数据库行 ↔ 内存值」的机械转换。
 * DDL 在 migrations/*.sql，二者必须同步维护。
 *
 * Stage 2 的作用域模型（spec §6）：
 *   过滤条件只按 `scope_id` 单键，不再用 scope_type + scope_id 双条件。
 *   - project_<hash>  项目作用域（由规范化根路径派生，Windows 大小写不敏感）
 *   - project_legacy  无法推导根路径的旧数据兜底
 *   - global          预留的全局作用域
 * scope_type / scope_root 仍然写入，但只作审计与迁移用，不参与查询。
 */
export const TABLES = {
    migrations: 'memory_sea_migrations',
    experiences: 'experiences',
    episodes: 'episodes',
    episodeExperiences: 'episode_experiences',
    experienceFts: 'experience_fts',
    episodeFts: 'episode_fts',
    embeddings: 'embeddings',
    memoryJobs: 'memory_jobs',
    // Stage 3
    memories: 'memories',
    memoryEvidence: 'memory_evidence',
    memoryRelations: 'memory_relations',
    memoryFts: 'memories_fts',
    // Stage 4
    patterns: 'patterns',
    patternEvidence: 'pattern_evidence',
    patternFts: 'patterns_fts',
};
/**
 * 可选迁移：失败时只降级、不阻断启动（见 database.ts）。
 *   002_fts.sql                   —— SQLite 未编译 FTS5 时降级到 LIKE
 *   006_embedding_versioning.sql  —— 依赖 002 建出的旧 embeddings 表；002 失败时它也不该阻断启动
 *   008_memory_fts.sql            —— Memory FTS 同样是增强项，失败降级 LIKE（spec §8）
 *   012_pattern_fts.sql           —— Pattern FTS 同上
 */
export const OPTIONAL_MIGRATIONS = new Set([
    '002_fts.sql',
    '006_embedding_versioning.sql',
    '008_memory_fts.sql',
    '012_pattern_fts.sql',
]);
const SOURCE_TYPES = new Set(['chat', 'tool', 'manual', 'diary', 'file', 'web']);
const ROLES = new Set(['user', 'assistant', 'system', 'tool']);
const EPISODE_STATUS = new Set(['open', 'closed', 'consolidated', 'archived']);
const PROCESSING_STATUS = new Set(['pending', 'ready', 'failed', 'disabled']);
const JOB_TYPES = new Set([
    'episode_summary',
    'experience_embedding',
    'episode_embedding',
    'memory_embedding',
    'episode_consolidation',
    'memory_pattern_analysis',
    'pattern_embedding',
    'memory_review',
]);
const JOB_STATUSES = new Set(['pending', 'running', 'completed', 'failed']);
const JOB_OWNER_TYPES = new Set(['episode', 'experience', 'memory', 'pattern']);
const MEMORY_KIND_SET = new Set([
    'fact',
    'decision',
    'preference',
    'goal',
    'belief',
    'constraint',
    'principle',
    'relationship',
    'other',
]);
const MEMORY_STATUS_SET = new Set(['active', 'superseded', 'expired', 'stale']);
const EVIDENCE_TYPE_SET = new Set(['episode', 'experience', 'memory']);
const EVIDENCE_RELATION_SET = new Set([
    'supports',
    'contradicts',
    'derived_from',
    'supersedes',
]);
export function asSourceType(value) {
    return typeof value === 'string' && SOURCE_TYPES.has(value)
        ? value
        : 'manual';
}
export function asRole(value) {
    return typeof value === 'string' && ROLES.has(value)
        ? value
        : undefined;
}
export function asEpisodeStatus(value) {
    return typeof value === 'string' && EPISODE_STATUS.has(value)
        ? value
        : 'open';
}
/** Stage 2：embedding_status 与 summary_status 共用处理状态机。 */
export function asEmbeddingStatus(value) {
    return asProcessingStatus(value, 'disabled');
}
export function asProcessingStatus(value, fallback = 'pending') {
    return typeof value === 'string' && PROCESSING_STATUS.has(value)
        ? value
        : fallback;
}
export function asJobType(value) {
    return typeof value === 'string' && JOB_TYPES.has(value)
        ? value
        : 'episode_summary';
}
const PATTERN_KIND_SET = new Set([
    'preference',
    'strategy',
    'habit',
    'principle',
    'recurring_decision',
    'recurring_problem',
    'recurring_solution',
    'trend',
    'other',
]);
const PATTERN_STATUS_SET = new Set([
    'candidate',
    'active',
    'weakened',
    'superseded',
    'stale',
    'archived',
]);
const PATTERN_EVIDENCE_RELATION_SET = new Set(['supports', 'contradicts']);
const MEMORY_REVIEW_STATUS_SET = new Set(['fresh', 'review_due', 'reviewed', 'stale']);
export function asJobStatus(value) {
    return typeof value === 'string' && JOB_STATUSES.has(value)
        ? value
        : 'pending';
}
export function asJobOwnerType(value) {
    if (value === 'experience')
        return 'experience';
    if (value === 'memory')
        return 'memory';
    if (value === 'pattern')
        return 'pattern';
    return 'episode';
}
/** Stage 3：长期知识类型（未知值一律 other，不让坏数据变成异常）。 */
export function asMemoryKind(value) {
    return typeof value === 'string' && MEMORY_KIND_SET.has(value) ? value : 'other';
}
/** Stage 3：长期知识生命周期状态。 */
export function asMemoryStatus(value) {
    return typeof value === 'string' && MEMORY_STATUS_SET.has(value)
        ? value
        : 'stale';
}
export function asEvidenceType(value) {
    return typeof value === 'string' && EVIDENCE_TYPE_SET.has(value)
        ? value
        : 'episode';
}
export function asEvidenceRelation(value) {
    return typeof value === 'string' && EVIDENCE_RELATION_SET.has(value)
        ? value
        : 'supports';
}
/** Stage 4：Pattern 类型（未知值一律 other）。 */
export function asPatternKind(value) {
    return typeof value === 'string' && PATTERN_KIND_SET.has(value)
        ? value
        : 'other';
}
/** Stage 4：Pattern 生命周期状态（未知值一律 stale，不冒充 active）。 */
export function asPatternStatus(value) {
    return typeof value === 'string' && PATTERN_STATUS_SET.has(value)
        ? value
        : 'stale';
}
export function asPatternEvidenceRelation(value) {
    return typeof value === 'string' && PATTERN_EVIDENCE_RELATION_SET.has(value)
        ? value
        : 'supports';
}
/** Stage 4：Memory 的 Review 状态。 */
export function asMemoryReviewStatus(value) {
    return typeof value === 'string' && MEMORY_REVIEW_STATUS_SET.has(value)
        ? value
        : 'fresh';
}
/** metadata_json 解析失败时不让整条记录失败：返回空对象并保留原始串。 */
export function parseMetadata(raw) {
    if (typeof raw !== 'string' || raw.trim().length === 0)
        return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
        return { value: parsed };
    }
    catch {
        return { _raw: raw };
    }
}
export function serializeMetadata(metadata) {
    if (!metadata)
        return '{}';
    try {
        return JSON.stringify(metadata);
    }
    catch {
        return '{}';
    }
}
export function parseStringArray(raw) {
    if (typeof raw !== 'string' || raw.trim().length === 0)
        return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        const out = [];
        for (const item of parsed) {
            if (typeof item === 'string' && item.length > 0)
                out.push(item);
        }
        return out;
    }
    catch {
        return [];
    }
}
export function serializeStringArray(values) {
    const list = (values ?? []).filter((v) => typeof v === 'string' && v.length > 0);
    return JSON.stringify(list);
}
// ------------------------------------------------------------------ 作用域
/**
 * 审计用：作用域怎么摊平成列。
 * scope_id 永远非空（global → 'global'），这样查询只需要一个等值条件。
 */
export function scopeColumns(scope) {
    if (scope.type === 'global') {
        return { scopeType: 'global', scopeId: 'global', scopeRoot: null };
    }
    return { scopeType: 'project', scopeId: scope.id, scopeRoot: scope.rootPath ?? null };
}
/**
 * 作用域过滤条件（spec §6：V0.2 只召回当前 project，绝不跨项目）。
 *
 * 只按 scope_id 单一等值匹配：迁移期已有的 project_legacy 行也不会被误放进别的项目。
 */
export function scopeWhere(scopeId, columnPrefix = '') {
    const prefix = columnPrefix.length > 0 ? `${columnPrefix}.` : '';
    return { clause: `${prefix}scope_id = ?`, params: [scopeId] };
}
