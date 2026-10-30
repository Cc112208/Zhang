/**
 * scripts/verify-stage45.mjs —— Stage 4.5 验收取证（真实 SQLite + FTS5，无网络）。
 *
 * 证明两件事：
 *   A. 短口语（「主播好」）在 actor 上下文存在时能召回该参与者的重要记忆；
 *      没有上下文时绝不随机召回。
 *   B. 同一参与者的连续经历跨 Episode / 跨场次形成 Narrative Chain（只写 relation，
 *      不改写 Episode，也不把 relation 当 Evidence）。
 *
 * 运行：npm run verify:stage45
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemorySeaService } from '../dist/src/service.js'
import { detectQuerySignal } from '../dist/src/recall/short-query-detector.js'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const SCOPE = { rootPath: 'C:/work/stage45-verify' }

let clock = Date.UTC(2026, 9, 29, 9, 0, 0)
const now = () => clock
const advance = (ms) => {
  clock += ms
}

const directory = mkdtempSync(join(tmpdir(), 'memory-sea-stage45-'))
const dbPath = join(directory, 'verify.db')
const service = new MemorySeaService({
  config: {
    enabled: true,
    databasePath: dbPath,
    jobs: { enabled: false, intervalMs: 2000, maxPerTick: 16, staleMs: 60_000, maxAttempts: 3 },
    embedding: { enabled: false },
  },
  now,
  env: {},
})

const line = (label, value) => console.log(`  ${label}: ${value}`)

async function settle() {
  for (let round = 0; round < 30; round += 1) {
    await service.drainJobs()
    if (service.status(SCOPE).jobs.pending === 0) break
  }
}

async function runEpisode(messages, { actorId, sessionId }) {
  let episodeId = ''
  for (const content of messages) {
    episodeId = service.capture(
      { content, sessionId, metadata: { actorId, threadKey: actorId } },
      SCOPE,
    ).episode.id
  }
  advance(30 * MINUTE)
  service.runMaintenance()
  await settle()
  return episodeId
}

try {
  console.log('Stage 4.5 验收 —— 短查询上下文召回 + Episode 连续性')

  // ---------------------------------------------------------------- A. 弱查询判定
  const signals = ['主播好', '你好', '我来了', '嗯', '然后呢', '怎么样了', '为什么我们没用 Neo4j？']
  console.log('A. 弱查询判定')
  for (const query of signals) {
    line(`「${query}」`, detectQuerySignal(query).signal)
  }

  // ---------------------------------------------------------------- B. 长期记忆
  const first = await runEpisode(['我下周要复试，先准备专业课。'], { actorId: 'actor_zhang', sessionId: 's-1' })
  const second = await runEpisode(
    ['专业课差不多准备好了，还差英文自我介绍。'],
    { actorId: 'actor_zhang', sessionId: 's-1' },
  )
  const third = await runEpisode(
    ['今天复试结束了，感觉还行，等结果。'],
    { actorId: 'actor_zhang', sessionId: 's-2' },
  )

  // ---------------------------------------------------------------- C. 上下文召回
  console.log('B. 回访参与者 + 弱问候')
  const weakHits = await service.recall(
    {
      query: '主播好',
      context: { actorId: 'actor_zhang', returningActor: true, interactionType: 'greeting' },
    },
    SCOPE,
  )
  line('命中数', weakHits.length)
  for (const hit of weakHits.slice(0, 5)) {
    const reasons = hit.reasons.map((reason) => `${reason.type}${reason.detail ? `(${reason.detail})` : ''}`)
    line(hit.type, `${hit.score.toFixed(4)} ${hit.content.slice(0, 40)} → ${reasons.join(' / ')}`)
  }
  const remembered = weakHits.some((hit) => hit.content.includes('复试'))
  line('是否想起复试', remembered ? '是' : '否')

  const plainHits = await service.recall({ query: '你好' }, SCOPE)
  line('无 actor 上下文的「你好」命中数（应为 0）', plainHits.length)

  // ---------------------------------------------------------------- D. 参与者隔离
  const otherEpisode = await runEpisode(['我下周去旅行，想看看海边。'], {
    actorId: 'actor_li',
    sessionId: 's-3',
  })
  const hitsForLi = await service.recall(
    {
      query: '主播好',
      context: { actorId: 'actor_li', returningActor: true, interactionType: 'greeting' },
    },
    SCOPE,
  )
  const liText = hitsForLi.map((hit) => hit.content).join(' ')
  const zhangText = weakHits.map((hit) => hit.content).join(' ')
  console.log('C. 参与者隔离')
  line('actor_li 命中含「旅行」', liText.includes('旅行') ? '是' : '否')
  line('actor_li 命中含「复试」', liText.includes('复试') ? '是（串号！）' : '否')
  line('actor_zhang 命中含「旅行」', zhangText.includes('旅行') ? '是（串号！）' : '否')
  line('actor_li 首个 Episode', otherEpisode)

  // ---------------------------------------------------------------- E. 连续性
  const scopeId = service.status(SCOPE).scope.id
  const relations = service.listEpisodeRelations(scopeId, 200)
  const episodes = service.status(SCOPE).episodes
  console.log('D. Episode 连续性')
  line('Episode 数', episodes)
  line('relation 数', relations.length)
  line('relations / episodes', episodes > 0 ? (relations.length / episodes).toFixed(2) : '0')
  for (const relation of relations) {
    line(
      `${relation.sourceEpisodeId} → ${relation.targetEpisodeId}`,
      `${relation.relation} conf=${relation.confidence.toFixed(2)} ${relation.reason ?? ''}`,
    )
  }

  const chain = service.getEpisodeContinuity(scopeId, second, 2)
  line('middle Episode 的前序', chain.previous.map((item) => `${item.episodeId}:${item.relation}`).join(', ') || '（无）')
  line('middle Episode 的后续', chain.next.map((item) => `${item.episodeId}:${item.relation}`).join(', ') || '（无）')
  line('是否连到首尾', [first, third].filter((id) => [...chain.previous, ...chain.next].some((item) => item.episodeId === id)).length)

  // ---------------------------------------------------------------- F. 连续性展开
  console.log('E. 命中 Episode 时展开前后经历')
  const expandedHits = await service.recall(
    { query: '复试 专业课', types: ['episode'], limit: 5, expandContinuity: true },
    SCOPE,
  )
  const withExpansion = expandedHits.filter((hit) => (hit.expanded ?? []).length > 0)
  line('带展开的命中数', withExpansion.length)
  const expanded = withExpansion[0]?.expanded ?? []
  for (const hit of expanded) {
    line(hit.id, `${hit.createdAt} ${hit.content.slice(0, 40)}`)
  }
  const ordered = expanded.every((hit, index) => index === 0 || hit.createdAt >= expanded[index - 1].createdAt)
  line('按时间正序', ordered ? '是' : '否')
  line('展开项全部为 episode', expanded.every((hit) => hit.type === 'episode') ? '是' : '否')

  // ---------------------------------------------------------------- G. Scene / legacy
  const scene = service.getScene(SCOPE)
  const legacy = service.getLegacyScene(SCOPE)
  const continuityEdges = scene.edges.filter((edge) => ['continues', 'followup', 'same_thread', 'same_topic'].includes(edge.kind))
  console.log('F. Scene 契约')
  line('points / edges', `${scene.points.length} / ${scene.edges.length}`)
  line('连续性边', continuityEdges.length)
  line('连续性边都带 reason', continuityEdges.every((edge) => (edge.reason ?? '').length > 0) ? '是' : '否')
  line('stats.relations', scene.stats.relations ?? 0)
  line('legacy ok', legacy.ok)

  // ---------------------------------------------------------------- H. status
  const status = service.status(SCOPE)
  console.log('G. Status')
  line('continuity', JSON.stringify(status.continuity))
  line('recall', JSON.stringify(status.recall))
  line('embedding', JSON.stringify(status.embedding))

  // ---------------------------------------------------------------- I. 性能
  console.log('H. 性能（本机，Windows）')
  const captureStart = process.hrtime.bigint()
  for (let index = 0; index < 200; index += 1) {
    service.capture(
      { content: `压测消息 ${index}：今天聊的是数据库选择。`, sessionId: 'perf', metadata: { actorId: 'actor_perf' } },
      SCOPE,
    )
  }
  const captureMs = Number(process.hrtime.bigint() - captureStart) / 1e6
  line('capture 200 条', `${captureMs.toFixed(1)} ms（${(captureMs / 200).toFixed(2)} ms/条）`)

  const recallStart = process.hrtime.bigint()
  for (let index = 0; index < 30; index += 1) {
    await service.recall({ query: '数据库选择', limit: 5 }, SCOPE)
    await service.recall(
      { query: '主播好', context: { actorId: 'actor_zhang', returningActor: true, interactionType: 'greeting' } },
      SCOPE,
    )
  }
  const recallMs = Number(process.hrtime.bigint() - recallStart) / 1e6
  line('recall 60 次（普通 + 上下文）', `${recallMs.toFixed(1)} ms（${(recallMs / 60).toFixed(2)} ms/次）`)

  console.log('VERIFY STAGE 4.5 DONE')
} finally {
  service.closeSync()
  rmSync(directory, { recursive: true, force: true })
}
