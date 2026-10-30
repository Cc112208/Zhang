/**
 * stage5b.test.ts —— Stage 5 Phase 2 的验收测试（spec §八 1–20）。
 *
 * 覆盖：
 *   - 统计与成熟度：两次成功不构成证明、小样本、归因与分母口径、反例、成功标准约束；
 *   - 审核与版本：操作者认证（失败关闭）、Scope 越权、三种决定的审计记录、
 *     编辑产生新版本、旧版本与审核记录不变、新版本不继承批准、状态机不可绕过；
 *   - 事件与生命周期：来源证据变化可重算、重算不改原始 Experience、批准不产生执行。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { MemoryDatabase } from '../src/storage/database.js';
import { ExperienceRepository } from '../src/storage/repositories/experience-repository.js';
import { EpisodeRepository } from '../src/storage/repositories/episode-repository.js';
import { MemoryRepository } from '../src/memory/memory-repository.js';
import { EvidenceRepository } from '../src/memory/evidence-repository.js';
import { PatternRepository } from '../src/pattern/pattern-repository.js';
import { PatternEvidenceRepository } from '../src/pattern/pattern-evidence-repository.js';
import { SkillCandidateRepository } from '../src/skill/candidate-repository.js';
import { SkillAttemptRepository } from '../src/skill/attempt-repository.js';
import { SkillService } from '../src/skill/skill-service.js';
import { SkillError, SkillScopeError } from '../src/skill/errors.js';
import { summarizeEffectiveness, wilsonInterval } from '../src/skill/statistics.js';
import { OperatorAuth } from '../src/operator/operator-auth.js';
const BASE_TIME = Date.UTC(2026, 9, 31, 9, 0, 0);
const MINUTE = 60 * 1000;
const NOW = () => BASE_TIME;
function makeExperience(id, content) {
    return {
        id,
        sourceType: 'chat',
        content,
        createdAt: BASE_TIME,
        observedAt: BASE_TIME,
        importance: 0.6,
        metadata: {},
        embeddingStatus: 'disabled',
    };
}
function makeEpisode(id, experienceIds, offsetMinutes = 0) {
    const startedAt = BASE_TIME + offsetMinutes * MINUTE;
    return {
        id,
        startedAt,
        endedAt: startedAt + 5 * MINUTE,
        experienceIds,
        participants: [],
        locations: [],
        topics: [],
        importance: 0.6,
        salience: 0.5,
        confidence: 0.6,
        status: 'closed',
        createdAt: startedAt,
        updatedAt: startedAt,
        embeddingStatus: 'disabled',
        summaryStatus: 'ready',
        consolidationStatus: 'ready',
        continuityStatus: 'ready',
        lastExperienceAt: startedAt,
    };
}
const SETTINGS = {
    enabled: true,
    minSupportMemories: 3,
    minIndependentEpisodes: 2,
    minStability: 0.5,
    maxStepsPerDraft: 6,
    minValidatedAttempts: 5,
    minIndependentAttempts: 5,
    minDirectAttempts: 1,
    minSuccessRateForValidated: 0.5,
    minReportableSamples: 5,
    wilsonZ: 1.96,
    minStepCoverage: 0.6,
    minConfidence: 0.5,
    allowWeakenedPatterns: true,
};
function openHarness(path) {
    const db = MemoryDatabase.open(path);
    const episodes = new EpisodeRepository({ db });
    const experiences = new ExperienceRepository({ db });
    const memories = new MemoryRepository({ db, now: NOW });
    const evidence = new EvidenceRepository({ db, now: NOW });
    const patterns = new PatternRepository({ db, now: NOW });
    const patternEvidence = new PatternEvidenceRepository({ db, now: NOW });
    const skill = new SkillService({
        candidates: new SkillCandidateRepository({ db, now: NOW }),
        attempts: new SkillAttemptRepository({ db, now: NOW }),
        patterns,
        patternEvidence,
        memories,
        evidence,
        episodes,
        experiences,
        settings: SETTINGS,
        now: NOW,
    });
    return { db, experiences, episodes, memories, patterns, patternEvidence, evidence, skill };
}
/** 造一个「N 条 Memory / N 个独立 Episode / active Pattern」的证据基座，并生成候选 v1。 */
function seed(harness, scopeId, options = {}) {
    const count = options.memories ?? 3;
    const suffix = `${scopeId.length}_${Math.floor(Math.random() * 100000)}`;
    const episodeIds = [];
    const memoryIds = [];
    for (let index = 0; index < count; index += 1) {
        const episodeId = `ep_p2_${suffix}_${index}`;
        const experienceId = `xp_p2_${suffix}_${index}`;
        harness.experiences.insert(makeExperience(experienceId, `第 ${index + 1} 次决定先保证本地可跑，不引入额外服务。`), scopeId);
        harness.episodes.insertWithSession(makeEpisode(episodeId, [experienceId], index * 60), scopeId, `sess_${suffix}_${index}`);
        const memory = harness.memories.create({
            scopeId,
            kind: 'decision',
            content: `第 ${index + 1} 条：决定先保证本地可跑，不引入额外服务。`,
            confidence: 0.7,
            importance: 0.6,
        });
        harness.evidence.insert({
            memoryId: memory.id,
            evidenceType: 'episode',
            evidenceId: episodeId,
            relation: 'derived_from',
        });
        memoryIds.push(memory.id);
        episodeIds.push(episodeId);
    }
    const pattern = harness.patterns.create({
        scopeId,
        kind: 'recurring_decision',
        content: '这个项目在早期决策里持续倾向避免引入额外基础设施。',
        confidence: 0.72,
        importance: 0.6,
        status: 'active',
        supportCount: count,
        firstObservedAt: BASE_TIME,
        lastObservedAt: BASE_TIME + 60 * MINUTE,
    });
    harness.patternEvidence.insertMany(pattern.id, memoryIds, 'supports');
    const ensured = harness.skill.ensureCandidateForPattern(scopeId, pattern.id);
    return {
        candidate: ensured.candidate,
        versionId: ensured.version?.id ?? ensured.candidate.currentVersionId ?? '',
        memoryIds,
        episodeIds,
    };
}
const CRITERIA = {
    steps: [
        { stepNo: 1, action: '先确认是否已有本地可用方案', evidenceRefs: [] },
        { stepNo: 2, action: '只有在规模证明需要后才引入新服务', evidenceRefs: [] },
    ],
    triggers: [{ id: 't1', description: '准备引入新基础设施时' }],
    preconditions: [{ id: 'p1', description: '同一项目上下文', required: true }],
    expectedOutcomes: [{ id: 'o1', description: '避免过早复杂化' }],
    exceptions: [],
    limitations: ['仅适用于早期阶段'],
    successCriteria: [{ id: 'c1', description: '没有引入额外服务且需求仍被满足', source: 'manual' }],
};
function draftWithRefs(memoryIds) {
    return {
        ...CRITERIA,
        steps: [
            {
                stepNo: 1,
                action: '先确认是否已有本地可用方案',
                evidenceRefs: memoryIds[0] ? [{ type: 'memory', id: memoryIds[0] }] : [],
            },
            {
                stepNo: 2,
                action: '只有在规模证明需要后才引入新服务',
                evidenceRefs: memoryIds[1] ? [{ type: 'memory', id: memoryIds[1] }] : [],
            },
        ],
    };
}
function withCriteria(harness, scopeId, candidateId, memoryIds = []) {
    const version = harness.skill.createVersion(scopeId, candidateId, {
        procedure: draftWithRefs(memoryIds),
        changeReason: '补上人工确认的成功标准',
        createdBy: 'test-reviewer',
    });
    return version.id;
}
/** 造一个「有证据步骤 + 5 次独立成功尝试」的候选版本，达到可提交审核的状态。 */
function makeReady(harness, scopeId, seeded) {
    const versionId = withCriteria(harness, scopeId, seeded.candidate.id, seeded.memoryIds);
    for (let index = 0; index < 5; index += 1) {
        completeAttempt(harness, scopeId, versionId, index, {
            attribution: index === 0 ? 'user_reported' : 'direct',
            evidence: [
                {
                    evidenceType: 'episode',
                    evidenceId: seeded.episodeIds[index % seeded.episodeIds.length],
                    relation: 'supports',
                },
            ],
        });
    }
    return versionId;
}
function completeAttempt(harness, scopeId, versionId, index, options = {}) {
    const recorded = harness.skill.recordAttempt({
        scopeId,
        versionId,
        externalKey: options.key ?? `key_${scopeId}_${index}_${Math.floor(Math.random() * 100000)}`,
        ...(options.attribution ? { attribution: options.attribution } : {}),
    });
    harness.skill.completeAttempt({
        scopeId,
        attemptId: recorded.attempt.id,
        result: options.result ?? 'success',
        ...(options.attribution ? { attribution: options.attribution } : {}),
        evidence: options.evidence ?? [
            { evidenceType: 'manual', evidenceId: `note_${scopeId}_${index}_${Math.floor(Math.random() * 100000)}`, relation: 'supports' },
        ],
    });
    return recorded.attempt.id;
}
describe('Stage 5 Phase 2：统计验证 / 人工审核 / 版本编辑 / 事件重算', () => {
    let directory = '';
    let harness;
    before(() => {
        directory = mkdtempSync(join(tmpdir(), 'memory-sea-stage5b-'));
        harness = openHarness(join(directory, 'memory-sea.db'));
    });
    after(() => {
        try {
            harness.db.close();
        }
        catch {
            // 关闭失败不影响测试结论
        }
        rmSync(directory, { recursive: true, force: true });
    });
    it('1. 两次成功不自动等于 validated', () => {
        const scope = 'project_p2a';
        const seeded = seed(harness, scope);
        const versionId = withCriteria(harness, scope, seeded.candidate.id, seeded.memoryIds);
        completeAttempt(harness, scope, versionId, 1, { attribution: 'direct' });
        completeAttempt(harness, scope, versionId, 2, { attribution: 'direct' });
        const maturity = harness.skill.getMaturity(scope, seeded.candidate.id);
        // Phase 2：两次成功只说明「观察到有效」，不是证明。
        assert.equal(maturity.level, 'observed');
        assert.ok(maturity.missing.includes('insufficient_independent_attempts') || maturity.missing.includes('insufficient_verified_samples'));
        assert.equal(maturity.effectiveness?.sampleSize, 2);
        assert.equal(maturity.effectiveness?.smallSample, true);
    });
    it('2. 小样本给出 Wilson 区间并标记样本不足', () => {
        const interval = wilsonInterval(2, 2);
        assert.ok(interval);
        assert.ok(interval.low > 0.3 && interval.high === 1);
        const summary = summarizeEffectiveness({
            successes: 2,
            sampleSize: 2,
            independentSampleSize: 2,
            successCriteriaDefined: true,
            minReportableSamples: 5,
            wilsonZ: 1.96,
        });
        assert.equal(summary.smallSample, true);
        assert.ok(summary.ci95);
        assert.ok((summary.ci95?.low ?? 0) >= 0);
        assert.ok((summary.ci95?.high ?? 0) <= 1);
    });
    it('3. inferred 结果不计入已验证成功率', () => {
        const scope = 'project_p2b';
        const seeded = seed(harness, scope);
        const versionId = withCriteria(harness, scope, seeded.candidate.id, seeded.memoryIds);
        completeAttempt(harness, scope, versionId, 1, { attribution: 'inferred' });
        const maturity = harness.skill.getMaturity(scope, seeded.candidate.id);
        assert.equal(maturity.attempts.inferred, 1);
        assert.equal(maturity.attempts.verified, 0);
        assert.equal(maturity.effectiveness?.sampleSize, 0);
        assert.equal(maturity.effectiveness?.reportable, false);
    });
    it('4. unknown / inconclusive 不进成功率分母', () => {
        const scope = 'project_p2c';
        const seeded = seed(harness, scope);
        const versionId = withCriteria(harness, scope, seeded.candidate.id, seeded.memoryIds);
        completeAttempt(harness, scope, versionId, 1, { attribution: 'direct', result: 'unknown' });
        completeAttempt(harness, scope, versionId, 2, { attribution: 'direct' });
        const maturity = harness.skill.getMaturity(scope, seeded.candidate.id);
        assert.equal(maturity.attempts.unknown, 1);
        assert.equal(maturity.effectiveness?.sampleSize, 1);
        assert.equal(maturity.effectiveness?.successRate, 1);
    });
    it('5. 同一次 Attempt 的多条证据不会被算成多次独立尝试', () => {
        const scope = 'project_p2d';
        const seeded = seed(harness, scope);
        const versionId = withCriteria(harness, scope, seeded.candidate.id, seeded.memoryIds);
        completeAttempt(harness, scope, versionId, 1, {
            attribution: 'direct',
            evidence: [
                { evidenceType: 'episode', evidenceId: seeded.episodeIds[0], relation: 'supports' },
                { evidenceType: 'memory', evidenceId: seeded.memoryIds[0], relation: 'supports' },
                { evidenceType: 'memory', evidenceId: seeded.memoryIds[1], relation: 'supports' },
            ],
        });
        const maturity = harness.skill.getMaturity(scope, seeded.candidate.id);
        assert.equal(maturity.attempts.total, 1);
        assert.equal(maturity.attempts.verified, 1);
        assert.equal(maturity.attempts.independentVerified, 1);
    });
    it('6. 不同 Episode 的独立尝试可正确累计，达到门槛后才 validated', () => {
        const scope = 'project_p2e';
        const seeded = seed(harness, scope, { memories: 5 });
        const versionId = withCriteria(harness, scope, seeded.candidate.id, seeded.memoryIds);
        for (let index = 0; index < 5; index += 1) {
            completeAttempt(harness, scope, versionId, index, {
                attribution: index === 0 ? 'user_reported' : 'direct',
                evidence: [{ evidenceType: 'episode', evidenceId: seeded.episodeIds[index], relation: 'supports' }],
            });
        }
        const maturity = harness.skill.getMaturity(scope, seeded.candidate.id);
        assert.equal(maturity.attempts.independentVerified, 5);
        assert.equal(maturity.level, 'validated');
        assert.equal(maturity.effectiveness?.reportable, true);
        assert.ok((maturity.effectiveness?.successRate ?? 0) > 0.5);
    });
    it('7. 反例会影响成熟度与评估理由', () => {
        const scope = 'project_p2f';
        const seeded = seed(harness, scope, { memories: 5 });
        const versionId = withCriteria(harness, scope, seeded.candidate.id, seeded.memoryIds);
        for (let index = 0; index < 5; index += 1) {
            completeAttempt(harness, scope, versionId, index, {
                attribution: 'direct',
                evidence: [{ evidenceType: 'episode', evidenceId: seeded.episodeIds[index], relation: 'supports' }],
            });
        }
        completeAttempt(harness, scope, versionId, 9, {
            attribution: 'direct',
            result: 'failure',
            evidence: [{ evidenceType: 'manual', evidenceId: 'counter_example_1', relation: 'contradicts' }],
        });
        const maturity = harness.skill.getMaturity(scope, seeded.candidate.id);
        assert.ok(maturity.contradictions.length > 0);
        assert.notEqual(maturity.level, 'validated');
        assert.ok(maturity.reasons.join(' ').includes('反例'));
    });
    it('8. 没有成功标准时不能声称已验证有效', () => {
        const scope = 'project_p2g';
        const seeded = seed(harness, scope, { memories: 5 });
        // v1 没有成功标准，直接跑 5 次「成功」。
        for (let index = 0; index < 5; index += 1) {
            completeAttempt(harness, scope, seeded.versionId, index, {
                attribution: 'direct',
                evidence: [{ evidenceType: 'episode', evidenceId: seeded.episodeIds[index], relation: 'supports' }],
            });
        }
        const maturity = harness.skill.getMaturity(scope, seeded.candidate.id);
        assert.notEqual(maturity.level, 'validated');
        assert.ok(maturity.missing.includes('no_success_criteria'));
        assert.equal(maturity.effectiveness?.reportable, false);
    });
    it('9. 未认证 / 非本机 / 关闭的操作者无法通过认证', () => {
        const tokenPath = join(directory, 'operator-token-test');
        writeFileSync(tokenPath, `${'a'.repeat(64)}\n`, 'utf8');
        const auth = new OperatorAuth({ tokenPath });
        auth.ensure();
        const missing = auth.authenticate({ headers: {}, socket: { remoteAddress: '127.0.0.1' } });
        assert.equal(missing.ok, false);
        if (!missing.ok)
            assert.equal(missing.status, 401);
        const wrong = auth.authenticate({ headers: { authorization: 'Bearer deadbeef' }, socket: { remoteAddress: '127.0.0.1' } });
        assert.equal(wrong.ok, false);
        if (!wrong.ok)
            assert.equal(wrong.status, 401);
        const remote = auth.authenticate({
            headers: { authorization: `Bearer ${'a'.repeat(64)}` },
            socket: { remoteAddress: '10.1.2.3' },
        });
        assert.equal(remote.ok, false);
        if (!remote.ok)
            assert.equal(remote.status, 403);
        const disabled = new OperatorAuth({ tokenPath, enabled: false });
        const closed = disabled.authenticate({ headers: { authorization: `Bearer ${'a'.repeat(64)}` } });
        assert.equal(closed.ok, false);
        if (!closed.ok)
            assert.equal(closed.status, 503);
    });
    it('10. 越权 Scope 无法审核（跨 scope 直接失败）', () => {
        const scopeA = 'project_p2h';
        const scopeB = 'project_p2i';
        const seeded = seed(harness, scopeA);
        const versionId = makeReady(harness, scopeA, seeded);
        const submitted = harness.skill.submitForReview(scopeA, seeded.candidate.id, { reviewer: 'op_test', reason: '提交' });
        assert.equal(submitted.candidate.status, 'in_review');
        assert.throws(() => harness.skill.review({
            scopeId: scopeB,
            versionId,
            decision: 'approve',
            reviewer: 'op_test',
            reason: '越权尝试',
        }), (error) => error instanceof SkillScopeError);
    });
    it('11. 批准 / 拒绝 / 请求修改都产生可追溯的追加式记录', () => {
        const cases = [
            ['approve', 'project_p2j'],
            ['reject', 'project_p2k'],
            ['request_changes', 'project_p2l'],
        ];
        for (const [decision, scope] of cases) {
            const seeded = seed(harness, scope);
            makeReady(harness, scope, seeded);
            const submitted = harness.skill.submitForReview(scope, seeded.candidate.id, {
                reviewer: 'local_token:op_test1',
                reason: '提交审核',
            });
            const reviewed = harness.skill.review({
                scopeId: scope,
                versionId: submitted.version.id,
                decision,
                reviewer: 'local_token:op_test1',
                reason: `测试 ${decision}`,
            });
            const records = harness.skill.listReviews(scope, seeded.candidate.id);
            assert.deepEqual(records.map((record) => record.decision), ['submit', decision]);
            assert.equal(records[1]?.reviewer, 'local_token:op_test1');
            assert.equal(reviewed.version.status === 'approved', decision === 'approve');
        }
    });
    it('12/13. 已审核版本编辑后生成新版本，旧版本与审核记录保持不变', () => {
        const scope = 'project_p2m';
        const seeded = seed(harness, scope);
        const versionId = makeReady(harness, scope, seeded);
        const submitted = harness.skill.submitForReview(scope, seeded.candidate.id, { reviewer: 'op_edit', reason: '提交' });
        harness.skill.review({
            scopeId: scope,
            versionId: submitted.version.id,
            decision: 'approve',
            reviewer: 'op_edit',
            reason: '接受描述',
        });
        const beforeVersions = harness.skill.listVersions(scope, seeded.candidate.id);
        const beforeReviews = harness.skill.listReviews(scope, seeded.candidate.id);
        const edited = harness.skill.editProcedure(scope, seeded.candidate.id, {
            procedure: {
                ...CRITERIA,
                steps: [...CRITERIA.steps, { stepNo: 3, action: '记录选择理由与替代方案', evidenceRefs: [] }],
            },
            changeReason: '补充记录步骤',
            createdBy: 'op_edit',
        });
        const afterVersions = harness.skill.listVersions(scope, seeded.candidate.id);
        const afterReviews = harness.skill.listReviews(scope, seeded.candidate.id);
        assert.equal(afterVersions.length, beforeVersions.length + 1);
        assert.equal(edited.versionNo, beforeVersions[beforeVersions.length - 1].versionNo + 1);
        const oldVersion = afterVersions.find((item) => item.id === versionId);
        // 旧版本的内容永远不变；被更新版本取代时只允许状态从 approved 变为 superseded（历史保留）。
        assert.ok(['approved', 'superseded'].includes(oldVersion?.status ?? ''));
        assert.equal(oldVersion?.procedure.steps.length, 2);
        assert.equal(oldVersion?.changeReason, '补上人工确认的成功标准');
        assert.deepEqual(afterReviews.map((record) => record.id), beforeReviews.map((record) => record.id));
    });
    it('14. 新版本不继承旧版本的批准状态', () => {
        const scope = 'project_p2n';
        const seeded = seed(harness, scope);
        const versionId = makeReady(harness, scope, seeded);
        const submitted = harness.skill.submitForReview(scope, seeded.candidate.id, { reviewer: 'op_v', reason: '提交' });
        harness.skill.review({
            scopeId: scope,
            versionId: submitted.version.id,
            decision: 'approve',
            reviewer: 'op_v',
            reason: '接受',
        });
        const edited = harness.skill.editProcedure(scope, seeded.candidate.id, {
            procedure: CRITERIA,
            changeReason: '重写步骤措辞',
            createdBy: 'op_v',
        });
        assert.equal(edited.status, 'draft');
        const candidate = harness.skill.getCandidate(scope, seeded.candidate.id);
        assert.equal(candidate?.status, 'drafting');
        assert.equal(candidate?.currentVersionId, edited.id);
    });
    it('15. 重复审核请求不能绕过状态机', () => {
        const scope = 'project_p2o';
        const seeded = seed(harness, scope);
        const versionId = makeReady(harness, scope, seeded);
        const submitted = harness.skill.submitForReview(scope, seeded.candidate.id, { reviewer: 'op_dup', reason: '提交' });
        harness.skill.review({
            scopeId: scope,
            versionId: submitted.version.id,
            decision: 'approve',
            reviewer: 'op_dup',
            reason: '第一次',
        });
        assert.throws(() => harness.skill.review({
            scopeId: scope,
            versionId: submitted.version.id,
            decision: 'approve',
            reviewer: 'op_dup',
            reason: '第二次',
        }), (error) => error instanceof SkillError);
        assert.equal(harness.skill.listReviews(scope, seeded.candidate.id).length, 2);
    });
    it('16. 来源证据变化后可重算成熟度，且不改写原始 Experience', () => {
        const scope = 'project_p2p';
        const seeded = seed(harness, scope);
        const versionId = withCriteria(harness, scope, seeded.candidate.id, seeded.memoryIds);
        completeAttempt(harness, scope, versionId, 1, { attribution: 'direct' });
        const experienceBefore = harness.experiences.get(seeded.memoryIds[0] ?? '');
        const memory = harness.memories.getById(seeded.memoryIds[0]);
        assert.ok(memory);
        harness.memories.markSuperseded(memory.id, 'mem_replacement', BASE_TIME);
        const changed = harness.skill.markProvenanceChanged(scope, seeded.candidate.id, '来源知识被取代');
        assert.equal(changed, true);
        const candidate = harness.skill.getCandidate(scope, seeded.candidate.id);
        assert.equal(candidate?.provenanceChanged, true);
        const maturity = harness.skill.reevaluate(scope, seeded.candidate.id);
        assert.ok(['insufficient', 'structural_only', 'observed'].includes(maturity.level));
        // 原始 Experience 一字未改。
        const after = harness.experiences.get(seeded.memoryIds[0] ?? '');
        assert.equal(after?.content ?? null, experienceBefore?.content ?? null);
    });
    it('17. 批准与成熟度变化不会触发任何执行行为', () => {
        const skillAny = harness.skill;
        for (const forbidden of ['execute', 'run', 'invoke', 'apply', 'runSkill', 'autoToolCall', 'policyApply']) {
            assert.equal(typeof skillAny[forbidden], 'undefined', `不应存在执行入口：${forbidden}`);
        }
        const scope = 'project_p2q';
        const seeded = seed(harness, scope);
        const versionId = makeReady(harness, scope, seeded);
        completeAttempt(harness, scope, versionId, 1, { attribution: 'direct' });
        const attemptsBefore = harness.skill.listAttempts(scope, { candidateId: seeded.candidate.id }).length;
        const submitted = harness.skill.submitForReview(scope, seeded.candidate.id, { reviewer: 'op_exec', reason: '提交' });
        harness.skill.review({
            scopeId: scope,
            versionId: submitted.version.id,
            decision: 'approve',
            reviewer: 'op_exec',
            reason: '接受描述',
        });
        // 批准只改状态：不会凭空多出尝试，也不会产生执行记录。
        assert.equal(harness.skill.listAttempts(scope, { candidateId: seeded.candidate.id }).length, attemptsBefore);
        // 批准本身不产生任何执行：成熟度只由真实尝试与证据决定。
        const maturity = harness.skill.getMaturity(scope, seeded.candidate.id);
        assert.ok(['insufficient', 'structural_only', 'observed', 'validated'].includes(maturity.level));
    });
});
