#!/usr/bin/env node
/**
 * scripts/verify-stage46.mjs —— Stage 4.6 取证脚本。
 *
 * 两个模式：
 *   node scripts/verify-stage46.mjs          # 临时库：八类摘要输入 + 身份规范化幂等
 *   node scripts/verify-stage46.mjs --live   # 真实宿主库：审计 → dry-run → 应用 → 重排摘要
 *
 * 只做 Stage 4.6 的两件事：摘要质量与身份连续性。绝不修改 Experience.content、
 * 不创建 Evidence、不改变 scope 边界。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemorySeaService } from '../dist/src/service.js'
import { ExtractiveSummarizer } from '../dist/src/summary/extractive-summarizer.js'
import { assessSummaryQuality } from '../dist/src/summary/summary-quality.js'

const LIVE_DB = 'C:/Users/Administrator/.dsh/3d-memory-sea/memory-sea.db'
const LIVE = process.argv.includes('--live')
const BS = String.fromCharCode(92)
const NEWLINE = String.fromCharCode(10)
const MINUTE = 60_000

let now = Date.UTC(2026, 9, 29, 9, 0, 0)
const clock = () => now

function createService(dbPath) {
  return new MemorySeaService({
    config: {
      enabled: true,
      databasePath: dbPath,
      jobs: { enabled: false, intervalMs: 2000, maxPerTick: 8, staleMs: 60_000, maxAttempts: 3 },
      embedding: { enabled: false },
    },
    now: clock,
    logger: { info() {}, warn() {}, error() {} },
  })
}

async function settle(service, scope) {
  for (let round = 0; round < 30; round += 1) {
    await service.drainJobs()
    if (service.status(scope).jobs.pending === 0) return
  }
}

function experience(id, content, sourceType = 'chat') {
  return {
    id,
    sourceType,
    content,
    createdAt: now,
    observedAt: now,
    importance: 0.5,
    metadata: {},
    embeddingStatus: 'disabled',
  }
}

function episodeOf(ids) {
  return {
    id: 'ep_verify',
    startedAt: now - 5 * MINUTE,
    endedAt: now,
    experienceIds: ids,
    participants: [],
    locations: [],
    topics: [],
    importance: 0.5,
    salience: 0.5,
    confidence: 0.5,
    status: 'closed',
    createdAt: now - 5 * MINUTE,
    updatedAt: now,
    embeddingStatus: 'disabled',
    summaryStatus: 'ready',
    consolidationStatus: 'ready',
    continuityStatus: 'ready',
    lastExperienceAt: now,
  }
}

const CASES = [
  {
    name: '普通对话',
    source: 'chat',
    content: '今天研究 Memory Sea 的结构。下午和同事聊了记忆分层。',
  },
  {
    name: '明确决定与目标',
    source: 'chat',
    content: '决定 V0.2 先用 SQLite 本地优先。目标是一个月内跑通链路。',
  },
  {
    name: '工具 JSON 回执',
    source: 'tool',
    content: JSON.stringify({ ok: true, data: [{ id: 'xp_1', content: 'export const a = 1' }] }),
  },
  {
    name: 'TS 代码与编译错误',
    source: 'tool',
    content: [
      'src/service.ts(21,7): error TS2739: Type is missing properties',
      '  21 | import { MemoryDatabase } from "./storage/database.js"',
      '  22 | export class MemorySeaService {',
    ].join(NEWLINE),
  },
  {
    name: 'Windows 路径',
    source: 'file',
    content: `C:${BS}Users${BS}Administrator${BS}Desktop${BS}memory${BS}src${BS}index.ts`,
  },
  {
    name: '中英混合技术词',
    source: 'chat',
    content: '决定继续用 SQLite 与 FTS5，Neo4j 暂时不上，embedding 保持可插拔。',
  },
  {
    name: '纯日志',
    source: 'tool',
    content: ['> tsc -p tsconfig.json', '+28ms Done in 1.2s', 'src/summary/extractive-summarizer.ts:43:5'].join(NEWLINE),
  },
  {
    name: '开发会话混合',
    source: 'chat',
    content: ['结论：先保证本地可跑，再考虑向量检索。', '接下来补摘要质量。'].join(NEWLINE),
  },
]

async function tempMode() {
  const directory = mkdtempSync(join(tmpdir(), 'memory-sea-stage46-'))
  const service = createService(join(directory, 'memory-sea.db'))
  const SCOPE = { rootPath: 'C:/work/stage46-verify' }
  const summarizer = new ExtractiveSummarizer()
  try {
    console.log('== A. 摘要质量（八类输入） ==')
    let poor = 0
    for (const item of CASES) {
      const experiences = [experience('xp_case', item.content, item.source)]
      const result = await summarizer.summarize(episodeOf(['xp_case']), experiences)
      const quality = assessSummaryQuality({ title: result.title, summary: result.summary, experiences })
      if (quality.grade === 'poor') poor += 1
      console.log(
        `- ${item.name}: grade=${quality.grade} score=${quality.score.toFixed(2)} ` +
          `flags=[${quality.flags.join(',')}] title=${JSON.stringify(result.title)} ` +
          `summary=${JSON.stringify(result.summary.slice(0, 60))}`,
      )
    }
    console.log(`-> poor 数：${poor}（纯机器内容 → 明确回退，这是预期；有人话的输入必须是 good/fair）`)

    console.log('== B. 身份审计与规范化（临时库） ==')
    const captures = [
      { content: '我下周要复试，先准备专业课。', metadata: { platformUserId: '1001', platform: 'bilibili', nicknameAtTime: '张三' } },
      { content: '我叫老王，记一下。', metadata: { platformUserId: '1001', platform: 'bilibili', nicknameAtTime: '老张' } },
      { content: '今天直播挺有意思。', metadata: { viewerId: 'vwr_abc' } },
      { content: '路过看看。', metadata: { nicknameAtTime: '路人' } },
    ]
    for (const item of captures) {
      service.capture({ content: item.content, sessionId: 's-verify', metadata: item.metadata }, SCOPE)
    }
    now += 40 * MINUTE
    await service.runMaintenance()
    await settle(service, SCOPE)
    const scopeId = service.status(SCOPE).scope.id
    const auditBefore = service.auditActorIdentity(scopeId)
    console.log(`- 审计（前）：${JSON.stringify(auditBefore)}`)
    const dry = service.normalizeActorMetadata(scopeId, { dryRun: true })
    const dryAgain = service.normalizeActorMetadata(scopeId, { dryRun: true })
    console.log(`- dry-run：wouldUpdate=${dry.wouldUpdate}（重复无副作用：${dry.wouldUpdate === dryAgain.wouldUpdate}）`)
    const applied = service.normalizeActorMetadata(scopeId, { dryRun: false })
    const appliedAgain = service.normalizeActorMetadata(scopeId, { dryRun: false })
    const auditAfter = service.auditActorIdentity(scopeId)
    console.log(`- 应用：updated=${applied.wouldUpdate}，二次执行 updated=${appliedAgain.wouldUpdate}`)
    console.log(`- 审计（后）：${JSON.stringify(auditAfter)}`)

    const quality = service.listSummaryQuality(scopeId)
    console.log(`- 摘要质量分布：${JSON.stringify(quality.counts)}`)
    const requeueDry = service.requeueLowQualitySummaries(scopeId, { dryRun: true })
    console.log(`- 低质量重排 dry-run：${JSON.stringify(requeueDry)}`)
    console.log('VERIFY STAGE 4.6 DONE')
  } finally {
    service.closeSync()
    rmSync(directory, { recursive: true, force: true })
  }
}

async function liveMode() {
  const service = createService(LIVE_DB)
  try {
    const scopes = service.knownScopes()
    console.log(`== 真实宿主库：${LIVE_DB}（${scopes.length} 个 scope） ==`)
    let totalAudit = { total: 0, normalizedActorId: 0, stablePlatformId: 0, legacyViewerId: 0, nicknameOnly: 0, missing: 0 }
    for (const scope of scopes.slice(0, 12)) {
      const audit = service.auditActorIdentity(scope.id, { limit: 400 })
      const dry = service.normalizeActorMetadata(scope.id, { dryRun: true, limit: 400 })
      console.log(
        `- ${scope.id}: experiences=${audit.total} normalized=${audit.normalizedActorId} ` +
          `stable=${audit.stablePlatformId} legacy=${audit.legacyViewerId} nicknameOnly=${audit.nicknameOnly} ` +
          `missing=${audit.missing} | 可回填=${dry.wouldUpdate}`,
      )
      for (const key of Object.keys(totalAudit)) totalAudit[key] += audit[key] ?? 0
    }
    console.log(`- 合计：${JSON.stringify(totalAudit)}`)

    const quality = service.listSummaryQuality(scopes[0]?.id ?? service.defaultScope.id, { limit: 100 })
    console.log(`- 摘要质量（首个 scope）：${JSON.stringify(quality.counts)}`)

    console.log('== 应用回填（仅补 actorId 字段，不改原文） ==')
    let updated = 0
    for (const scope of scopes.slice(0, 12)) {
      const result = service.normalizeActorMetadata(scope.id, { dryRun: false, limit: 400 })
      updated += result.wouldUpdate
    }
    console.log(`- 已补 actorId 的记录数：${updated}`)

    console.log('== 重排低质量摘要（后台 job） ==')
    let queued = 0
    for (const scope of scopes.slice(0, 12)) {
      const result = service.requeueLowQualitySummaries(scope.id, { dryRun: false, limit: 40 })
      queued += result.queued
    }
    console.log(`- 已重新入队摘要任务：${queued}`)
    for (const scope of scopes.slice(0, 12)) await settle(service, scope)
    const after = service.listSummaryQuality(scopes[0]?.id ?? service.defaultScope.id, { limit: 100 })
    console.log(`- 重算后摘要质量（首个 scope）：${JSON.stringify(after.counts)}`)
    console.log('VERIFY STAGE 4.6 LIVE DONE')
  } finally {
    service.closeSync()
  }
}

await (LIVE ? liveMode() : tempMode())
