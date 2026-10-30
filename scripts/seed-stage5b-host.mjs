/**
 * seed-stage5b-host.mjs —— 为「真实宿主审核路径」准备一个可审核的候选（一次性脚本，可重复执行）。
 *
 * 为什么需要它：Phase 1/2 都**没有**把 Attempt 记录暴露成 HTTP 写接口（这是有意的，
 * 审核入口只做审核，不做执行/记录注入）。所以真实的尝试数据由本脚本用真实
 * Repository + SkillService 直接写入宿主数据库，然后审核动作全部走宿主的
 * HTTP 操作者路由（带令牌）完成。
 *
 * 输出：SCOPE_ID / CANDIDATE_ID / VERSION_ID，供 curl 使用。
 */

import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { MemoryDatabase } from '../dist/src/storage/database.js'
import { ExperienceRepository } from '../dist/src/storage/repositories/experience-repository.js'
import { EpisodeRepository } from '../dist/src/storage/repositories/episode-repository.js'
import { MemoryRepository } from '../dist/src/memory/memory-repository.js'
import { EvidenceRepository } from '../dist/src/memory/evidence-repository.js'
import { PatternRepository } from '../dist/src/pattern/pattern-repository.js'
import { PatternEvidenceRepository } from '../dist/src/pattern/pattern-evidence-repository.js'
import { SkillCandidateRepository } from '../dist/src/skill/candidate-repository.js'
import { SkillAttemptRepository } from '../dist/src/skill/attempt-repository.js'
import { SkillService } from '../dist/src/skill/skill-service.js'

const SCOPE = 'project_p2host'
const NOW = Date.now()
const TAG = String(NOW)  // 唯一后缀：重复运行生成新一批证据，不覆盖历史
const MINUTE = 60 * 1000
const databasePath =
  process.env.MEMORY_SEA_DB ??
  resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), '3d-memory-sea', 'memory-sea.db')

const db = MemoryDatabase.open(databasePath)
const experiences = new ExperienceRepository({ db })
const episodes = new EpisodeRepository({ db })
const memories = new MemoryRepository({ db, now: () => NOW })
const evidence = new EvidenceRepository({ db, now: () => NOW })
const patterns = new PatternRepository({ db, now: () => NOW })
const patternEvidence = new PatternEvidenceRepository({ db, now: () => NOW })
const skill = new SkillService({
  candidates: new SkillCandidateRepository({ db, now: () => NOW }),
  attempts: new SkillAttemptRepository({ db, now: () => NOW }),
  patterns,
  patternEvidence,
  memories,
  evidence,
  episodes,
  experiences,
  settings: {
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
    minConfidence: 0.5,
    allowWeakenedPatterns: true,
  },
  now: () => NOW,
})

// 1) 证据基座：5 个独立 Episode + 5 条 Memory + 1 个 active Pattern
const episodeIds = []
const memoryIds = []
for (let index = 0; index < 5; index += 1) {
  const episodeId = `ep_p2host_${TAG}_${index}`
  const experienceId = `xp_p2host_${TAG}_${index}`
  const startedAt = NOW - (3 - index) * 60 * MINUTE
  experiences.insert(
    {
      id: experienceId,
      sourceType: 'chat',
      content: `第 ${index + 1} 次：决定先保持本地可跑，不引入额外服务。`,
      createdAt: startedAt,
      observedAt: startedAt,
      importance: 0.6,
      metadata: {},
      embeddingStatus: 'disabled',
    },
    SCOPE,
  )
  episodes.insertWithSession(
    {
      id: episodeId,
      startedAt,
      endedAt: startedAt + 5 * MINUTE,
      experienceIds: [experienceId],
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
    },
    SCOPE,
    `sess_p2host_${TAG}_${index}`,
  )
  const memory = memories.create({
    scopeId: SCOPE,
    kind: 'decision',
    content: `第 ${index + 1} 条：早期决策优先保持本地可跑，不引入额外服务。`,
    confidence: 0.7,
    importance: 0.6,
  })
  evidence.insert({ memoryId: memory.id, evidenceType: 'episode', evidenceId: episodeId, relation: 'derived_from' })
  memoryIds.push(memory.id)
  episodeIds.push(episodeId)
}

// 每次运行都新建 Pattern：唯一索引是 (scope, source_pattern_id)，重复运行不会复用旧候选。
const pattern =
  patterns.create({
    scopeId: SCOPE,
    kind: 'recurring_decision',
    content: `该项目在早期架构决策里持续倾向避免过早引入额外基础设施（人工取证样本 ${NOW}）。`,
    confidence: 0.75,
    importance: 0.65,
    status: 'active',
    supportCount: memoryIds.length,
    firstObservedAt: NOW - 5 * 60 * MINUTE,
    lastObservedAt: NOW,
  })
patternEvidence.insertMany(pattern.id, memoryIds, 'supports')

const ensured = skill.ensureCandidateForPattern(SCOPE, pattern.id)
const candidate = ensured.candidate

// 2) v2：人工补充成功标准（可审核的必要条件之一）
const version = skill.createVersion(SCOPE, candidate.id, {
  procedure: {
    steps: [
      { stepNo: 1, action: '先确认是否已有本地可用方案', evidenceRefs: [{ type: 'memory', id: memoryIds[0] }] },
      { stepNo: 2, action: '只有在规模证明需要后才引入新服务', evidenceRefs: [{ type: 'memory', id: memoryIds[1] }] },
    ],
    triggers: [{ id: 't1', description: '准备引入新基础设施时' }],
    preconditions: [{ id: 'p1', description: '同一项目上下文', required: true }],
    expectedOutcomes: [{ id: 'o1', description: '避免过早复杂化' }],
    exceptions: [],
    limitations: ['仅适用于早期阶段'],
    successCriteria: [
      { id: 'c1', description: '没有引入额外服务且需求仍被满足', source: 'manual' },
    ],
  },
  changeReason: '人工补充可核对的成功标准',
  createdBy: 'host-verification-script',
})

// 3) 5 次独立成功尝试（每次都带新的 Episode 证据）
for (let index = 0; index < 5; index += 1) {
  const attempt = skill.recordAttempt({
    scopeId: SCOPE,
    versionId: version.id,
    externalKey: `p2host-${TAG}-attempt-${index}`,
    attribution: index === 0 ? 'user_reported' : 'direct',
  })
  skill.completeAttempt({
    scopeId: SCOPE,
    attemptId: attempt.attempt.id,
    result: 'success',
    attribution: index === 0 ? 'user_reported' : 'direct',
    evidence: [
      { evidenceType: 'episode', evidenceId: episodeIds[index], relation: 'supports' },
    ],
  })
}

const maturity = skill.getMaturity(SCOPE, candidate.id)
console.log(`SCOPE_ID=${SCOPE}`)
console.log(`CANDIDATE_ID=${candidate.id}`)
console.log(`VERSION_ID=${version.id}`)
console.log(`CANDIDATE_STATUS=${candidate.status}`)
console.log(`MATURITY=${maturity.level}`)
console.log(`MISSING=${JSON.stringify(maturity.missing)}`)
console.log(`ATTEMPTS=${maturity.attempts.total} verified=${maturity.attempts.verified} independent=${maturity.attempts.independentVerified}`)
console.log(`SUCCESS_RATE=${maturity.effectiveness?.successRate} n=${maturity.effectiveness?.sampleSize}`)
db.close()
