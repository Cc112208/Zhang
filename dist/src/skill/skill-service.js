/**
 * skill-service.ts —— Stage 5 的领域编排层（候选生成 / 版本 / 尝试 / 成熟度 / 审核状态机）。
 *
 * 边界：
 *   - 只做编排与校验，所有 SQL 都在 skill/*-repository.ts；
 *   - 每个方法都显式接收 scopeId，并且**重新从实体上核对 scope**（不只信调用方参数）；
 *   - 不提供任何「执行候选」的能力：批准只写审核记录，没有工具注册 / 工作流 / Prompt 修改。
 *
 * 核心原则（Phase 0 / Phase 1）：
 *   Pattern is not Procedure / Repeated is not successful / Evidence is not attribution
 *   / Unknown is not failure / Approved is not validated / Candidate is not executable Skill
 */
import { assessMaturity, evaluateAttempts, foldEvidence, } from './evidence-independence.js';
import { SkillError, SkillScopeError } from './errors.js';
const MAX_EVIDENCE_PER_STEP = 2;
/** Phase 2A 的保守默认值：调用方只覆盖关心的字段，其余走默认，避免 undefined 让门槛失效。 */
const DEFAULT_SERVICE_SETTINGS = {
    enabled: true,
    minSupportMemories: 3,
    minIndependentEpisodes: 2,
    minStability: 0.5,
    maxStepsPerDraft: 6,
    minIndependentAttempts: 5,
    minDirectAttempts: 1,
    minSuccessRateForValidated: 0.5,
    minReportableSamples: 5,
    wilsonZ: 1.96,
    minValidatedAttempts: 5,
    minStepCoverage: 0.6,
    minConfidence: 0.6,
    allowWeakenedPatterns: true,
};
function normalizeServiceSettings(input) {
    const merged = { ...DEFAULT_SERVICE_SETTINGS, ...input };
    // 旧字段 minValidatedAttempts 与 minIndependentAttempts 等价；取两者较大值，绝不静默放宽门槛。
    const independent = Math.max(merged.minIndependentAttempts ?? 0, merged.minValidatedAttempts ?? 0, DEFAULT_SERVICE_SETTINGS.minIndependentAttempts);
    return { ...merged, minIndependentAttempts: independent, minValidatedAttempts: independent };
}
export class SkillService {
    candidates;
    attempts;
    patterns;
    patternEvidence;
    memories;
    evidence;
    episodes;
    experiences;
    settings;
    now;
    logger;
    constructor(deps) {
        this.candidates = deps.candidates;
        this.attempts = deps.attempts;
        this.patterns = deps.patterns;
        this.patternEvidence = deps.patternEvidence;
        this.memories = deps.memories;
        this.evidence = deps.evidence;
        this.episodes = deps.episodes;
        this.experiences = deps.experiences;
        this.settings = normalizeServiceSettings(deps.settings);
        this.now = deps.now ?? (() => Date.now());
        this.logger = deps.logger ?? {};
    }
    get enabled() {
        return this.settings.enabled;
    }
    // ------------------------------------------------------------------ 查询
    listCandidates(scopeId, query = {}) {
        return this.candidates.list(scopeId, query);
    }
    getCandidate(scopeId, candidateId) {
        return this.candidates.getById(scopeId, candidateId);
    }
    /** 该 Pattern 是否已经有候选（幂等检查，供回填与后台任务使用）。 */
    hasCandidateForPattern(scopeId, patternId) {
        return this.candidates.findByPattern(scopeId, patternId) !== null;
    }
    listVersions(scopeId, candidateId) {
        this.requireCandidate(scopeId, candidateId);
        return this.candidates.listVersions(scopeId, candidateId);
    }
    getVersion(scopeId, versionId) {
        return this.candidates.getVersion(scopeId, versionId);
    }
    listAttempts(scopeId, options = {}) {
        return this.attempts.list(scopeId, options);
    }
    listOutcomes(scopeId, attemptId) {
        const attempt = this.requireAttempt(scopeId, attemptId);
        return this.attempts.listOutcome(attempt.id);
    }
    listReviews(scopeId, candidateId) {
        this.requireCandidate(scopeId, candidateId);
        return this.attempts.listReviews(scopeId, candidateId);
    }
    stats(scopeId) {
        return { candidates: this.candidates.countStats(scopeId), attempts: this.attempts.countStats(scopeId) };
    }
    // ------------------------------------------------------------------ 候选生成
    /**
     * 从 Pattern 派生候选（幂等：同一 Pattern 已有候选就只做评估，不重复创建）。
     * 不修改 Pattern / Memory / Experience 的任何字段。
     */
    ensureCandidateForPattern(scopeId, patternId) {
        const pattern = this.requirePattern(scopeId, patternId);
        const blocked = this.patternGate(pattern);
        if (blocked)
            throw new SkillError(`Pattern ${patternId} 不满足候选生成门槛：${blocked}`);
        const supporterIds = this.patternEvidence.listMemoryIds(patternId, 'supports', 32);
        const memories = this.memories.listByIds(supporterIds).filter((memory) => memory.scopeId === scopeId);
        if (memories.length < this.settings.minSupportMemories) {
            throw new SkillError(`支持证据不足：需要至少 ${this.settings.minSupportMemories} 条 Memory，实际 ${memories.length} 条`);
        }
        const draft = this.deriveDraft(pattern, memories);
        const existing = this.candidates.findByPattern(scopeId, patternId);
        if (existing) {
            const candidate = existing;
            // 已有候选：只更新「来源是否变化」与成熟度，不新增版本、不改旧版本。
            const provenanceChanged = candidate.sourceMemoryIds.length !== supporterIds.length ||
                candidate.sourceMemoryIds.some((id) => !supporterIds.includes(id));
            if (provenanceChanged)
                this.candidates.markProvenanceChanged(candidate.id, true, this.now());
            const refreshed = this.candidates.getById(scopeId, candidate.id) ?? candidate;
            return {
                candidate: refreshed,
                created: false,
                maturity: this.evaluateMaturity(scopeId, refreshed),
            };
        }
        const at = this.now();
        const candidate = this.candidates.create({
            scopeId,
            sourcePatternId: patternId,
            sourceMemoryIds: memories.map((memory) => memory.id),
            title: this.titleFor(pattern),
            description: this.descriptionFor(pattern),
            kind: this.kindFor(pattern),
            status: 'drafting',
            createdAt: at,
        });
        const versionNo = this.candidates.nextVersionNo(candidate.id);
        const version = this.candidates.createVersion({
            candidateId: candidate.id,
            scopeId,
            versionNo,
            title: candidate.title,
            procedure: draft.procedure,
            evidenceSnapshot: draft.snapshot,
            changeReason: '初始版本：由 Pattern 的支持知识推导',
            createdBy: 'system:skill-discovery',
            createdAt: at,
        });
        this.candidates.attachVersion(candidate.id, version.id, versionNo, at);
        const withVersion = this.candidates.getById(scopeId, candidate.id) ?? candidate;
        const maturity = this.evaluateMaturity(scopeId, withVersion);
        this.syncReviewReadiness(scopeId, withVersion, maturity);
        return { candidate: withVersion, created: true, version, draft, maturity };
    }
    /** 批量发现：只处理本 scope 内满足门槛的 active / weakened Pattern。 */
    discover(scopeId, options = {}) {
        const limit = Math.min(200, Math.max(1, Math.round(options.limit ?? 20)));
        const patterns = [
            ...this.patterns.list(scopeId, { status: 'active', limit }),
            ...(this.settings.allowWeakenedPatterns ? this.patterns.list(scopeId, { status: 'weakened', limit }) : []),
        ];
        const result = { scanned: 0, created: 0, skipped: 0, errors: 0 };
        for (const pattern of patterns.slice(0, limit)) {
            result.scanned += 1;
            try {
                const ensured = this.ensureCandidateForPattern(scopeId, pattern.id);
                if (ensured.created)
                    result.created += 1;
                else
                    result.skipped += 1;
            }
            catch (error) {
                result.errors += 1;
                this.logger.warn?.(`[memory-sea] 候选发现跳过 ${pattern.id}: ${error.message}`);
            }
        }
        return result;
    }
    /** 只读：把 Pattern 推导成 draft（不落库），用于预览与测试。 */
    previewDraft(scopeId, patternId) {
        const pattern = this.requirePattern(scopeId, patternId);
        const supporterIds = this.patternEvidence.listMemoryIds(patternId, 'supports', 32);
        const memories = this.memories.listByIds(supporterIds).filter((memory) => memory.scopeId === scopeId);
        return this.deriveDraft(pattern, memories);
    }
    // ------------------------------------------------------------------ 版本
    createVersion(scopeId, candidateId, input) {
        const candidate = this.requireCandidate(scopeId, candidateId);
        if (candidate.status === 'in_review')
            throw new SkillError('审核中的候选不能创建新版本');
        if (!input.changeReason || input.changeReason.trim().length < 3) {
            throw new SkillError('新版本必须写明变更原因（至少 3 个字符）');
        }
        if (!input.createdBy || input.createdBy.trim().length === 0) {
            throw new SkillError('新版本必须记录创建者');
        }
        const parent = candidate.currentVersionId
            ? this.candidates.getVersion(scopeId, candidate.currentVersionId)
            : null;
        const versionNo = this.candidates.nextVersionNo(candidate.id);
        const at = this.now();
        const version = this.candidates.createVersion({
            candidateId: candidate.id,
            scopeId,
            versionNo,
            ...(parent ? { parentVersionId: parent.id } : {}),
            title: input.title ?? candidate.title,
            procedure: input.procedure,
            evidenceSnapshot: parent?.evidenceSnapshot ?? {
                memoryIds: candidate.sourceMemoryIds,
                episodeIds: [],
                experienceIds: [],
                capturedAt: at,
            },
            changeReason: input.changeReason,
            createdBy: input.createdBy,
            createdAt: at,
        });
        // 旧版本只在「已被批准」时才降级为 superseded；草稿/被拒版本保留原状态以便审计。
        if (parent && parent.status === 'approved') {
            this.candidates.setVersionStatus(parent.id, 'superseded', at);
        }
        this.candidates.attachVersion(candidate.id, version.id, versionNo, at);
        if (candidate.status === 'approved' || candidate.status === 'rejected' || candidate.status === 'ready_for_review') {
            this.candidates.setStatus(candidate.id, 'drafting', at);
        }
        return version;
    }
    /**
     * Phase 2C：人工编辑 Procedure Draft。
     *
     * 规则：
     *   - 旧版本永不覆盖，编辑一定产生新版本；
     *   - 新版本回到 draft，候选回到 drafting（不继承旧版本的批准结论）；
     *   - 没有证据支持的步骤被强制标记 inferred + source='manual'（人工补充、待验证）；
     *   - 成功标准必须带来源（manual/evidence/derived），否则拒绝保存。
     */
    editProcedure(scopeId, candidateId, input) {
        const candidate = this.requireCandidate(scopeId, candidateId);
        if (candidate.status === 'in_review') {
            throw new SkillError('审核中的候选不能直接编辑；请先请求修改或等待审核结束');
        }
        const procedure = this.validateDraft(scopeId, input.procedure);
        return this.createVersion(scopeId, candidateId, {
            ...(input.title && input.title.trim().length > 0 ? { title: input.title.trim() } : {}),
            procedure,
            changeReason: input.changeReason,
            createdBy: input.createdBy,
        });
    }
    /** Phase 2D：重新计算成熟度并同步「是否可提交审核」。不写版本、不写审核记录。 */
    reevaluate(scopeId, candidateId) {
        const candidate = this.requireCandidate(scopeId, candidateId);
        const maturity = this.evaluateMaturity(scopeId, candidate);
        this.syncReviewReadiness(scopeId, candidate, maturity);
        return maturity;
    }
    /**
     * 来源证据发生变化（Memory 被 supersede / stale / 反例出现）时打标记。
     * 这里只改派生状态 provenanceChanged，不改任何历史版本或审核记录。
     */
    markProvenanceChanged(scopeId, candidateId, reason) {
        const candidate = this.requireCandidate(scopeId, candidateId);
        if (candidate.provenanceChanged)
            return false;
        this.candidates.markProvenanceChanged(candidate.id, true, this.now());
        this.logger.info?.(`[memory-sea] 候选 ${candidate.id} 的来源证据发生变化：${reason}`);
        return true;
    }
    /** 校验并规整人工编辑的 draft；校验失败抛 SkillError（不落库）。 */
    validateDraft(scopeId, draft) {
        if (!draft || typeof draft !== 'object')
            throw new SkillError('procedure 必须是对象');
        const rawSteps = Array.isArray(draft.steps) ? draft.steps : [];
        if (rawSteps.length === 0)
            throw new SkillError('Procedure 至少需要 1 个步骤');
        if (rawSteps.length > this.settings.maxStepsPerDraft) {
            throw new SkillError(`步骤数 ${rawSteps.length} 超过上限 ${this.settings.maxStepsPerDraft}`);
        }
        const steps = rawSteps.map((raw, index) => {
            const action = typeof raw?.action === 'string' ? raw.action.trim() : '';
            if (action.length < 2)
                throw new SkillError(`第 ${index + 1} 步缺少动作描述`);
            if (action.length > 280)
                throw new SkillError(`第 ${index + 1} 步动作描述过长（>280）`);
            const refs = Array.isArray(raw?.evidenceRefs) ? raw.evidenceRefs : [];
            for (const ref of refs) {
                if (!ref || typeof ref.id !== 'string' || ref.id.length === 0) {
                    throw new SkillError(`第 ${index + 1} 步的证据引用无效`);
                }
                if (!['episode', 'experience', 'memory'].includes(ref.type)) {
                    throw new SkillError(`第 ${index + 1} 步的证据类型无效：${String(ref.type)}`);
                }
                this.assertEvidenceScope(scopeId, ref.type, ref.id);
            }
            const inferred = refs.length === 0;
            return {
                stepNo: index + 1,
                action,
                ...(typeof raw?.detail === 'string' && raw.detail.trim().length > 0 ? { detail: raw.detail.trim() } : {}),
                evidenceRefs: refs.map((ref) => ({
                    type: ref.type,
                    id: ref.id,
                    ...(typeof ref.note === 'string' && ref.note.length > 0 ? { note: ref.note } : {}),
                })),
                ...(inferred ? { inferred: true, source: 'manual' } : { source: 'evidence' }),
            };
        });
        const conditions = (values, label, kind) => {
            const list = Array.isArray(values) ? values.slice(0, 10) : [];
            return list.map((raw, index) => {
                const description = typeof raw?.description === 'string'
                    ? String(raw.description).trim()
                    : '';
                if (description.length < 2)
                    throw new SkillError(`${label} 第 ${index + 1} 项缺少描述`);
                if (description.length > 200)
                    throw new SkillError(`${label} 第 ${index + 1} 项描述过长`);
                const refs = Array.isArray(raw?.evidenceRefs)
                    ? (raw.evidenceRefs)
                    : [];
                for (const ref of refs) {
                    if (ref && typeof ref.id === 'string' && ['episode', 'experience', 'memory'].includes(ref.type)) {
                        this.assertEvidenceScope(scopeId, ref.type, ref.id);
                    }
                }
                const id = typeof raw?.id === 'string' && String(raw.id).trim().length > 0
                    ? String(raw.id).trim()
                    : `${kind}_${index + 1}`;
                if (kind === 'precondition') {
                    const required = raw?.required !== false;
                    return { id, description, required, ...(refs.length > 0 ? { evidenceRefs: refs } : {}) };
                }
                return { id, description, ...(refs.length > 0 ? { evidenceRefs: refs } : {}) };
            });
        };
        const rawCriteria = Array.isArray(draft.successCriteria) ? draft.successCriteria.slice(0, 10) : [];
        const successCriteria = rawCriteria.map((raw, index) => {
            const description = typeof raw?.description === 'string' ? raw.description.trim() : '';
            if (description.length < 4)
                throw new SkillError(`成功标准 ${index + 1} 至少需要 4 个字符的描述`);
            const source = raw?.source ?? 'manual';
            if (!['manual', 'evidence', 'derived'].includes(String(source))) {
                throw new SkillError(`成功标准 ${index + 1} 的来源无效：${String(source)}`);
            }
            return {
                id: typeof raw?.id === 'string' && raw.id.trim().length > 0 ? raw.id.trim() : `c${index + 1}`,
                description,
                ...(typeof raw?.measurable === 'boolean' ? { measurable: raw.measurable } : {}),
                source: source,
            };
        });
        return {
            steps,
            triggers: conditions(draft.triggers, 'trigger', 'trigger'),
            preconditions: conditions(draft.preconditions, 'precondition', 'precondition'),
            expectedOutcomes: conditions(draft.expectedOutcomes, 'outcome', 'outcome'),
            exceptions: (Array.isArray(draft.exceptions) ? draft.exceptions : [])
                .filter((value) => typeof value === 'string')
                .slice(0, 10)
                .map((value) => value.trim())
                .filter((value) => value.length > 0),
            limitations: (Array.isArray(draft.limitations) ? draft.limitations : [])
                .filter((value) => typeof value === 'string')
                .slice(0, 10)
                .map((value) => value.trim())
                .filter((value) => value.length > 0),
            successCriteria,
        };
    }
    // ------------------------------------------------------------------ Attempt
    recordAttempt(input) {
        const version = this.requireVersion(input.scopeId, input.versionId);
        const candidate = this.requireCandidate(input.scopeId, version.candidateId);
        if (version.status === 'superseded')
            throw new SkillError('已废弃版本不能再记录新的尝试');
        if (!input.externalKey || input.externalKey.trim().length < 3) {
            throw new SkillError('Attempt 必须提供稳定的 externalKey（至少 3 个字符）');
        }
        const attemptStatus = input.status ?? 'planned';
        const created = this.attempts.create({
            scopeId: input.scopeId,
            candidateId: candidate.id,
            versionId: version.id,
            externalKey: input.externalKey.trim(),
            status: attemptStatus,
            attribution: input.attribution ?? 'none',
            successCriteriaSnapshot: version.procedure.successCriteria,
            startedAt: input.startedAt ?? this.now(),
            ...(input.note ? { note: input.note } : {}),
        });
        return { attempt: created.attempt, created: created.created, candidate };
    }
    completeAttempt(input) {
        const attempt = this.requireAttempt(input.scopeId, input.attemptId);
        const version = this.requireVersion(input.scopeId, attempt.versionId);
        const attribution = input.attribution ?? attempt.attribution;
        // 「没有预先定义的成功标准」时，不能判定 success/failure —— 降级为 unknown 并保留原意。
        let result = input.result;
        const hasCriteria = (attempt.successCriteriaSnapshot?.length ?? 0) > 0;
        const criteriaInVersion = (version.procedure.successCriteria?.length ?? 0) > 0;
        if (!hasCriteria && !criteriaInVersion && (result === 'success' || result === 'failure')) {
            result = 'inconclusive';
            this.logger.warn?.(`[memory-sea] Attempt ${attempt.id} 缺少预先定义的成功标准，结果 ${input.result} 降级为 inconclusive`);
        }
        if (attribution === 'inferred' && result === 'success') {
            // inferred 的 success 保留结果类型，但成熟度统计不会把它当已验证成功。
            this.logger.info?.(`[memory-sea] Attempt ${attempt.id} 是推断结果，不计入已验证成功率`);
        }
        const updated = this.attempts.complete(attempt.id, {
            result,
            attribution,
            ...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
            ...(input.note ? { note: input.note } : {}),
        });
        if (!updated)
            throw new SkillError('Attempt 已是终态，不能重复完成；请新增更正记录');
        let evidenceAdded = 0;
        for (const item of input.evidence ?? []) {
            this.assertEvidenceScope(input.scopeId, item.evidenceType, item.evidenceId);
            const added = this.attempts.addOutcome(attempt.id, input.scopeId, attempt.versionId, {
                evidenceType: item.evidenceType,
                evidenceId: item.evidenceId,
                relation: item.relation,
                ...(item.attribution !== undefined ? { attribution: item.attribution } : {}),
                ...(item.weight !== undefined ? { weight: item.weight } : {}),
                ...(item.observedAt !== undefined ? { observedAt: item.observedAt } : {}),
            });
            if (added)
                evidenceAdded += 1;
        }
        const refreshed = this.requireAttempt(input.scopeId, attempt.id);
        const candidate = this.requireCandidate(input.scopeId, attempt.candidateId);
        const maturity = this.evaluateMaturity(input.scopeId, candidate);
        this.syncReviewReadiness(input.scopeId, candidate, maturity);
        return { attempt: refreshed, evidenceAdded };
    }
    // ------------------------------------------------------------------ 成熟度
    evaluateMaturity(scopeId, candidate) {
        const version = candidate.currentVersionId
            ? this.candidates.getVersion(scopeId, candidate.currentVersionId)
            : null;
        const procedure = version?.procedure ?? {
            steps: [],
            triggers: [],
            preconditions: [],
            expectedOutcomes: [],
            exceptions: [],
            limitations: [],
            successCriteria: [],
        };
        const attempts = version
            ? this.attempts.list(scopeId, { versionId: version.id })
            : this.attempts.list(scopeId, { candidateId: candidate.id });
        const outcomes = version ? this.attempts.outcomeByAttempt(scopeId, version.id) : new Map();
        const episodeIdsByAttempt = this.resolveAttemptEpisodes(scopeId, outcomes);
        const evidenceRefs = this.collectEvidenceRefs(scopeId, candidate, version);
        const folded = foldEvidence(scopeId, evidenceRefs);
        const snapshot = version?.evidenceSnapshot ?? {
            memoryIds: candidate.sourceMemoryIds,
            episodeIds: [],
            experienceIds: [],
            capturedAt: candidate.createdAt,
        };
        const pattern = candidate.sourcePatternId ? this.patterns.getById(candidate.sourcePatternId) : null;
        const policy = {
            minIndependentEpisodes: this.settings.minIndependentEpisodes,
            minValidatedAttempts: this.settings.minIndependentAttempts,
            minDirectAttempts: this.settings.minDirectAttempts,
            minStepCoverage: this.settings.minStepCoverage,
            requireSuccess: true,
            minSuccessRateForValidated: this.settings.minSuccessRateForValidated,
            minReportableSamples: this.settings.minReportableSamples,
            wilsonZ: this.settings.wilsonZ,
        };
        return assessMaturity({
            candidateId: candidate.id,
            scopeId,
            versionStatus: version?.status ?? 'draft',
            procedure,
            evidenceSnapshot: snapshot,
            attempts,
            outcomes,
            patternWeakened: pattern?.status === 'weakened' || pattern?.status === 'stale',
            episodeIdsByAttempt,
            policy,
            now: this.now(),
        });
    }
    getMaturity(scopeId, candidateId) {
        const candidate = this.requireCandidate(scopeId, candidateId);
        return this.evaluateMaturity(scopeId, candidate);
    }
    // ------------------------------------------------------------------ 审核状态机
    submitForReview(scopeId, candidateId, input) {
        const candidate = this.requireCandidate(scopeId, candidateId);
        const reviewer = requireReviewer(input.reviewer);
        const allowed = ['drafting', 'ready_for_review', 'changes_requested'];
        if (!allowed.includes(candidate.status)) {
            throw new SkillError(`当前状态 ${candidate.status} 不能提交审核`);
        }
        const version = candidate.currentVersionId
            ? this.candidates.getVersion(scopeId, candidate.currentVersionId)
            : null;
        if (!version)
            throw new SkillError('候选没有可提交的版本');
        const maturity = this.evaluateMaturity(scopeId, candidate);
        if (maturity.level === 'insufficient') {
            throw new SkillError(`证据不足，不能提交审核：${maturity.missing.join(', ')}`);
        }
        if (candidate.provenanceChanged && maturity.contradictions.length > 0) {
            throw new SkillError('来源发生变化且存在未解决矛盾，不能直接提交审核');
        }
        const at = this.now();
        const review = this.attempts.createReview({
            scopeId,
            candidateId: candidate.id,
            versionId: version.id,
            decision: 'submit',
            reviewer,
            reason: input.reason?.trim() || '提交审核',
            fromStatus: candidate.status,
            toStatus: 'in_review',
            createdAt: at,
        });
        this.candidates.setStatus(candidate.id, 'in_review', at);
        this.candidates.setVersionStatus(version.id, 'submitted', at);
        this.candidates.touch(candidate.id, at);
        return {
            candidate: this.requireCandidate(scopeId, candidate.id),
            version: this.requireVersion(scopeId, version.id),
            review,
        };
    }
    review(input) {
        const version = this.requireVersion(input.scopeId, input.versionId);
        const candidate = this.requireCandidate(input.scopeId, version.candidateId);
        const reviewer = requireReviewer(input.reviewer);
        const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
        if (reason.length < 2)
            throw new SkillError('审核必须写明理由');
        if (candidate.status !== 'in_review')
            throw new SkillError(`候选不在审核中（当前 ${candidate.status}）`);
        if (version.status !== 'submitted')
            throw new SkillError(`版本不在待审状态（当前 ${version.status}）`);
        let nextCandidateStatus;
        let nextVersionStatus;
        if (input.decision === 'approve') {
            nextCandidateStatus = 'approved';
            nextVersionStatus = 'approved';
        }
        else if (input.decision === 'reject') {
            nextCandidateStatus = 'rejected';
            nextVersionStatus = 'rejected';
        }
        else if (input.decision === 'request_changes') {
            nextCandidateStatus = 'changes_requested';
            nextVersionStatus = 'rejected';
        }
        else {
            throw new SkillError(`不支持的审核决定：${String(input.decision)}`);
        }
        const at = this.now();
        // 审核记录与状态迁移在同一个事务里提交（要么都写，要么都不写）。
        let review = null;
        this.candidates.transaction(() => {
            review = this.attempts.createReview({
                scopeId: input.scopeId,
                candidateId: candidate.id,
                versionId: version.id,
                decision: input.decision,
                reviewer,
                reason,
                fromStatus: candidate.status,
                toStatus: nextCandidateStatus,
                createdAt: at,
            });
            this.candidates.setVersionStatus(version.id, nextVersionStatus, at);
            this.candidates.setStatus(candidate.id, nextCandidateStatus, at);
            if (input.decision === 'approve') {
                // 批准只表示「接受描述」：不注册工具、不执行工作流、不改 Prompt。
                this.candidates.attachVersion(candidate.id, version.id, version.versionNo, at);
            }
        });
        if (!review)
            throw new SkillError('写入审核记录失败');
        return {
            candidate: this.requireCandidate(input.scopeId, candidate.id),
            version: this.requireVersion(input.scopeId, version.id),
            review,
        };
    }
    // ------------------------------------------------------------------ 内部
    patternGate(pattern) {
        if (!this.settings.enabled)
            return 'skill 功能未启用';
        if (pattern.status !== 'active' && !(this.settings.allowWeakenedPatterns && pattern.status === 'weakened')) {
            return `Pattern 状态 ${pattern.status} 不允许生成候选`;
        }
        const support = Math.max(pattern.supportCount, this.patternEvidence.countByPattern(pattern.id, 'supports'));
        if (support < this.settings.minSupportMemories) {
            return `支持数 ${support} < ${this.settings.minSupportMemories}`;
        }
        if (pattern.confidence < this.settings.minConfidence) {
            return `置信度 ${pattern.confidence} < ${this.settings.minConfidence}`;
        }
        return null;
    }
    deriveDraft(pattern, memories) {
        const notes = [];
        const steps = [];
        const memoriesForSteps = memories.slice(0, this.settings.maxStepsPerDraft);
        let stepNo = 0;
        for (const memory of memoriesForSteps) {
            stepNo += 1;
            const refs = this.refsForMemory(memory);
            const action = firstSentence(memory.content, 90);
            if (action.length < 2)
                continue;
            steps.push({
                stepNo,
                action,
                detail: memory.content,
                evidenceRefs: refs,
            });
        }
        const dropped = memoriesForSteps.length - stepNo;
        if (dropped > 0)
            notes.push(`${dropped} 条支持知识没有可用文本，未生成步骤`);
        const episodeIds = [
            ...new Set(memories.flatMap((memory) => this.episodeIdsForMemory(memory))),
        ];
        const experienceIds = [
            ...new Set(episodeIds.flatMap((episodeId) => this.experiences.listByEpisode(episodeId).map((experience) => experience.id))),
        ];
        if (steps.length === 0)
            notes.push('没有任何可用步骤：候选只能作为探索性记录，不能提交审核');
        const procedure = {
            steps,
            triggers: [
                {
                    id: 'trigger_1',
                    description: `出现与「${firstSentence(pattern.content, 60)}」同类的场景时`,
                },
            ],
            preconditions: [
                { id: 'pre_1', description: '处于同一 Scope / 同一项目上下文中', required: true },
                { id: 'pre_2', description: '前提条件与来源经历一致', required: false },
            ],
            expectedOutcomes: [
                { id: 'out_1', description: '按步骤执行后，得到与来源模式一致的结果' },
            ],
            exceptions: ['来源知识与当前场景冲突时不适用'],
            limitations: [
                '由模式推导而来，尚未验证执行效果',
                '仅适用于该 Scope 内的同类场景',
            ],
            successCriteria: [],
        };
        const snapshot = {
            memoryIds: memories.map((memory) => memory.id),
            episodeIds,
            experienceIds,
            capturedAt: this.now(),
        };
        return { procedure, snapshot, stepsWithEvidence: steps.length, notes };
    }
    refsForMemory(memory) {
        const refs = [{ type: 'memory', id: memory.id }];
        for (const episodeId of this.episodeIdsForMemory(memory).slice(0, MAX_EVIDENCE_PER_STEP)) {
            refs.push({ type: 'episode', id: episodeId });
        }
        return refs;
    }
    episodeIdsForMemory(memory) {
        // memory_evidence 是唯一权威来源；不要从文本猜 Episode。
        return this.evidence
            .listByMemory(memory.id)
            .filter((item) => item.evidenceType === 'episode')
            .map((item) => item.evidenceId);
    }
    collectEvidenceRefs(scopeId, candidate, version) {
        const refs = [];
        const memoryIds = candidate.sourceMemoryIds.length > 0
            ? candidate.sourceMemoryIds
            : (version?.evidenceSnapshot.memoryIds ?? []);
        for (const memory of this.memories.listByIds(memoryIds)) {
            if (memory.scopeId !== scopeId)
                continue;
            refs.push({
                type: 'memory',
                id: memory.id,
                sourceEpisodeIds: this.episodeIdsForMemory(memory),
            });
        }
        if (refs.length === 0 && version) {
            for (const id of version.evidenceSnapshot.experienceIds)
                refs.push({ type: 'experience', id });
            for (const id of version.evidenceSnapshot.episodeIds)
                refs.push({ type: 'episode', id });
        }
        return refs;
    }
    /**
     * 把每条 OutcomeEvidence 解析成「证据单位」：Episode 直接用；Experience 用其所属
     * Episode；Memory 用其来源 Episode。这样同一 Episode 的重复证据不会重复计数。
     */
    resolveAttemptEpisodes(scopeId, outcomes) {
        const result = new Map();
        for (const [attemptId, rows] of outcomes) {
            const units = new Set();
            for (const row of rows) {
                if (row.evidenceType === 'episode') {
                    units.add(`episode:${row.evidenceId}`);
                    continue;
                }
                if (row.evidenceType === 'experience') {
                    const experience = this.experiences.get(row.evidenceId);
                    if (experience?.episodeId)
                        units.add(`episode:${experience.episodeId}`);
                    else
                        units.add(`experience:${row.evidenceId}`);
                    continue;
                }
                if (row.evidenceType === 'memory') {
                    const episodeIds = this.episodeIdsForMemory2(row.evidenceId);
                    if (episodeIds.length > 0)
                        for (const id of episodeIds)
                            units.add(`episode:${id}`);
                    else
                        units.add(`memory:${row.evidenceId}`);
                    continue;
                }
                // 人工记录也是独立的观察单位（不能因为不是 Episode 就被丢掉）。
                units.add(`manual:${row.evidenceId}`);
            }
            result.set(attemptId, [...units]);
        }
        return result;
    }
    episodeIdsForMemory2(memoryId) {
        return this.evidence
            .listByMemory(memoryId)
            .filter((item) => item.evidenceType === 'episode')
            .map((item) => item.evidenceId);
    }
    syncReviewReadiness(scopeId, candidate, maturity) {
        if (!['drafting', 'ready_for_review'].includes(candidate.status))
            return;
        const canReview = maturity.level !== 'insufficient';
        const target = canReview ? 'ready_for_review' : 'drafting';
        if (candidate.status !== target)
            this.candidates.setStatus(candidate.id, target, this.now());
    }
    titleFor(pattern) {
        return firstSentence(pattern.content, 40) || `模式 ${pattern.id}`;
    }
    descriptionFor(pattern) {
        return `由 Pattern ${pattern.id}（${pattern.kind}，支持 ${pattern.supportCount}）派生的描述性候选。`;
    }
    kindFor(pattern) {
        switch (pattern.kind) {
            case 'recurring_decision':
            case 'recurring_solution':
                return 'decision_rule';
            case 'strategy':
                return 'guideline';
            case 'habit':
            case 'principle':
                return 'checklist';
            case 'recurring_problem':
                return 'guideline';
            default:
                return 'other';
        }
    }
    requireCandidate(scopeId, candidateId) {
        const candidate = this.candidates.getByIdAnyScope(candidateId);
        if (!candidate)
            throw new SkillError(`未找到候选 ${candidateId}`);
        if (candidate.scopeId !== scopeId)
            throw new SkillScopeError(`候选 ${candidateId} 不属于 scope ${scopeId}`);
        return candidate;
    }
    requireVersion(scopeId, versionId) {
        const version = this.candidates.getVersionAnyScope(versionId);
        if (!version)
            throw new SkillError(`未找到候选版本 ${versionId}`);
        if (version.scopeId !== scopeId)
            throw new SkillScopeError(`版本 ${versionId} 不属于 scope ${scopeId}`);
        return version;
    }
    requireAttempt(scopeId, attemptId) {
        const attempt = this.attempts.getByIdAnyScope(attemptId);
        if (!attempt)
            throw new SkillError(`未找到尝试 ${attemptId}`);
        if (attempt.scopeId !== scopeId)
            throw new SkillScopeError(`尝试 ${attemptId} 不属于 scope ${scopeId}`);
        return attempt;
    }
    requirePattern(scopeId, patternId) {
        const pattern = this.patterns.getById(patternId);
        if (!pattern)
            throw new SkillError(`未找到 Pattern ${patternId}`);
        if (pattern.scopeId !== scopeId)
            throw new SkillScopeError(`Pattern ${patternId} 不属于 scope ${scopeId}`);
        return pattern;
    }
    /** 证据必须真实存在且属于同一 Scope —— 不只信调用方给的 scope 参数。 */
    assertEvidenceScope(scopeId, type, id) {
        if (type === 'manual')
            return;
        if (type === 'episode') {
            const episode = this.episodes.get(id);
            if (!episode)
                throw new SkillError(`证据 Episode ${id} 不存在`);
            if (episode.scopeId !== scopeId)
                throw new SkillScopeError(`证据 Episode ${id} 不属于 scope ${scopeId}`);
            return;
        }
        if (type === 'experience') {
            const experience = this.experiences.get(id);
            if (!experience)
                throw new SkillError(`证据 Experience ${id} 不存在`);
            const episode = experience.episodeId ? this.episodes.get(experience.episodeId) : null;
            if (episode && episode.scopeId !== scopeId) {
                throw new SkillScopeError(`证据 Experience ${id} 属于 scope ${episode.scopeId}，不是 ${scopeId}`);
            }
            if (!episode) {
                const found = this.experiences.listByIds([id]);
                if (found.length === 0)
                    throw new SkillError(`证据 Experience ${id} 不存在`);
            }
            return;
        }
        const memory = this.memories.getById(id);
        if (!memory)
            throw new SkillError(`证据 Memory ${id} 不存在`);
        if (memory.scopeId !== scopeId)
            throw new SkillScopeError(`证据 Memory ${id} 不属于 scope ${scopeId}`);
    }
}
function requireReviewer(value) {
    const reviewer = typeof value === 'string' ? value.trim() : '';
    if (reviewer.length < 2)
        throw new SkillError('缺少可审计的审核人身份，禁止审核');
    return reviewer;
}
function firstSentence(text, max) {
    const trimmed = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (trimmed.length === 0)
        return '';
    const cut = trimmed.split(/[。！？!?\n]/)[0] ?? trimmed;
    return cut.length > max ? `${cut.slice(0, max)}…` : cut;
}
export { evaluateAttempts };
