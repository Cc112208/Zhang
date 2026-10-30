/**
 * stage5.test.ts —— Stage 5 Phase 1 的验收测试（spec 第十四节 14 项）。
 *
 * 覆盖三层：
 *   1. 纯函数层：独立证据去重、成熟度判定、成功率分母；
 *   2. 领域层：候选生成幂等 / 版本不可变 / Attempt 结果约束 / 审核状态机 / Scope 隔离；
 *   3. 持久化层：重启后幂等、审核记录 append-only。
 *
 * 这里**不**测任何执行能力 —— Phase 1 根本没有执行路径，测试也要证明这一点。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { foldEvidence, assessMaturity } from '../src/skill/evidence-independence.js';
import { SkillError, SkillScopeError } from '../src/skill/errors.js';
import { JobRepository } from '../src/jobs/job-repository.js';
const BASE_TIME = Date.UTC(2026, 9, 30, 9, 0, 0);
const MINUTE = 60 * 1000;
const SCOPE_A = 'project_skilla';
const SCOPE_B = 'project_skillb';
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
    return {
        id,
        startedAt: BASE_TIME + offsetMinutes * MINUTE,
        endedAt: BASE_TIME + offsetMinutes * MINUTE + 5 * MINUTE,
        experienceIds,
        participants: [],
        locations: [],
        topics: [],
        importance: 0.6,
        salience: 0.5,
        confidence: 0.6,
        status: 'closed',
        createdAt: BASE_TIME + offsetMinutes * MINUTE,
        updatedAt: BASE_TIME + offsetMinutes * MINUTE,
        embeddingStatus: 'disabled',
        summaryStatus: 'ready',
        consolidationStatus: 'ready',
        continuityStatus: 'ready',
        lastExperienceAt: BASE_TIME + offsetMinutes * MINUTE,
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
    return { db, episodes, experiences, memories, evidence, patterns, patternEvidence, skill };
}
/** 构造一个「3 条 Memory、3 个独立 Episode、1 个 active Pattern」的最小证据集。 */
function seedPattern(harness, scopeId, options = {}) {
    const count = options.memories ?? 3;
    const episodeIds = [];
    const memoryIds = [];
    for (let index = 0; index < count; index += 1) {
        const episodeId = `ep_seed_${scopeId.slice(-1)}_${index}`;
        const experienceId = `xp_seed_${scopeId.slice(-1)}_${index}`;
        harness.experiences.insert(makeExperience(experienceId, `第 ${index + 1} 次决定先保证本地可跑。`), scopeId);
        harness.episodes.insertWithSession(makeEpisode(episodeId, [experienceId], index * 60), scopeId, `sess_${index}`);
        const memory = harness.memories.create({
            scopeId,
            kind: 'decision',
            content: `第 ${index + 1} 条：决定先保证本地可跑，不引入额外服务。`,
            confidence: 0.7,
            importance: 0.6,
        });
        harness.evidence.insert({ memoryId: memory.id, evidenceType: 'episode', evidenceId: episodeId, relation: 'derived_from' });
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
    return { candidate: ensured.candidate, patternId: pattern.id, memoryIds, episodeIds };
}
const DRAFT = {
    steps: [
        { stepNo: 1, action: '先确认是否已有本地可用方案', evidenceRefs: [{ type: 'memory', id: 'mem_x' }] },
        { stepNo: 2, action: '只有在规模证明需要后才引入新服务', evidenceRefs: [{ type: 'memory', id: 'mem_y' }] },
    ],
    triggers: [{ id: 't1', description: '准备引入新基础设施时' }],
    preconditions: [{ id: 'p1', description: '同一项目上下文', required: true }],
    expectedOutcomes: [{ id: 'o1', description: '避免过早复杂化' }],
    exceptions: [],
    limitations: ['仅适用于早期阶段'],
    successCriteria: [{ id: 'c1', description: '没有引入额外服务且需求仍被满足' }],
};
describe('Stage 5 Phase 1：候选 / 版本 / 尝试 / 审核', () => {
    let directory = '';
    let harness;
    before(() => {
        directory = mkdtempSync(join(tmpdir(), 'memory-sea-stage5-'));
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
    it('1. 同一个 Pattern 不会重复创建候选（幂等）', () => {
        const seed = seedPattern(harness, SCOPE_A);
        const again = harness.skill.ensureCandidateForPattern(SCOPE_A, seed.patternId);
        assert.equal(again.created, false);
        assert.equal(again.candidate.id, seed.candidate.id);
        // 同一个 scope 下该 Pattern 只应有一个候选：再跑一次 discover 也不新增。
        const discovery = harness.skill.discover(SCOPE_A, { limit: 10 });
        assert.equal(discovery.created, 0);
        const candidates = harness.skill.listCandidates(SCOPE_A, { limit: 20 });
        assert.equal(candidates.filter((item) => item.sourcePatternId === seed.patternId).length, 1);
    });
    it('2. 同一条原始证据经多条派生路径只计一次（独立证据去重）', () => {
        // 三个 Memory 都来自同一个 Episode：Episode 只能贡献 1 个独立单位，Memory 仍是 3 条。
        const refs = [
            { type: 'memory', id: 'mem_1', sourceEpisodeIds: ['ep_shared'] },
            { type: 'memory', id: 'mem_2', sourceEpisodeIds: ['ep_shared'] },
            { type: 'memory', id: 'mem_3', sourceEpisodeIds: ['ep_shared'] },
            { type: 'memory', id: 'mem_1', sourceEpisodeIds: ['ep_shared'] },
        ];
        const folded = foldEvidence(SCOPE_A, refs);
        // 三个不同 Memory → 三个独立记忆；它们都来自同一个 Episode → 独立 Episode 只有 1 个。
        assert.equal(folded.memoryIds.size, 3);
        assert.equal(folded.episodeIds.size, 1);
        assert.equal(folded.evidence.independentMemories, 3);
        assert.equal(folded.evidence.independentEpisodes, 1);
        assert.equal(folded.evidence.rawRefs, 4);
        // 4 条引用折叠成 1 个独立单位（都指向 ep_shared），重复路径不会被重复计数。
        assert.equal(folded.evidence.independentUnits, 1);
        assert.equal(folded.evidence.duplicatesRemoved, 3);
    });
    it('3. Scope 不匹配时写入失败（不只信调用方参数）', () => {
        const seedB = seedPattern(harness, SCOPE_B);
        const versions = harness.skill.listVersions(SCOPE_B, seedB.candidate.id);
        assert.equal(versions.length, 1);
        assert.throws(() => harness.skill.recordAttempt({
            scopeId: SCOPE_A,
            versionId: versions[0].id,
            externalKey: 'scope-mismatch-1',
        }), (error) => error instanceof SkillScopeError);
    });
    it('4. 步骤没有证据时不生成「完整流程」', () => {
        const noEvidenceSteps = {
            ...DRAFT,
            steps: [{ stepNo: 1, action: '做一件事', evidenceRefs: [] }],
        };
        const maturity = assessMaturity({
            candidateId: 'skc_x',
            scopeId: SCOPE_A,
            versionStatus: 'draft',
            procedure: noEvidenceSteps,
            evidenceSnapshot: { memoryIds: ['mem_1'], episodeIds: ['ep_1'], experienceIds: [], capturedAt: BASE_TIME },
            attempts: [],
            outcomes: new Map(),
            patternWeakened: false,
            policy: {
                minIndependentEpisodes: 2,
                minValidatedAttempts: 2,
                minStepCoverage: 0.6,
                requireSuccess: true,
            },
            now: NOW(),
        });
        assert.equal(maturity.level, 'insufficient');
        assert.ok(maturity.missing.includes('step_without_evidence'));
        assert.equal(maturity.stepCoverage, 0);
    });
    it('5. 没有预先定义成功标准时，不声称已验证成功', () => {
        const seed = seedPattern(harness, 'project_skillc');
        const version = harness.skill.listVersions('project_skillc', seed.candidate.id)[0];
        assert.equal(version.procedure.successCriteria.length, 0);
        const recorded = harness.skill.recordAttempt({
            scopeId: 'project_skillc',
            versionId: version.id,
            externalKey: 'no-criteria-1',
        });
        const completed = harness.skill.completeAttempt({
            scopeId: 'project_skillc',
            attemptId: recorded.attempt.id,
            result: 'success',
            evidence: [{ evidenceType: 'manual', evidenceId: 'manual_note_1', relation: 'supports' }],
        });
        // 结果被降级为 inconclusive：没有标准就不能判定成功。
        assert.equal(completed.attempt.result, 'inconclusive');
        const maturity = harness.skill.getMaturity('project_skillc', seed.candidate.id);
        assert.notEqual(maturity.level, 'validated');
        assert.equal(maturity.attempts.verified, 0);
    });
    it('6. inferred 的尝试不进已验证成功率', () => {
        const seed = seedPattern(harness, 'project_skilld');
        const version = harness.skill.createVersion('project_skilld', seed.candidate.id, {
            procedure: DRAFT,
            changeReason: '补充成功标准',
            createdBy: 'tester',
        });
        const recorded = harness.skill.recordAttempt({
            scopeId: 'project_skilld',
            versionId: version.id,
            externalKey: 'inferred-1',
            attribution: 'inferred',
        });
        harness.skill.completeAttempt({
            scopeId: 'project_skilld',
            attemptId: recorded.attempt.id,
            result: 'success',
            attribution: 'inferred',
            evidence: [{ evidenceType: 'manual', evidenceId: 'inferred_note_1', relation: 'supports' }],
        });
        const maturity = harness.skill.getMaturity('project_skilld', seed.candidate.id);
        assert.equal(maturity.attempts.total, 1);
        assert.equal(maturity.attempts.inferred, 1);
        assert.equal(maturity.attempts.verified, 0);
        assert.equal(maturity.effectiveness?.reportable ?? false, false);
        assert.notEqual(maturity.level, 'validated');
    });
    it('7. unknown / inconclusive 不进成功率分母', () => {
        const seed = seedPattern(harness, 'project_skille');
        const version = harness.skill.createVersion('project_skille', seed.candidate.id, {
            procedure: DRAFT,
            changeReason: '补充成功标准',
            createdBy: 'tester',
        });
        const unknown = harness.skill.recordAttempt({
            scopeId: 'project_skille',
            versionId: version.id,
            externalKey: 'unknown-1',
        });
        harness.skill.completeAttempt({
            scopeId: 'project_skille',
            attemptId: unknown.attempt.id,
            result: 'unknown',
            attribution: 'user_reported',
        });
        const success = harness.skill.recordAttempt({
            scopeId: 'project_skille',
            versionId: version.id,
            externalKey: 'success-1',
            attribution: 'user_reported',
        });
        harness.skill.completeAttempt({
            scopeId: 'project_skille',
            attemptId: success.attempt.id,
            result: 'success',
            attribution: 'user_reported',
            evidence: [{ evidenceType: 'manual', evidenceId: 'note_success_1', relation: 'supports' }],
        });
        const maturity = harness.skill.getMaturity('project_skille', seed.candidate.id);
        assert.equal(maturity.attempts.total, 2);
        assert.equal(maturity.attempts.unknown, 1);
        assert.equal(maturity.effectiveness?.sampleSize, 1);
        assert.equal(maturity.effectiveness?.successRate, 1);
    });
    it('8. 同一 Attempt 的多条证据只算一次执行', () => {
        const seed = seedPattern(harness, 'project_skillf');
        const version = harness.skill.createVersion('project_skillf', seed.candidate.id, {
            procedure: DRAFT,
            changeReason: '补充成功标准',
            createdBy: 'tester',
        });
        const recorded = harness.skill.recordAttempt({
            scopeId: 'project_skillf',
            versionId: version.id,
            externalKey: 'multi-evidence-1',
            attribution: 'direct',
        });
        const completed = harness.skill.completeAttempt({
            scopeId: 'project_skillf',
            attemptId: recorded.attempt.id,
            result: 'success',
            attribution: 'direct',
            evidence: [
                { evidenceType: 'manual', evidenceId: 'm1', relation: 'supports' },
                { evidenceType: 'manual', evidenceId: 'm2', relation: 'supports' },
                { evidenceType: 'manual', evidenceId: 'm3', relation: 'partial' },
            ],
        });
        assert.equal(completed.evidenceAdded, 3);
        const maturity = harness.skill.getMaturity('project_skillf', seed.candidate.id);
        assert.equal(maturity.attempts.total, 1);
        assert.equal(maturity.attempts.completed, 1);
    });
    it('9. 新版本不覆盖旧版本（版本不可变）', () => {
        const seed = seedPattern(harness, 'project_skillg');
        const original = harness.skill.listVersions('project_skillg', seed.candidate.id)[0];
        const created = harness.skill.createVersion('project_skillg', seed.candidate.id, {
            procedure: DRAFT,
            changeReason: '细化步骤',
            createdBy: 'tester',
        });
        const versions = harness.skill.listVersions('project_skillg', seed.candidate.id);
        assert.equal(versions.length, 2);
        assert.equal(created.versionNo, original.versionNo + 1);
        const untouched = versions.find((item) => item.id === original.id);
        assert.ok(untouched);
        assert.equal(untouched.procedure.steps.length, original.procedure.steps.length);
        assert.equal(untouched.changeReason, original.changeReason);
        const candidate = harness.skill.getCandidate('project_skillg', seed.candidate.id);
        assert.equal(candidate?.latestVersionNo, created.versionNo);
    });
    it('10. 审核记录 append-only，且不会静默覆盖', () => {
        const seed = seedPattern(harness, 'project_skillh');
        harness.skill.createVersion('project_skillh', seed.candidate.id, {
            procedure: DRAFT,
            changeReason: '补充成功标准',
            createdBy: 'tester',
        });
        const submitted = harness.skill.submitForReview('project_skillh', seed.candidate.id, {
            reviewer: 'reviewer_1',
            reason: '请审核',
        });
        assert.equal(submitted.candidate.status, 'in_review');
        const reviewed = harness.skill.review({
            scopeId: 'project_skillh',
            versionId: submitted.version.id,
            decision: 'approve',
            reviewer: 'reviewer_1',
            reason: '描述清晰',
        });
        assert.equal(reviewed.candidate.status, 'approved');
        assert.equal(reviewed.version.status, 'approved');
        const reviews = harness.skill.listReviews('project_skillh', seed.candidate.id);
        assert.equal(reviews.length, 2);
        assert.equal(reviews[0].decision, 'submit');
        assert.equal(reviews[1].decision, 'approve');
        // 同一个版本不能再次审核（状态已离开 in_review）。
        assert.throws(() => harness.skill.review({
            scopeId: 'project_skillh',
            versionId: submitted.version.id,
            decision: 'reject',
            reviewer: 'reviewer_2',
            reason: '改主意了',
        }), (error) => error instanceof SkillError);
    });
    it('11. 缺少可审计的审核人身份时禁止审核', () => {
        const seed = seedPattern(harness, 'project_skilli');
        harness.skill.createVersion('project_skilli', seed.candidate.id, {
            procedure: DRAFT,
            changeReason: '补充成功标准',
            createdBy: 'tester',
        });
        assert.throws(() => harness.skill.submitForReview('project_skilli', seed.candidate.id, { reviewer: '   ' }), (error) => error instanceof SkillError);
        const submitted = harness.skill.submitForReview('project_skilli', seed.candidate.id, {
            reviewer: 'reviewer_ok',
            reason: '提交',
        });
        assert.throws(() => harness.skill.review({
            scopeId: 'project_skilli',
            versionId: submitted.version.id,
            decision: 'approve',
            reviewer: '',
            reason: '同意',
        }), (error) => error instanceof SkillError);
    });
    it('12. 批准不会触发任何执行（Phase 1 没有任何执行路径）', () => {
        const serviceLike = harness.skill;
        for (const forbidden of ['execute', 'run', 'invoke', 'apply', 'runSkill', 'autoToolCall', 'policyApply']) {
            assert.equal(typeof serviceLike[forbidden], 'undefined', `不应存在执行入口 ${forbidden}`);
        }
        const seed = seedPattern(harness, 'project_skillj');
        harness.skill.createVersion('project_skillj', seed.candidate.id, {
            procedure: DRAFT,
            changeReason: '补充成功标准',
            createdBy: 'tester',
        });
        const submitted = harness.skill.submitForReview('project_skillj', seed.candidate.id, {
            reviewer: 'reviewer_3',
            reason: '提交',
        });
        const reviewed = harness.skill.review({
            scopeId: 'project_skillj',
            versionId: submitted.version.id,
            decision: 'approve',
            reviewer: 'reviewer_3',
            reason: '同意',
        });
        // 批准只改变状态；成熟度仍然不是 validated（没有真实尝试）。
        assert.equal(reviewed.candidate.status, 'approved');
        const maturity = harness.skill.getMaturity('project_skillj', seed.candidate.id);
        assert.notEqual(maturity.level, 'validated');
    });
    it('13. 重启后候选发现仍幂等（持久化唯一约束）', () => {
        const seed = seedPattern(harness, 'project_skillk');
        const before = harness.skill.listCandidates('project_skillk', { limit: 20 }).length;
        const dbPath = join(directory, 'memory-sea.db');
        harness.db.close();
        harness = openHarness(dbPath);
        const again = harness.skill.ensureCandidateForPattern('project_skillk', seed.patternId);
        assert.equal(again.created, false);
        assert.equal(again.candidate.id, seed.candidate.id);
        assert.equal(harness.skill.listCandidates('project_skillk', { limit: 20 }).length, before);
        assert.equal(harness.skill.listVersions('project_skillk', seed.candidate.id).length, 1);
    });
    it('14. 统计口径：候选状态与尝试数可对账', () => {
        const stats = harness.skill.stats('project_skillh');
        assert.equal(stats.candidates.approved, 1);
        assert.equal(stats.candidates.total >= 1, true);
        assert.ok(stats.attempts.total >= 0);
    });
    it('15. 后台任务：重复入队幂等 + 失败重试保持幂等（不重复建候选）', () => {
        let clock = BASE_TIME;
        const jobs = new JobRepository({ db: harness.db, now: () => clock });
        const seed = seedPattern(harness, 'project_skilll');
        const input = {
            type: 'skill_candidate_discovery',
            ownerType: 'skill_candidate',
            ownerId: seed.candidate.id,
            scopeId: 'project_skilll',
        };
        const first = jobs.enqueue(input);
        assert.ok(first);
        // pending 期间重复入队返回 null：同一个候选不会被排两次。
        assert.equal(jobs.enqueue(input), null);
        const claimed = jobs.claim(clock);
        const target = claimed.find((job) => job.id === first?.id);
        assert.ok(target);
        assert.equal(target.attempts, 1);
        // 第一次执行失败 → 退避等待，不会立刻被再次领取。
        jobs.fail(first.id, 'transient failure', clock, { retryDelayMs: 1000 });
        assert.equal(jobs.claim(clock).filter((job) => job.id === first?.id).length, 0);
        clock += 2000;
        const retried = jobs.claim(clock).find((job) => job.id === first?.id);
        assert.ok(retried);
        assert.equal(retried.attempts, 2);
        jobs.complete(retried.id, clock);
        assert.equal(jobs.claim(clock).filter((job) => job.id === first?.id).length, 0);
        // 重试跑完以后，候选仍然只有一条（任务幂等 → 数据幂等）。
        const candidates = harness.skill.listCandidates('project_skilll', { limit: 20 });
        assert.equal(candidates.filter((item) => item.sourcePatternId === seed.patternId).length, 1);
    });
    it('16. 后台任务：僵死回收后可以继续消费（重启恢复语义）', () => {
        let clock = BASE_TIME + 60 * MINUTE;
        const jobs = new JobRepository({ db: harness.db, now: () => clock });
        const seed = seedPattern(harness, 'project_skillm');
        const job = jobs.enqueue({
            type: 'skill_candidate_reevaluate',
            ownerType: 'skill_candidate',
            ownerId: seed.candidate.id,
            scopeId: 'project_skillm',
        });
        assert.ok(job);
        const claimed = jobs.claim(clock).find((item) => item.id === job?.id);
        assert.ok(claimed);
        // 进程在 running 状态崩溃：超过 stale 时间后回收，任务回到 pending 并可再次被领取。
        clock += 10 * MINUTE;
        const reclaimed = jobs.reclaimStale(clock, 5 * MINUTE);
        assert.ok(reclaimed >= 1);
        const again = jobs.claim(clock).find((item) => item.id === job?.id);
        assert.ok(again);
        assert.equal(again.status, 'running');
        jobs.complete(again.id, clock);
        assert.equal(jobs.claim(clock).filter((item) => item.id === job?.id).length, 0);
    });
});
