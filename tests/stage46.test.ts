/**
 * tests/stage46.test.ts —— Stage 4.6：摘要质量 + Actor 身份连续性。
 *
 * 两类不变量：
 *   A. 摘要（EpisodeSummary Quality）
 *      - 机器输出（JSON / 代码 / 堆栈 / 路径 / 日志）不进摘要与标题；
 *      - 人写的决定/目标优先保留，中英技术词不算「机器内容」；
 *      - 只有机器输出时明确回退（summary 为空 + 低信息标题 + quality=poor）；
 *      - 质量评估可重复、同输入稳定。
 *   B. 身份（Actor Identity Continuity）
 *      - actorId 跨 Session 稳定、昵称不参与身份、同名不同人不会被合并；
 *      - 没有可靠 ID 时标记为未知，不猜；
 *      - 身份规范化幂等、不改 Experience 原文与 Episode 证据；
 *      - 连续性仍然遵守 scope 隔离，且不因为同 actor 就连接无关话题。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Episode, Experience } from '../src/types.js'
import type { MemorySeaConfig } from '../src/config.js'
import { ExtractiveSummarizer } from '../src/summary/extractive-summarizer.js'
import { assessSummaryQuality } from '../src/summary/summary-quality.js'
import {
  actorIdFromPlatformUser,
  actorMetadataPatch,
  auditActorMetadata,
  classifyActorMetadata,
  normalizeActorIdentity,
} from '../src/continuity/actor-identity.js'
import { createTestService } from './helpers.js'
import { MINUTE } from './helpers.js'

const BS = String.fromCharCode(92)
const BASE_TIME = Date.UTC(2026, 2, 1, 9, 0, 0)
const JOBS_OFF: Partial<MemorySeaConfig> = {
  jobs: { enabled: false, intervalMs: 2000, maxPerTick: 8, staleMs: 60_000, maxAttempts: 3 },
}
const SCOPE = { rootPath: 'C:/work/stage46' }

function makeExperience(overrides: Partial<Experience> & { content: string }): Experience {
  const base: Experience = {
    id: 'xp_base',
    sourceType: 'chat',
    content: overrides.content,
    createdAt: BASE_TIME,
    observedAt: BASE_TIME,
    importance: 0.5,
    metadata: {},
    embeddingStatus: 'pending',
  }
  return { ...base, ...overrides }
}

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  const base: Episode = {
    id: 'ep_test',
    startedAt: BASE_TIME,
    endedAt: BASE_TIME + 5 * MINUTE,
    experienceIds: [],
    participants: [],
    locations: [],
    topics: [],
    importance: 0.5,
    salience: 0.5,
    confidence: 0.5,
    status: 'closed',
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    embeddingStatus: 'disabled',
    summaryStatus: 'pending',
    consolidationStatus: 'pending',
    continuityStatus: 'pending',
    lastExperienceAt: BASE_TIME,
  }
  return { ...base, ...overrides }
}

async function summarize(experiences: Experience[]) {
  const episode = makeEpisode({ experienceIds: experiences.map((item) => item.id) })
  const summarizer = new ExtractiveSummarizer()
  const result = await summarizer.summarize(episode, experiences)
  const quality = assessSummaryQuality({
    title: result.title,
    summary: result.summary,
    experiences,
  })
  return { result, quality }
}

const MACHINE_MARKERS = ['{', '}', 'error TS', 'export ', 'import ', 'node_modules', ' at ', 'src/', `C:${BS}`, 'npm run', '+28ms']

function assertNoMachineMarkers(text: string, label: string): void {
  for (const marker of MACHINE_MARKERS) {
    assert.ok(!text.includes(marker), `${label} 不应包含机器输出标记 ${JSON.stringify(marker)}：${text}`)
  }
}

// ---------------------------------------------------------------- A. 摘要质量

test('摘要质量：普通对话保留自然语言，不出现机器行', async () => {
  const { result, quality } = await summarize([
    makeExperience({ id: 'xp_1', content: '今天研究 Memory Sea 的结构。' }),
    makeExperience({ id: 'xp_2', content: '下午和同事聊了记忆分层这件事。' }),
  ])
  assert.ok(result.summary.includes('Memory Sea'))
  assertNoMachineMarkers(result.summary, '普通对话摘要')
  assert.ok(quality.grade !== 'poor', `普通对话不该是 poor：${JSON.stringify(quality)}`)
})

test('摘要质量：明确的决定与目标优先保留，并带上意图标记', async () => {
  const { result, quality } = await summarize([
    makeExperience({ id: 'xp_1', content: '决定 V0.2 先用 SQLite，本地优先，不引入额外服务。' }),
    makeExperience({ id: 'xp_2', content: '目标是在这个月内把链路跑通。' }),
  ])
  assert.ok(result.summary.includes('决定') || result.summary.includes('SQLite'), result.summary)
  assert.equal(quality.hasIntent, true)
  assert.ok(!quality.flags.includes('intent_missing'))
})

test('摘要质量：工具 JSON 回执不进摘要', async () => {
  const json = JSON.stringify({ ok: true, data: [{ id: 'xp_1', content: 'export const a = 1' }] })
  const { result, quality } = await summarize([
    makeExperience({ id: 'xp_1', content: '决定继续用 SQLite 存记忆。' }),
    makeExperience({ id: 'xp_2', sourceType: 'tool', content: json }),
  ])
  assert.ok(result.summary.includes('SQLite'))
  assertNoMachineMarkers(result.summary, 'JSON 回执摘要')
  assert.ok(!quality.flags.includes('machine_dominated'))
})

test('摘要质量：TypeScript 代码与编译错误不进摘要', async () => {
  const code = [
    'src/service.ts(21,7): error TS2739: Type is missing properties',
    '  21 | import { MemoryDatabase } from "./storage/database.js"',
    '  22 | export class MemorySeaService {',
    '     |       ~~~~~~~~~~~~~~~~~',
  ].join('\n')
  const { result } = await summarize([
    makeExperience({ id: 'xp_1', content: '这次改造决定把摘要器拆成独立模块。' }),
    makeExperience({ id: 'xp_2', sourceType: 'tool', content: code }),
  ])
  assert.ok(result.summary.includes('摘要器'), result.summary)
  assertNoMachineMarkers(result.summary, '代码摘要')
})

test('摘要质量：Windows 路径不进摘要', async () => {
  const pathLine = `C:${BS}Users${BS}Administrator${BS}Desktop${BS}记忆插件${BS}src${BS}service.ts`
  const { result } = await summarize([
    makeExperience({ id: 'xp_1', content: '决定把数据库放到本地目录，先不搞云同步。' }),
    makeExperience({ id: 'xp_2', sourceType: 'tool', content: `${pathLine}\n${pathLine}` }),
  ])
  assert.ok(result.summary.includes('云同步') || result.summary.includes('数据库'))
  assertNoMachineMarkers(result.summary, '路径摘要')
})

test('摘要质量：中英技术词不算机器内容', async () => {
  const { result, quality } = await summarize([
    makeExperience({ id: 'xp_1', content: '决定继续用 SQLite 与 FTS5，Neo4j 暂时不上。' }),
  ])
  assert.ok(result.summary.includes('SQLite'))
  assert.ok(result.summary.includes('Neo4j') || result.summary.includes('FTS5'))
  assert.ok(quality.narrativeChars > 0)
})

test('摘要质量：只有日志时安全回退，不编造摘要', async () => {
  const logs = [
    '> tsc -p tsconfig.json',
    'npm run build',
    '+28ms Done in 1.2s',
    'src/summary/extractive-summarizer.ts:43:5',
  ].join('\n')
  const { result, quality } = await summarize([
    makeExperience({ id: 'xp_1', sourceType: 'tool', content: logs }),
    makeExperience({ id: 'xp_2', sourceType: 'tool', content: '{"ok":true,"jobs":{"pending":0}}' }),
  ])
  assert.equal(result.summary.trim(), '')
  assert.ok(['一段经历', '低信息量会话'].includes(result.title ?? ''), `回退标题异常：${result.title}`)
  assert.equal(quality.grade, 'poor')
  assert.ok(quality.flags.includes('empty_summary'))
  assert.ok(quality.flags.includes('title_low_information'))
})

test('摘要质量：开发会话里人写的结论胜过大量工具输出（且结果稳定）', async () => {
  const machineBlock = Array.from({ length: 12 }, (_, index) => `src/module-${index}.ts(${index},1): error TS1005: expected ';'`).join('\n')
  const experiences = [
    makeExperience({ id: 'xp_1', sourceType: 'tool', content: machineBlock }),
    makeExperience({ id: 'xp_2', content: '结论：先保证本地可跑，再考虑向量检索。' }),
    makeExperience({ id: 'xp_3', sourceType: 'tool', content: '{"ok":true,"memories":[]}' }),
    makeExperience({ id: 'xp_4', content: '接下来要把摘要质量的问题也补掉。' }),
  ]
  const first = await summarize(experiences)
  const second = await summarize(experiences)
  assert.ok(first.result.summary.includes('本地') || first.result.summary.includes('摘要'), first.result.summary)
  assertNoMachineMarkers(first.result.summary, '开发会话摘要')
  assert.equal(first.result.summary, second.result.summary)
  assert.equal(first.result.title, second.result.title)
  assert.ok(first.quality.grade !== 'poor')
})

// ------------------------------------------------------------ B. 身份连续性

test('身份：同一平台用户跨 Session 得到稳定 actorId', () => {
  const first = normalizeActorIdentity({ platform: 'bilibili', platformUserId: '1001' })
  const second = normalizeActorIdentity({ platform: 'bilibili', platformUserId: '1001' })
  const third = normalizeActorIdentity({ platform: 'bilibili', platformUserId: '1001', sessionId: 'liv_other' })
  assert.ok(first)
  assert.equal(first?.actorId, second?.actorId)
  assert.equal(first?.actorId, third?.actorId)
  assert.equal(first?.actorId, actorIdFromPlatformUser('bilibili', '1001'))
  assert.equal(first?.confidence, 'high')
})

test('身份：改昵称不改变身份', () => {
  const before = normalizeActorIdentity({ platform: 'bilibili', platformUserId: '1001', nickname: '小王' })
  const after = normalizeActorIdentity({ platform: 'bilibili', platformUserId: '1001', nickname: '老张' })
  assert.equal(before?.actorId, after?.actorId)
})

test('身份：同名不同用户不会被合并', () => {
  const a = normalizeActorIdentity({ platform: 'bilibili', platformUserId: '1001', nickname: '小明' })
  const b = normalizeActorIdentity({ platform: 'bilibili', platformUserId: '2002', nickname: '小明' })
  assert.ok(a && b)
  assert.notEqual(a?.actorId, b?.actorId)
})

test('身份：缺少可靠 ID 时标记未知，不猜', () => {
  assert.equal(normalizeActorIdentity({ nickname: '路人甲' }), null)
  assert.equal(normalizeActorIdentity({}), null)
  assert.equal(classifyActorMetadata({ nickname: '路人甲' }), 'nicknameOnly')
  assert.equal(classifyActorMetadata({}), 'missing')
  assert.equal(classifyActorMetadata({ platformUserId: '1001', platform: 'bilibili' }), 'stablePlatformId')
  assert.equal(classifyActorMetadata({ actorId: 'act_abc' }), 'normalizedActorId')
  assert.equal(classifyActorMetadata({ viewerId: 'vwr_abc' }), 'legacyViewerId')
})

test('身份：审计只统计不推断，并给出可回填的修丁', () => {
  const audit = auditActorMetadata([
    { actorId: 'act_1' },
    { platformUserId: '1001', platform: 'bilibili' },
    { viewerId: 'vwr_2' },
    { nickname: '路人' },
    {},
  ])
  assert.equal(audit.total, 5)
  assert.equal(audit.normalizedActorId, 1)
  assert.equal(audit.stablePlatformId, 1)
  assert.equal(audit.legacyViewerId, 1)
  assert.equal(audit.nicknameOnly, 1)
  assert.equal(audit.missing, 1)
  assert.equal(actorMetadataPatch({ actorId: 'act_1' }), null)
  assert.equal(actorMetadataPatch({ nickname: '路人' }), null)
  const patch = actorMetadataPatch({ platformUserId: '1001', platform: 'bilibili' })
  assert.equal(patch?.actorId, actorIdFromPlatformUser('bilibili', '1001'))
})

// ------------------------------------------- B（集成）：连续性不越界、不猜

async function settle(service: { drainJobs: () => Promise<number>; status: (scope: { rootPath: string }) => { jobs: { pending: number } } }) {
  for (let round = 0; round < 20; round += 1) {
    await service.drainJobs()
    if (service.status(SCOPE).jobs.pending === 0) return
  }
}

test('连续性：同一 actor 的无关话题不会被判为 continues', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    const { service, clock } = harness
    await service.capture(
      { content: '我下周要复试，先准备专业课。', sessionId: 's-exam', metadata: { actorId: 'act_stage46' } },
      SCOPE,
    )
    clock.advance(40 * MINUTE)
    await service.runMaintenance()
    await service.capture(
      { content: '今晚看黑神话的新剧情，挺有意思。', sessionId: 's-game', metadata: { actorId: 'act_stage46' } },
      SCOPE,
    )
    clock.advance(40 * MINUTE)
    await service.runMaintenance()
    await settle(service)

    const relations = service.listEpisodeRelations(service.status(SCOPE).scope.id)
    const kinds = relations.map((item) => item.relation)
    assert.ok(!kinds.includes('continues'), `无关话题不应 continues：${JSON.stringify(relations)}`)
  } finally {
    harness.cleanup()
  }
})

test('连续性：同 actor+同话题+后续进展可以建立关系，且遵守 scope 隔离', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    const { service, clock } = harness
    await service.capture(
      { content: '我下周要复试，先准备专业课。', sessionId: 's-exam-2', metadata: { actorId: 'act_stage46' } },
      SCOPE,
    )
    clock.advance(90 * MINUTE)
    await service.runMaintenance()
    await service.capture(
      { content: '复试结束了，专业课问得挺细。', sessionId: 's-exam-2', metadata: { actorId: 'act_stage46' } },
      SCOPE,
    )
    clock.advance(90 * MINUTE)
    await service.runMaintenance()
    await settle(service)

    const scopeId = service.status(SCOPE).scope.id
    const relations = service.listEpisodeRelations(scopeId)
    assert.ok(relations.length >= 1, '同 actor + 同话题应建立至少一条关系')
    for (const relation of relations) {
      assert.equal(relation.scopeId, scopeId)
      assert.notEqual(relation.sourceEpisodeId, relation.targetEpisodeId)
      assert.ok(relation.confidence > 0 && relation.confidence <= 1)
    }

    // 另一个 scope 里写入相同 actor，不应共享关系。
    const other = { rootPath: 'C:/work/stage46-other' }
    await service.capture(
      { content: '我下周要复试，先准备专业课。', sessionId: 's-exam-2', metadata: { actorId: 'act_stage46' } },
      other,
    )
    const otherScopeId = service.status(other).scope.id
    assert.notEqual(otherScopeId, scopeId)
    const otherRelations = service.listEpisodeRelations(otherScopeId)
    for (const relation of otherRelations) {
      assert.notEqual(relation.sourceEpisodeId, relations[0]?.sourceEpisodeId)
    }
  } finally {
    harness.cleanup()
  }
})

test('身份回填：dry-run 可重复、应用后幂等，且不改 Experience 原文', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    const { service } = harness
    const captured = await service.capture(
      {
        content: '主播记住我叫小王，我下周要考试。',
        sessionId: 's-live',
        metadata: { viewerId: 'vwr_stage46', platformUserId: '1001', platform: 'bilibili', nicknameAtTime: '小王' },
      },
      SCOPE,
    )
    const contentBefore = captured.experience.content
    const episodeBefore = service.getEpisode(captured.episode.id)
    assert.ok(episodeBefore)

    const scopeId = service.status(SCOPE).scope.id
    const auditBefore = service.auditActorIdentity(scopeId)
    assert.equal(auditBefore.total >= 1, true)

    const dryFirst = service.normalizeActorMetadata(scopeId, { dryRun: true })
    const drySecond = service.normalizeActorMetadata(scopeId, { dryRun: true })
    assert.equal(dryFirst.wouldUpdate, drySecond.wouldUpdate)
    assert.ok(dryFirst.wouldUpdate >= 1)
    assert.equal(service.getExperience(captured.experience.id)?.content, contentBefore)

    const applied = service.normalizeActorMetadata(scopeId, { dryRun: false })
    assert.equal(applied.wouldUpdate, dryFirst.wouldUpdate)
    const appliedAgain = service.normalizeActorMetadata(scopeId, { dryRun: false })
    assert.equal(appliedAgain.wouldUpdate, 0)

    const after = service.getExperience(captured.experience.id)
    assert.equal(after?.content, contentBefore)
    assert.equal(after?.metadata.actorId, actorIdFromPlatformUser('bilibili', '1001'))
    const episodeAfter = service.getEpisode(captured.episode.id)
    assert.deepEqual(episodeAfter?.experienceIds, episodeBefore?.experienceIds)
  } finally {
    harness.cleanup()
  }
})

test('摘要重算：dry-run 默认不排队，真实执行后摘要是派生字段可更新', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    const { service, clock } = harness
    await service.capture(
      {
        content: `src/service.ts(21,7): error TS2739: broken${'\n'}import { x } from './x.js'`,
        sourceType: 'tool',
        sessionId: 's-summary',
      },
      SCOPE,
    )
    clock.advance(40 * MINUTE)
    await service.runMaintenance()
    await settle(service)

    const scopeId = service.status(SCOPE).scope.id
    const report = service.listSummaryQuality(scopeId)
    assert.equal(report.counts.total >= 1, true)

    const dry = service.requeueLowQualitySummaries(scopeId, { dryRun: true })
    assert.equal(dry.dryRun, true)
    assert.equal(dry.queued, 0)
    const applied = service.requeueLowQualitySummaries(scopeId, { dryRun: false })
    assert.equal(applied.dryRun, false)
    assert.ok(applied.queued >= 0)
  } finally {
    harness.cleanup()
  }
})
