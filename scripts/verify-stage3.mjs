/**
 * scripts/verify-stage3.mjs —— Stage 3 验收取证脚本（spec §85/§86 认知闭环 + 性能）。
 *
 * 直接跑编译产物（dist/src），不 mock 存储、不 mock 服务：
 *   npm run build && node scripts/verify-stage3.mjs
 *
 * 证据链：Episode E1/E2/E3 → Consolidation → Semantic Memory → Evidence[]
 *         → 新 Episode（迁移 PostgreSQL）→ Supersede → Recall → Inspect → Scene
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { MemorySeaService } = await import('../dist/src/service.js')

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const SCOPE = { rootPath: 'C:/work/verify-stage3' }
const output = []

function say(line = '') {
  output.push(line)
  console.log(line)
}
function section(title) {
  say('')
  say(`=== ${title} ===`)
}

function createClock(start = Date.UTC(2026, 9, 29, 9, 0, 0)) {
  let now = start
  return {
    now: () => now,
    advance: (ms) => {
      now += ms
    },
  }
}

const silentLogger = { info() {}, warn() {}, error() {} }

const clock = createClock()
const directory = mkdtempSync(join(tmpdir(), 'memory-sea-verify3-'))
const dbPath = join(directory, 'verify3.db')

const service = new MemorySeaService({
  now: clock.now,
  logger: silentLogger,
  config: {
    enabled: true,
    databasePath: dbPath,
    // 关掉后台定时器：全部由脚本显式推进，结果可复现。
    jobs: { enabled: false, intervalMs: 5000, maxPerTick: 8, staleMs: 60_000, maxAttempts: 3 },
    embedding: { enabled: false },
  },
})

async function settle() {
  for (let i = 0; i < 20; i += 1) {
    await service.drainJobs()
    if (service.status(SCOPE).jobs.pending === 0) return
  }
}

/** 写一组连续消息 → 触发 idle 关闭 → 摘要 → 整理。返回该 Episode id。 */
async function runEpisode(messages, sessionId) {
  let episodeId = ''
  for (const content of messages) {
    episodeId = service.capture({ content, sessionId }, SCOPE).episode.id
  }
  clock.advance(30 * MINUTE)
  service.runMaintenance()
  await settle()
  return episodeId
}

function shortId(id) {
  return typeof id === 'string' ? id.slice(0, 12) : String(id)
}

function describeMemory(memory) {
  return [
    `  id=${shortId(memory.id)} kind=${memory.kind} status=${memory.status} confidence=${memory.confidence.toFixed(3)}`,
    `  content=${memory.content}`,
    `  evidence=${memory.reinforcementCount} 次强化 / 访问 ${memory.accessCount} 次`,
  ].join('\n')
}

try {
  section('A. 认知闭环：三段经历整理成一条 Semantic Memory')

  const e1 = await runEpisode(
    [
      '今天讨论 Memory Sea V0.2 的存储方案。',
      '决定 Memory Sea V0.2 先用 SQLite 存记忆。',
      'Neo4j 暂时不上，当前优先保持本地、低复杂度方案。',
    ],
    'verify-e1',
  )

  const created = service.listMemories({ includeSuperseded: true }, SCOPE)
  say(`E1 episode=${shortId(e1)}，整理出 ${created.length} 条知识`)
  for (const memory of created) say(describeMemory(memory))
  // 一段对话里可以合法提炼出两条不同知识（存储决定 + 约束/偏好），
  // 这里锁定「SQLite 决定」这条，后续强化/取代都以它为追踪对象。
  const memory = created.find((item) => item.kind === 'decision' && item.content.includes('SQLite'))
  if (!memory) throw new Error('E1 应整理出一条关于 SQLite 的 decision 知识')
  const evidenceAfterCreate = service.listMemoryEvidence(memory.id)
  say(`  证据 Episode：${evidenceAfterCreate.map((item) => shortId(item.evidenceId)).join(', ')}`)

  section('B. 强化：第二段一致经历只增证据与计数')

  clock.advance(2 * HOUR)
  await runEpisode(['再确认一次：Memory Sea 继续用 SQLite，保持本地优先。'], 'verify-e2')

  const reinforcedList = service.listMemories({ includeSuperseded: true }, SCOPE)
  const reinforced = reinforcedList.find((item) => item.id === memory.id)
  say(`知识总数=${reinforcedList.length}（不应新增重复知识），reinforcementCount=${reinforced.reinforcementCount}`)
  say(`confidence=${memory.confidence.toFixed(3)} → ${reinforced.confidence.toFixed(3)}`)
  const evidenceAfterReinforce = service.listMemoryEvidence(memory.id)
  say(`  证据 Episode：${evidenceAfterReinforce.map((item) => shortId(item.evidenceId)).join(', ')}`)
  if (reinforcedList.length !== created.length) throw new Error('强化不能产生重复知识')
  if (reinforced.reinforcementCount < 1) throw new Error('强化后 reinforcementCount 必须增加')
  if (reinforced.confidence <= memory.confidence) throw new Error('强化后 confidence 必须上升')

  section('C. 取代：明确迁移后旧知识 superseded，历史保留')

  clock.advance(3 * HOUR)
  await runEpisode(
    ['数据规模上来了，决定迁移到 PostgreSQL 并评估图数据库。', '这次迁移是长期方案，不只是临时试试。'],
    'verify-e3',
  )

  const all = service.listMemories({ includeSuperseded: true }, SCOPE)
  for (const item of all) say(describeMemory(item))
  const superseded = all.find((item) => item.id === memory.id)
  const successor = superseded && all.find((item) => item.id === superseded.supersededBy)
  say(`旧知识 status=${superseded?.status} supersededBy=${shortId(superseded?.supersededBy)} validUntil=${superseded?.validUntil}`)
  if (!superseded || superseded.status !== 'superseded') throw new Error('迁移后旧知识必须 superseded')
  if (!successor || successor.status !== 'active') throw new Error('必须存在新的 active 知识')
  say(`新知识 status=${successor.status} content=${successor.content}`)

  section('D. 召回：同时检索 Memory 与 Episode，并给出可解释理由')

  const hits = await service.recall(
    { query: '为什么 Memory Sea 先用 SQLite？', limit: 5, expandEpisodes: true, includeSuperseded: true },
    SCOPE,
  )
  for (const hit of hits) {
    say(`  [${hit.type}] score=${hit.score.toFixed(4)} id=${shortId(hit.id)}`)
    say(`    ${hit.content.slice(0, 80)}`)
    say(`    理由：${hit.reasons.map((reason) => `${reason.type}(${reason.score ?? ''})${reason.detail ? ` ${reason.detail}` : ''}`).join('；')}`)
    for (const expanded of hit.expanded ?? []) {
      say(`    证据：${expanded.type} ${shortId(expanded.id)} ${expanded.content.slice(0, 40)}`)
    }
  }
  if (!hits.some((hit) => hit.type === 'memory')) throw new Error('召回必须能命中 Semantic Memory')

  section('E. 证据链下钻：Memory → Episode → Experience')

  const inspection = service.inspect(successor.id)
  say(`inspection.type=${inspection.type}`)
  say(`  证据条数=${inspection.evidence.length}`)
  say(`  Episode：${inspection.episodes.map((episode) => shortId(episode.id)).join(', ')}`)
  say(`  原始 Experience：${inspection.experiences.map((item) => shortId(item.id)).join(', ')}`)
  if (inspection.experiences.length === 0) throw new Error('必须能从 Memory 下钻到原始 Experience')

  section('F. Scene：Episode 与 Memory 节点 + 证据边（不改前端契约）')

  const scene = service.getScene(SCOPE)
  say(`points=${scene.points.length} edges=${scene.edges.length} stats=${JSON.stringify(scene.stats)}`)
  const memoryPoints = scene.points.filter((point) => point.type === 'memory')
  say(`memory 节点=${memoryPoints.length}：${memoryPoints.map((point) => `${shortId(point.id)}(size=${point.size})`).join(', ')}`)
  const evidenceEdges = scene.edges.filter((edge) => edge.kind === 'derived_from' || edge.kind === 'supports')
  say(`证据边=${evidenceEdges.length}，示例 reason=${evidenceEdges[0]?.reason ?? '(无)'}`)
  const legacy = service.getLegacyScene(SCOPE)
  const legacyMemory = legacy.points.find((point) => point.id === memoryPoints[0]?.id)
  say(`legacy ok=${legacy.ok} memoryPoint.kind=${legacyMemory?.kind} topic=${legacyMemory?.topic}`)

  section('G. 性能（capture 快路径不得被智能处理拖慢）')

  const captureStart = Date.now()
  const captureCount = 200
  for (let i = 0; i < captureCount; i += 1) {
    service.capture({ content: `性能测试第 ${i} 条：记录一次关于 SQLite 与 PostgreSQL 的讨论。`, sessionId: 'perf' }, SCOPE)
  }
  const captureElapsed = Date.now() - captureStart
  say(`capture ${captureCount} 条 = ${captureElapsed} ms（平均 ${(captureElapsed / captureCount).toFixed(2)} ms/条）`)

  const recallStart = Date.now()
  const recallCount = 30
  for (let i = 0; i < recallCount; i += 1) {
    await service.recall({ query: 'SQLite PostgreSQL 存储选型', limit: 8 }, SCOPE)
  }
  const recallElapsed = Date.now() - recallStart
  say(`recall ${recallCount} 次 = ${recallElapsed} ms（平均 ${(recallElapsed / recallCount).toFixed(2)} ms/次）`)

  await settle()
  const status = service.status(SCOPE)
  say(`status: experiences=${status.experiences} episodes=${status.episodes} memories=${JSON.stringify(status.memories)} consolidation=${JSON.stringify(status.consolidation)}`)
  say(`jobs=${JSON.stringify(status.jobs)} fts=${status.fts} embedding=${JSON.stringify(status.embedding)}`)

  const sizeMb = (statSync(dbPath).size / (1024 * 1024)).toFixed(2)
  say(`数据库大小 = ${sizeMb} MB`)

  section('H. 结论')
  say('认知闭环成立：经历 → Episode → 摘要 → 整理 → Semantic Memory → 证据 → 强化/取代 → 可解释召回。')
  say('VERIFY STAGE 3 DONE')
} finally {
  service.closeSync()
  rmSync(directory, { recursive: true, force: true })
}
