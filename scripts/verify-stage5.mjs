#!/usr/bin/env node
/**
 * verify-stage5.mjs —— Stage 5 Phase 1 的端到端取证脚本。
 *
 * 用真实 SQLite + 真实 Repository + 真实 SkillService 走一遍：
 *   候选生成 → 结构成熟度 → 版本化 → 真实 Attempt → 审核 → 重新评估。
 *
 * 明确不做的事：不执行任何「流程」、不调用工具、不产生副作用 —— Phase 1 本来就没有执行路径。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const BASE = Date.UTC(2026, 9, 30, 9, 0, 0)
const MINUTE = 60_000
const NOW = () => BASE
const SCOPE = 'project_stage5verify'
const DRAFT = {
  steps: [
    { stepNo: 1, action: '先确认本地已有方案是否够用', evidenceRefs: [{ type: 'memory', id: 'PLACEHOLDER_1' }] },
    { stepNo: 2, action: '规模证明确有必要后再引入新服务', evidenceRefs: [{ type: 'memory', id: 'PLACEHOLDER_2' }] },
  ],
  triggers: [{ id: 't1', description: '准备引入新基础设施时' }],
  preconditions: [{ id: 'p1', description: '同一个项目上下文', required: true }],
  expectedOutcomes: [{ id: 'o1', description: '避免过早复杂化' }],
  exceptions: [],
  limitations: ['只适用于早期阶段'],
  successCriteria: [{ id: 'c1', description: '需求被满足且没有引入额外服务' }],
}

const directory = mkdtempSync(join(tmpdir(), 'memory-sea-stage5-verify-'))
const dbPath = join(directory, 'memory-sea.db')
const db = MemoryDatabase.open(dbPath)
const episodes = new EpisodeRepository({ db })
const experiences = new ExperienceRepository({ db })
const memories = new MemoryRepository({ db, now: NOW })
const evidence = new EvidenceRepository({ db, now: NOW })
const patterns = new PatternRepository({ db, now: NOW })
const patternEvidence = new PatternEvidenceRepository({ db, now: NOW })
const candidates = new SkillCandidateRepository({ db, now: NOW })
const attempts = new SkillAttemptRepository({ db, now: NOW })
const skill = new SkillService({
  candidates,
  attempts,
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
    minValidatedAttempts: 2,
    minStepCoverage: 0.6,
    minConfidence: 0.5,
    allowWeakenedPatterns: true,
  },
  now: NOW,
})

function section(title) {
  process.stdout.write(`\n== ${title} ==\n`)
}

function line(text) {
  process.stdout.write(`  ${text}\n`)
}

try {
  // A. 用真实仓库造三条独立证据（三个 Episode、三条派生 Memory、一个 active Pattern）
  const memoryIds = []
  for (let index = 0; index < 3; index += 1) {
    const episodeId = `ep_v5_${index}`
    const experienceId = `xp_v5_${index}`
    experiences.insert(
      {
        id: experienceId,
        sourceType: 'chat',
        content: `第 ${index + 1} 次决定先保证本地可跑。`,
        createdAt: BASE,
        observedAt: BASE + index * MINUTE,
        importance: 0.6,
        metadata: { actorId: 'act_verify' },
        embeddingStatus: 'disabled',
      },
      SCOPE,
    )
    episodes.insertWithSession(
      {
        id: episodeId,
        startedAt: BASE + index * 60 * MINUTE,
        endedAt: BASE + index * 60 * MINUTE + 5 * MINUTE,
        experienceIds: [experienceId],
        participants: [],
        locations: [],
        topics: ['架构'],
        importance: 0.6,
        salience: 0.5,
        confidence: 0.6,
        status: 'closed',
        createdAt: BASE + index * MINUTE,
        updatedAt: BASE + index * MINUTE,
        embeddingStatus: 'disabled',
        summaryStatus: 'ready',
        consolidationStatus: 'ready',
        continuityStatus: 'ready',
        lastExperienceAt: BASE + index * MINUTE,
      },
      SCOPE,
      `sess_v5_${index}`,
    )
    const memory = memories.create({
      scopeId: SCOPE,
      kind: 'decision',
      content: `第 ${index + 1} 条：决定先保证本地可跑，不引入额外服务。`,
      confidence: 0.7,
      importance: 0.6,
    })
    evidence.insert({ memoryId: memory.id, evidenceType: 'episode', evidenceId: episodeId, relation: 'derived_from' })
    memoryIds.push(memory.id)
  }
  const pattern = patterns.create({
    scopeId: SCOPE,
    kind: 'recurring_decision',
    content: '这个项目在早期架构决策里持续倾向避免引入额外基础设施。',
    confidence: 0.72,
    importance: 0.6,
    status: 'active',
    supportCount: 3,
    firstObservedAt: BASE,
    lastObservedAt: BASE + 120 * MINUTE,
  })
  patternEvidence.insertMany(pattern.id, memoryIds, 'supports')
  section('A. 证据基座')
  line(`Pattern ${pattern.id}（active，supportCount=${pattern.supportCount}）`)
  line(`支持 Memory：${memoryIds.length} 条，各自来自独立 Episode`)

  // B. 候选生成（幂等）
  const first = skill.ensureCandidateForPattern(SCOPE, pattern.id)
  const second = skill.ensureCandidateForPattern(SCOPE, pattern.id)
  section('B. 候选生成')
  line(`首次 created=${first.created}，再次 created=${second.created}（同一 id=${first.candidate.id === second.candidate.id}）`)
  line(`候选状态=${first.candidate.status}，版本数=${skill.listVersions(SCOPE, first.candidate.id).length}`)
  const v1 = skill.listVersions(SCOPE, first.candidate.id)[0]
  line(`v1 步骤=${v1.procedure.steps.length}，成功标准=${v1.procedure.successCriteria.length}（由 Pattern 推导，尚未被人工确认）`)
  line(`v1 成熟度=${skill.getMaturity(SCOPE, first.candidate.id).level}`)

  // C. 人工补充成功标准 → v2
  const draftWithRefs = {
    ...DRAFT,
    steps: [
      { ...DRAFT.steps[0], evidenceRefs: [{ type: 'memory', id: memoryIds[0] }] },
      { ...DRAFT.steps[1], evidenceRefs: [{ type: 'memory', id: memoryIds[1] }] },
    ],
  }
  const v2 = skill.createVersion(SCOPE, first.candidate.id, {
    procedure: draftWithRefs,
    changeReason: '人工补充成功标准与证据引用',
    createdBy: 'verify-script',
  })
  section('C. 版本化')
  const versions = skill.listVersions(SCOPE, first.candidate.id)
  line(`版本数=${versions.length}，最新 v${v2.versionNo}，旧版本 v1 仍保留（步骤数=${v1.procedure.steps.length}）`)
  line(`最新版本成功标准=${v2.procedure.successCriteria.length} 条`)

  // D. Attempt 1：user_reported 成功 → 成熟度从 structural_only 升级
  const a1 = skill.recordAttempt({
    scopeId: SCOPE,
    versionId: v2.id,
    externalKey: 'verify-attempt-1',
    attribution: 'user_reported',
  })
  skill.completeAttempt({
    scopeId: SCOPE,
    attemptId: a1.attempt.id,
    result: 'success',
    attribution: 'user_reported',
    evidence: [{ evidenceType: 'manual', evidenceId: 'note_1', relation: 'supports' }],
  })
  section('D. 第一次真实尝试')
  let maturity = skill.getMaturity(SCOPE, first.candidate.id)
  line(`attempts total=${maturity.attempts.total} verified=${maturity.attempts.verified}`)
  line(`成熟度=${maturity.level}，missing=${JSON.stringify(maturity.missing)}`)
  line(`成功率可报告=${maturity.effectiveness?.reportable} sample=${maturity.effectiveness?.sampleSize}`)

  // E. 继续补独立成功尝试：两次成功不足以证明，Phase 2 要求独立已验证样本 >= 5。
  section('E. 第二至第五次真实尝试（独立样本门槛）')
  for (let index = 2; index <= 5; index += 1) {
    const attempt = skill.recordAttempt({
      scopeId: SCOPE,
      versionId: v2.id,
      externalKey: `verify-attempt-${index}`,
      attribution: 'direct',
    })
    skill.completeAttempt({
      scopeId: SCOPE,
      attemptId: attempt.attempt.id,
      result: 'success',
      attribution: 'direct',
      evidence: [{ evidenceType: 'manual', evidenceId: `note_${index}`, relation: 'supports' }],
    })
  }
  maturity = skill.getMaturity(SCOPE, first.candidate.id)
  line(`attempts total=${maturity.attempts.total} verified=${maturity.attempts.verified} independent=${maturity.attempts.independentVerified}`)
  line(`成熟度=${maturity.level}，missing=${JSON.stringify(maturity.missing)}`)
  line(`成功率=${maturity.effectiveness?.successRate}（n=${maturity.effectiveness?.sampleSize}，95% CI=${JSON.stringify(maturity.effectiveness?.ci95)}，报告可读=${maturity.effectiveness?.reportable}）`)

  // F. 审核：提交 → 批准（只改状态，不执行任何流程）
  const submitted = skill.submitForReview(SCOPE, first.candidate.id, {
    reviewer: 'verify-reviewer',
    reason: '描述与证据链完整，申请审核',
  })
  const reviewed = skill.review({
    scopeId: SCOPE,
    versionId: submitted.version.id,
    decision: 'approve',
    reviewer: 'verify-reviewer',
    reason: '证据链与成功标准都可核对，接受描述',
  })
  section('F. 审核状态机')
  line(`提交后候选状态=${submitted.candidate.status}，批准后=${reviewed.candidate.status}，版本=${reviewed.version.status}`)
  line(`审核记录=${skill.listReviews(SCOPE, first.candidate.id).map((item) => item.decision).join(' → ')}（append-only）`)
  const afterApproval = skill.getMaturity(SCOPE, first.candidate.id)
  line(`批准后成熟度=${afterApproval.level}（由真实尝试决定；批准本身不产生验证）`)

  // G. 回归检查：Scope 隔离 + 无执行入口
  let scopeRejected = false
  try {
    skill.recordAttempt({ scopeId: 'project_other', versionId: v2.id, externalKey: 'verify-scope-mismatch' })
  } catch {
    scopeRejected = true
  }
  section('G. 安全边界')
  line(`跨 Scope 写入被拒绝=${scopeRejected}`)
  line(`SkillService 上不存在 execute/run/invoke/apply 入口=${['execute', 'run', 'invoke', 'apply'].every((key) => typeof skill[key] === 'undefined')}`)

  // H. 统计
  section('H. 对账')
  const stats = skill.stats(SCOPE)
  line(`候选：${JSON.stringify(stats.candidates)}`)
  line(`尝试：${JSON.stringify(stats.attempts)}`)
  line(`审核记录：${skill.listReviews(SCOPE, first.candidate.id).length} 条（append-only，不可改写）`)

  // I. 性能：这些都走后台 / 只读查询，绝不能拖慢 Capture 快路径
  section('I. 耗时（本机，Windows）')
  const rounds = 50
  const timeIt = (fn) => {
    const started = process.hrtime.bigint()
    for (let index = 0; index < rounds; index += 1) fn()
    return Number(process.hrtime.bigint() - started) / 1e6 / rounds
  }
  line(`ensureCandidateForPattern（幂等命中）：${timeIt(() => skill.ensureCandidateForPattern(SCOPE, pattern.id)).toFixed(3)} ms/次`)
  line(`evaluateMaturity：${timeIt(() => skill.getMaturity(SCOPE, first.candidate.id)).toFixed(3)} ms/次`)
  line(`listCandidates：${timeIt(() => skill.listCandidates(SCOPE, { limit: 20 })).toFixed(3)} ms/次`)
  line('（Capture 快路径没有接入任何 Skill 逻辑：候选生成只走后台 Job）')
} finally {
  try {
    db.close()
  } catch {
    // ignore
  }
  rmSync(directory, { recursive: true, force: true })
}

process.stdout.write('\nVERIFY STAGE 5 DONE\n')
