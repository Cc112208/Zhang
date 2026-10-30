/**
 * evidence-independence.ts —— 独立证据计数与成熟度评估（纯函数，不碰数据库）。
 *
 * 这个文件是 Stage 5 的「反自欺」核心，规则来自 Phase 0 设计（§5–§7）：
 *   1. 先按 (scope, 原始证据 id) 去重；
 *   2. 同一 Episode 的多条 Experience 折叠成 1 个独立 Episode 单位；
 *   3. 同一 Episode 派生的多条 Memory 不重复贡献独立 Episode；
 *   4. reinforcement 次数只算强度，不算样本；
 *   5. 同一 Attempt 的多条结果证据只算 1 次执行；
 *   6. inferred 结果不进已验证分子/分母；
 *   7. unknown / inconclusive / aborted 不进成功率分母；
 *   8. 没有预先定义的成功标准时，不输出成功率。
 *
 * 这里没有 I/O、没有时间依赖（now 由调用方传入），因此可以直接单测。
 */

import type {
  SkillAttempt,
  SkillAttemptStats,
  SkillCandidateMaturity,
  SkillEvidenceSnapshot,
  SkillIndependentEvidence,
  SkillMaturityLevel,
  SkillMaturityMissing,
  SkillOutcomeEvidence,
  SkillVersionStatus,
  SuccessCriterion,
  ProcedureDraft,
} from '../types.js'
import { applyAttemptStats, countIndependentAttempts, summarizeEffectiveness } from './statistics.js'

/** 证据引用：原始证据 id + 可选的上层归属（用于折叠）。 */
export interface EvidenceRef {
  type: 'experience' | 'episode' | 'memory' | 'manual'
  id: string
  /** experience 所属 Episode；同一 Episode 的经历会被折叠。 */
  episodeId?: string
  /**
   * memory 的来源 Episode 列表（来自 memory_evidence）。
   * 同一条 Memory 可以来自多个 Episode，这些 Episode 都要计入。
   */
  sourceEpisodeIds?: readonly string[]
}

export interface MaturityPolicy {
  minIndependentEpisodes: number
  /**
   * 进入 validated 需要的**独立**已验证尝试数（不是原始尝试数）。
   * Phase 2A 起默认 5：两次成功不再是证明。
   */
  minValidatedAttempts: number
  /** validated 至少需要多少次归因为 direct（直接观察）的已验证尝试。 */
  minDirectAttempts: number
  /** 步骤有证据的比例门槛。 */
  minStepCoverage: number
  /** 可选：要求至少一次成功才算 validated（默认 true）。 */
  requireSuccess?: boolean
  /** validated 的最低成功率（0..1，默认 0.5；样本不足时仍受独立样本门槛约束）。 */
  minSuccessRateForValidated: number
  /** 报告成功率所需的最小样本量（低于它标记 smallSample）。 */
  minReportableSamples: number
  /** Wilson 区间的 z 值（默认 1.96 = 95%）。 */
  wilsonZ: number
}

export const DEFAULT_MATURITY_POLICY: MaturityPolicy = {
  minIndependentEpisodes: 2,
  minValidatedAttempts: 5,
  minDirectAttempts: 1,
  minStepCoverage: 0.5,
  requireSuccess: true,
  minSuccessRateForValidated: 0.5,
  minReportableSamples: 5,
  wilsonZ: 1.96,
}

export function evidenceKey(scopeId: string, type: string, id: string): string {
  return `${scopeId}|${type}|${id}`
}

/**
 * 去重并折叠：返回独立单位集合。
 *
 * 折叠规则（从强到弱）：
 *   - experience 有 episodeId → 单位 = `ep:${episodeId}`（同 Episode 只算一个）
 *   - memory 有来源 Episode → 单位 = 这些 `ep:*`（Memory 自身不再额外算一个 Episode）
 *   - 其余 → `类型:${id}`
 */
export function foldEvidence(
  scopeId: string,
  refs: readonly EvidenceRef[],
): {
  evidence: SkillIndependentEvidence
  experienceIds: Set<string>
  episodeIds: Set<string>
  memoryIds: Set<string>
} {
  const units = new Set<string>()
  const experienceIds = new Set<string>()
  const episodeIds = new Set<string>()
  const memoryIds = new Set<string>()
  let raw = 0

  for (const ref of refs) {
    if (!ref || typeof ref.id !== 'string' || ref.id.length === 0) continue
    raw += 1
    if (ref.type === 'experience') {
      experienceIds.add(ref.id)
      units.add(ref.episodeId ? `${scopeId}|ep:${ref.episodeId}` : `${scopeId}|exp:${ref.id}`)
      if (ref.episodeId) episodeIds.add(ref.episodeId)
      continue
    }
    if (ref.type === 'episode') {
      episodeIds.add(ref.id)
      units.add(`${scopeId}|ep:${ref.id}`)
      continue
    }
    if (ref.type === 'memory') {
      memoryIds.add(ref.id)
      const episodes = ref.sourceEpisodeIds ?? []
      if (episodes.length > 0) {
        for (const episodeId of episodes) {
          episodeIds.add(episodeId)
          units.add(`${scopeId}|ep:${episodeId}`)
        }
      } else {
        // 没有 Episode 来源的 Memory 只能算「一条知识」，不能冒充一次经历。
        units.add(`${scopeId}|mem:${ref.id}`)
      }
      continue
    }
    units.add(`${scopeId}|manual:${ref.id}`)
  }

  return {
    evidence: {
      independentUnits: units.size,
      independentEpisodes: episodeIds.size,
      independentExperiences: experienceIds.size,
      independentMemories: memoryIds.size,
      rawRefs: raw,
      duplicatesRemoved: Math.max(0, raw - units.size),
    },
    experienceIds,
    episodeIds,
    memoryIds,
  }
}

const VERIFIED_RESULTS = new Set(['success', 'partial_success', 'failure'])

/** Attempt 统计：只有 direct / user_reported 且结果可判定的尝试才算 verified。 */
export function evaluateAttempts(
  attempts: readonly SkillAttempt[],
  outcomes: ReadonlyMap<string, readonly SkillOutcomeEvidence[]>,
  episodeIdsByAttempt?: ReadonlyMap<string, readonly string[]>,
): SkillAttemptStats {
  const stats: SkillAttemptStats = {
    total: 0,
    completed: 0,
    aborted: 0,
    success: 0,
    partialSuccess: 0,
    failure: 0,
    unknown: 0,
    inconclusive: 0,
    inferred: 0,
    verified: 0,
    directVerified: 0,
    userReportedVerified: 0,
    independentVerified: 0,
    episodesCovered: 0,
  }
  const seenAttempts = new Set<string>()

  for (const attempt of attempts) {
    if (seenAttempts.has(attempt.id)) continue
    seenAttempts.add(attempt.id)
    stats.total += 1
    if (attempt.status === 'aborted') {
      stats.aborted += 1
      continue
    }
    if (attempt.status !== 'completed') continue
    stats.completed += 1

    // 同一 Attempt 内有多条证据也只算一次执行；证据只用于归因强度。
    const rows = outcomes.get(attempt.id) ?? []
    const inferredOnly =
      attempt.attribution === 'inferred' ||
      (attempt.attribution === 'none' && rows.length > 0 && rows.every((row) => row.attribution === 'inferred'))
    if (inferredOnly) {
      // 推断结果可以用于提示「可能有效」，但不能进已验证统计。
      stats.inferred += 1
      continue
    }
    if (attempt.attribution !== 'direct' && attempt.attribution !== 'user_reported') {
      stats.inferred += 1
      continue
    }

    const result = attempt.result
    if (!result || !VERIFIED_RESULTS.has(result)) {
      // unknown / inconclusive：不进分母，但保留计数。
      if (result === 'unknown') stats.unknown += 1
      else if (result === 'inconclusive') stats.inconclusive += 1
      else stats.unknown += 1
      continue
    }
    stats.verified += 1
    if (result === 'success') stats.success += 1
    else if (result === 'partial_success') stats.partialSuccess += 1
    else stats.failure += 1
  }

  // 独立样本口径与原始计数分开：verified 是「可判定」，independentVerified 才是「可证明」。
  return applyAttemptStats(stats, countIndependentAttempts(attempts, outcomes, episodeIdsByAttempt))
}

export interface MaturityInput {
  candidateId: string
  scopeId: string
  versionStatus: SkillVersionStatus
  procedure: ProcedureDraft
  evidenceSnapshot: SkillEvidenceSnapshot | EvidenceRef[]
  attempts: readonly SkillAttempt[]
  outcomes: ReadonlyMap<string, readonly SkillOutcomeEvidence[]>
  /** Pattern 当前是否 weakened（有关键矛盾）。 */
  patternWeakened?: boolean
  /**
   * 尝试 → 证据单位（Episode id 优先）的解析结果，由 Service 提供。
   * 用于判定「同一次执行 / 同一 Episode 的重复报告」是否重复计数。
   */
  episodeIdsByAttempt?: ReadonlyMap<string, readonly string[]>
  policy?: Partial<MaturityPolicy>
  now: number
}

/**
 * 成熟度评估。必须是派生结果：调用方每次重新算，不缓存权威计数。
 *
 * 等级判定顺序（命中即返回，不越级）：
 *   insufficient → structural_only → observed → validated
 */
export function assessMaturity(input: MaturityInput): SkillCandidateMaturity {
  const policy: MaturityPolicy = { ...DEFAULT_MATURITY_POLICY, ...(input.policy ?? {}) }
  const procedure = input.procedure
  const steps = Array.isArray(procedure?.steps) ? procedure.steps : []
  const criteria: SuccessCriterion[] = Array.isArray(procedure?.successCriteria) ? procedure.successCriteria : []
  const refs = snapshotToRefs(input.evidenceSnapshot)
  const folded = foldEvidence(input.scopeId, refs)
  const evidence = folded.evidence
  const attempts = evaluateAttempts(input.attempts, input.outcomes, input.episodeIdsByAttempt)

  const stepsWithEvidence = steps.filter((step) => Array.isArray(step?.evidenceRefs) && step.evidenceRefs.length > 0)
  const stepCoverage = steps.length === 0 ? 0 : round4(stepsWithEvidence.length / steps.length)
  const successCriteriaDefined = criteria.length > 0

  const missing: SkillMaturityMissing[] = []
  const reasons: string[] = []
  const contradictions: string[] = []

  for (const outcome of flattenOutcomes(input.outcomes)) {
    if (outcome.relation === 'contradicts') {
      contradictions.push(`${outcome.evidenceType}:${outcome.evidenceId}`)
    }
  }

  if (steps.length === 0) missing.push('no_steps')
  else if (stepCoverage < policy.minStepCoverage) missing.push('step_coverage_below_half')
  if (steps.length > 0 && stepsWithEvidence.length < steps.length) missing.push('step_without_evidence')
  if (!successCriteriaDefined) missing.push('no_success_criteria')
  if (attempts.total === 0) missing.push('no_attempts')
  else if (attempts.verified === 0) missing.push('insufficient_verified_samples')
  else if (attempts.independentVerified < policy.minValidatedAttempts) missing.push('insufficient_independent_attempts')
  if (attempts.verified > 0 && attempts.directVerified < policy.minDirectAttempts) missing.push('insufficient_direct_attempts')
  if (attempts.verified > 0 && attempts.userReportedVerified > 0 && attempts.directVerified === 0) {
    missing.push('user_reported_only')
  }
  if (evidence.independentEpisodes < policy.minIndependentEpisodes) missing.push('insufficient_independent_episodes')
  if (attempts.verified === 0 && attempts.inferred > 0) missing.push('inferred_attempts_only')
  if (contradictions.length > 0) missing.push('unresolved_contradictions')
  if (input.patternWeakened) missing.push('pattern_weakened_contradictions')

  const baseReasons: string[] = [
    `独立证据 ${evidence.independentUnits} 个单位（experience ${evidence.independentExperiences} / episode ${evidence.independentEpisodes} / memory ${evidence.independentMemories}），原始引用 ${evidence.rawRefs} 条`,
    `步骤覆盖 ${Math.round(stepCoverage * 100)}%（${stepsWithEvidence.length}/${steps.length} 步有证据）`,
    `Attempt 共 ${attempts.total} 次，已验证 ${attempts.verified} 次（独立 ${attempts.independentVerified} 次，直接观察 ${attempts.directVerified} 次，用户报告 ${attempts.userReportedVerified} 次），已推断 ${attempts.inferred} 次`,
  ]
  reasons.push(...baseReasons)

  const effectiveness = summarizeEffectiveness({
    successes: attempts.success,
    sampleSize: attempts.verified,
    independentSampleSize: attempts.independentVerified,
    successCriteriaDefined,
    minReportableSamples: policy.minReportableSamples,
    wilsonZ: policy.wilsonZ,
  })

  const rate = effectiveness.successRate ?? 0
  if (effectiveness.ci95) {
    reasons.push(
      `成功率 ${(rate * 100).toFixed(1)}%（n=${effectiveness.sampleSize}，Wilson 95% CI ${(effectiveness.ci95.low * 100).toFixed(1)}%–${(effectiveness.ci95.high * 100).toFixed(1)}%）`,
    )
  } else {
    reasons.push('尚无可用成功率（缺成功标准或分母为 0）')
  }
  if (effectiveness.smallSample) reasons.push('样本量偏小：区间很宽，不能据此宣称有效')
  if (contradictions.length > 0) {
    reasons.push(`存在 ${contradictions.length} 条反例证据：可信度下调，需人工复核后再判定`)
  }

  // Phase 2A：validated 的门槛从「任意 2 次成功」升级为
  // 「独立已验证尝试 ≥ N + 至少 1 次直接观察 + 成功率不低于下限」。
  const validatedReady =
    successCriteriaDefined &&
    attempts.independentVerified >= policy.minValidatedAttempts &&
    attempts.directVerified >= policy.minDirectAttempts &&
    (!policy.requireSuccess || attempts.success > 0) &&
    rate >= policy.minSuccessRateForValidated &&
    contradictions.length === 0 &&
    !input.patternWeakened

  if (successCriteriaDefined && attempts.verified > 0 && rate < policy.minSuccessRateForValidated) {
    missing.push('low_success_rate')
  }

  let level: SkillMaturityLevel
  if (steps.length === 0 || stepCoverage < policy.minStepCoverage || stepsWithEvidence.length < steps.length) {
    level = 'insufficient'
    reasons.push('步骤不足以形成可描述流程：不编造 Procedure，只能作为探索性候选')
  } else if (attempts.verified === 0) {
    level = 'structural_only'
    reasons.push('有结构证据，但没有可信执行证据（无已验证 Attempt）')
  } else if (validatedReady) {
    level = 'validated'
    reasons.push(
      `满足验证门槛：独立已验证尝试 ${attempts.independentVerified}/${policy.minValidatedAttempts}，直接观察 ${attempts.directVerified} 次，预定义成功标准 ${criteria.length} 条`,
    )
  } else {
    level = 'observed'
    reasons.push('观察到执行证据，但尚未满足 validated 门槛（独立样本、直接证据、成功率或反例未满足）')
  }

  return {
    candidateId: input.candidateId,
    level,
    evidence,
    attempts,
    stepCoverage,
    successCriteriaDefined,
    missing: unique(missing),
    reasons,
    contradictions,
    ...(effectiveness ? { effectiveness } : {}),
    evaluatedAt: input.now,
  }
}

/**
 * Unknown is not failure：只有预定义标准 + 非零可信分母时才输出成功率。
 */
export function computeEffectiveness(
  stats: SkillAttemptStats,
  successCriteriaDefined: boolean,
): { reportable: boolean; sampleSize: number; successes: number; successRate?: number; note?: string } {
  const denominator = stats.verified
  if (!successCriteriaDefined) {
    return { reportable: false, sampleSize: 0, successes: 0, note: '没有预先定义的成功标准，不输出成功率' }
  }
  if (denominator === 0) {
    return { reportable: false, sampleSize: 0, successes: 0, note: '没有可判定的已验证尝试，分母为 0' }
  }
  return {
    reportable: true,
    sampleSize: denominator,
    successes: stats.success,
    successRate: round4(stats.success / denominator),
    note: `分母只含已验证尝试；unknown/inconclusive/aborted/inferred 均不计入`,
  }
}

function snapshotToRefs(snapshot: SkillEvidenceSnapshot | EvidenceRef[]): EvidenceRef[] {
  if (Array.isArray(snapshot)) return snapshot
  const refs: EvidenceRef[] = []
  for (const id of snapshot?.experienceIds ?? []) refs.push({ type: 'experience', id })
  for (const id of snapshot?.episodeIds ?? []) refs.push({ type: 'episode', id })
  for (const id of snapshot?.memoryIds ?? []) refs.push({ type: 'memory', id, sourceEpisodeIds: snapshot?.episodeIds ?? [] })
  return refs
}

function flattenOutcomes(map: ReadonlyMap<string, readonly SkillOutcomeEvidence[]>): SkillOutcomeEvidence[] {
  const all: SkillOutcomeEvidence[] = []
  const seen = new Set<string>()
  for (const rows of map.values()) {
    for (const row of rows) {
      const key = `${row.attemptId}|${row.evidenceType}|${row.evidenceId}|${row.relation}`
      if (seen.has(key)) continue
      seen.add(key)
      all.push(row)
    }
  }
  return all
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function round4(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 10_000) / 10_000
}
