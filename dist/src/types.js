/**
 * 3D Memory Sea V0.2 —— 核心数据契约
 *
 * 三层语义（本阶段只实现前三层）：
 *   Experience（原始证据，不可被 LLM 改写）
 *     → Episode（一段连续经历，V0.2 的核心对象）
 *       → Recall（可解释召回）
 *
 * Stage 2 增加：Scope（项目隔离）、Episode 生命周期字段、持久化后台任务（Job）、
 * 可插拔 Embedding / Summarizer / SemanticRecall。
 *
 * 本文件只放类型与常量，不放运行时逻辑。
 */
/** 默认的 sourceType → legacy 前端可接受的 point.kind 映射依据。 */
export const EXPERIENCE_SOURCE_TYPES = [
    'chat',
    'tool',
    'manual',
    'diary',
    'file',
    'web',
];
export const EPISODE_STATUSES = ['open', 'closed', 'consolidated', 'archived'];
export const EPISODE_CLOSED_REASONS = [
    'idle_timeout',
    'session_end',
    'manual',
    'startup_recovery',
    'topic_shift',
];
export const MEMORY_JOB_TYPES = [
    'episode_summary',
    'experience_embedding',
    'episode_embedding',
    'memory_embedding',
    'episode_consolidation',
    'memory_pattern_analysis',
    'pattern_embedding',
    'memory_review',
    'episode_continuity',
    'skill_candidate_discovery',
    'skill_candidate_reevaluate',
    'skill_attempt_evaluate',
];
export const JOB_STATUSES = ['pending', 'running', 'completed', 'failed'];
export const PROCESSING_STATUSES = ['pending', 'ready', 'failed', 'disabled'];
export const MEMORY_KINDS = [
    'fact',
    'decision',
    'preference',
    'goal',
    'belief',
    'constraint',
    'principle',
    'relationship',
    'other',
];
export const MEMORY_STATUSES = ['active', 'superseded', 'expired', 'stale'];
export const EVIDENCE_TYPES = ['episode', 'experience', 'memory'];
export const EVIDENCE_RELATIONS = [
    'supports',
    'contradicts',
    'derived_from',
    'supersedes',
];
export const SKILL_CANDIDATE_KINDS = [
    'guideline',
    'procedure',
    'decision_rule',
    'checklist',
    'other',
];
export const SKILL_CANDIDATE_STATUSES = [
    'drafting',
    'ready_for_review',
    'in_review',
    'changes_requested',
    'approved',
    'rejected',
    'superseded',
    'stale_candidate',
];
export const SKILL_ATTEMPT_RESULTS = [
    'success',
    'partial_success',
    'failure',
    'unknown',
    'inconclusive',
];
export const SKILL_ATTRIBUTIONS = ['direct', 'user_reported', 'inferred', 'none'];
export const PATTERN_KINDS = [
    'preference',
    'strategy',
    'habit',
    'principle',
    'recurring_decision',
    'recurring_problem',
    'recurring_solution',
    'trend',
    'other',
];
export const PATTERN_STATUSES = [
    'candidate',
    'active',
    'weakened',
    'superseded',
    'stale',
    'archived',
];
export const PATTERN_EVIDENCE_RELATIONS = ['supports', 'contradicts'];
export const MEMORY_REVIEW_STATUSES = [
    'fresh',
    'review_due',
    'reviewed',
    'stale',
];
