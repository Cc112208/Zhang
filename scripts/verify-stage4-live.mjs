/**
 * scripts/verify-stage4-live.mjs —— Stage 4 真实宿主库验证（写入宿主真实 DB，读取用宿主活实例 HTTP 交叉验证）。
 *
 *   node scripts/verify-stage4-live.mjs            # 写入 + 打印 scope id
 *   # 然后用活实例读回来：
 *   curl "http://127.0.0.1:59817/api/memory-sea/patterns?scope=<scopeId>"
 *   curl "http://127.0.0.1:59817/api/memory-sea/memories?scope=<scopeId>"
 *
 * 这里同时验证 spec §48–§51：`embedding.provider=openai-compatible` 走真实 HTTP `/embeddings`（本地 stub），
 * 语义改写问法必须命中记忆，且 semantic 通道有贡献。
 */

import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

const { MemorySeaService } = await import('../dist/src/service.js')

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NL = String.fromCharCode(10)
const SCOPE = { rootPath: 'C:/work/stage4-live' }
const DB_PATH = join(homedir(), '.dsh', '3d-memory-sea', 'memory-sea.db')

function say(line = '') {
  console.log(line)
}
function section(title) {
  say('')
  say(`=== ${title} ===`)
}

function createClock(start = Date.UTC(2026, 10, 8, 10, 0, 0)) {
  let now = start
  return {
    now: () => now,
    advance: (ms) => {
      now += ms
    },
  }
}

function conceptVector(text) {
  const lower = text.toLowerCase()
  if (lower.includes('neo4j') || lower.includes('图数据库') || lower.includes('graph')) return [1, 0, 0]
  if (lower.includes('sqlite') || lower.includes('关系型') || lower.includes('postgres')) return [0, 1, 0]
  if (lower.includes('复杂度') || lower.includes('简单') || lower.includes('部署') || lower.includes('过度设计')) return [0, 0, 1]
  return [0, 0.2, 0.8]
}

async function startEmbeddingStub() {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.includes('/embeddings')) {
      response.writeHead(404).end('{}')
      return
    }
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      let texts = []
      try {
        const parsed = JSON.parse(body)
        texts = Array.isArray(parsed.input) ? parsed.input : [parsed.input]
      } catch {
        texts = ['']
      }
      const data = texts.map((text, index) => ({
        object: 'embedding',
        index,
        embedding: conceptVector(String(text ?? '')),
      }))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data, model: 'stub-embed' }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

const clock = createClock()
const silentLogger = { info() {}, warn() {}, error() {} }
const stub = await startEmbeddingStub()

const service = new MemorySeaService({
  now: clock.now,
  logger: silentLogger,
  config: {
    enabled: true,
    databasePath: DB_PATH,
    jobs: { enabled: false, intervalMs: 5000, maxPerTick: 8, staleMs: 60_000, maxAttempts: 3 },
    pattern: { enabled: true, provider: 'rule', minSupport: 3, activationThreshold: 0.7 },
    embedding: {
      enabled: true,
      provider: 'openai-compatible',
      baseUrl: stub.baseUrl,
      apiKey: 'stub-key',
      model: 'stub-embed',
      dimensions: 3,
    },
  },
})

async function settle() {
  for (let i = 0; i < 40; i += 1) {
    await service.drainJobs()
    if (service.status(SCOPE).jobs.pending === 0) return
  }
}

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

const LOW_COMPLEXITY = [
  ['讨论 V0.4 架构。', '决定继续用 SQLite，因为简单，也不用额外部署。'],
  ['讨论并发模型。', '决定保持单进程，规模够用时不要过度设计。'],
  ['讨论缓存方案。', '决定省略缓存层，减少复杂度与运维。'],
]

try {
  const scope = service.defaultScope
  const scopeId = service.capture({ content: '项目走查开始。', sessionId: 'stage4-live-0' }, SCOPE).scopeId
  say(`宿主真实库：${DB_PATH}`)
  say(`本次 scope：${scopeId}`)
  if (scope.id === scopeId) say('（与默认 scope 相同的路径）')

  section('A. 三段独立决策 → Semantic Memory → Pattern（规则式分析器，实时后台任务）')

  for (const [index, messages] of LOW_COMPLEXITY.entries()) {
    await runEpisode(messages, `stage4-live-low-${index}`)
  }

  const memories = service.listMemories({ includeSuperseded: true }, SCOPE)
  say(`Semantic Memory 数量=${memories.length}`)
  for (const memory of memories) say(`  ${shortId(memory.id)} kind=${memory.kind} embedding=${memory.embeddingStatus} ${memory.content}`)

  const patterns = service.listPatterns({ includeSuperseded: true }, SCOPE)
  if (patterns.length !== 1) throw new Error(`应形成 1 条 Pattern，实际 ${patterns.length}`)
  const pattern = patterns[0]
  say(`Pattern：${shortId(pattern.id)} kind=${pattern.kind} status=${pattern.status} support=${pattern.supportCount} confidence=${pattern.confidence.toFixed(3)}`)
  say(`  ${pattern.content}`)
  for (const item of service.listPatternEvidence(pattern.id)) {
    say(`  证据 ${item.relation} → ${shortId(item.memoryId)}`)
  }
  if (service.listPatternEvidence(pattern.id).length < 3) throw new Error('Pattern 必须有多条 Memory 支持')

  section('B. 强化：新增同向知识只增支持数')

  clock.advance(2 * HOUR)
  await runEpisode(['讨论消息队列。', '仍然不上消息队列，避免过度设计，当前够用。'], 'stage4-live-low-3')
  const reinforced = service.listPatterns({ includeSuperseded: true }, SCOPE)
  say(`模式数量=${reinforced.length} support=${pattern.supportCount} → ${reinforced[0].supportCount} confidence=${pattern.confidence.toFixed(3)} → ${reinforced[0].confidence.toFixed(3)}`)
  if (reinforced.length !== 1) throw new Error('强化不能产生第二条模式')

  section('C. 一次例外不摧毁模式')

  clock.advance(3 * HOUR)
  await runEpisode(
    ['数据规模增长后决定迁移 PostgreSQL。', '这次是规模证明有需要之后才升级，不是推翻低复杂度原则。'],
    'stage4-live-scale',
  )
  const afterTrend = service.listPatterns({ includeSuperseded: true }, SCOPE)
  const survivor = afterTrend.find((item) => item.id === pattern.id)
  say(`模式数量=${afterTrend.length} status=${survivor?.status} support=${survivor?.supportCount} confidence=${survivor?.confidence.toFixed(3)}`)
  if (!survivor || survivor.status === 'superseded') throw new Error('一次例外不能 supersede 模式')
  const pref = afterTrend.filter((item) => item.content.includes('PostgreSQL'))
  say(`「偏好 PostgreSQL」类模式=${pref.length}（应为 0）`)
  if (pref.length > 0) throw new Error('偶然事件不得直接升级成模式')

  section('D. Pattern-aware Recall（真实向量通道 + 模式意图）')

  const patternHits = await service.recall({ query: '我们的架构选择一直有什么特点？', limit: 5, expandEpisodes: true }, SCOPE)
  say('查询：我们的架构选择一直有什么特点？')
  for (const hit of patternHits) {
    say(`  [${hit.type}] score=${hit.score.toFixed(4)} ${hit.content.slice(0, 56)}`)
    say(`    理由：${hit.reasons.map((reason) => `${reason.type}${reason.detail ? ` ${reason.detail}` : ''}`).join('；')}`)
  }
  if (patternHits[0]?.type !== 'pattern') throw new Error('模式类问法应让 Pattern 排第一')

  const specific = await service.recall({ query: '为什么先用 SQLite？', limit: 5 }, SCOPE)
  say('查询：为什么先用 SQLite？')
  for (const hit of specific) say(`  [${hit.type}] score=${hit.score.toFixed(4)} ${hit.content.slice(0, 50)}`)
  if (specific[0]?.type === 'pattern') throw new Error('具体问法不该被模式压过')

  section('E. 语义改写问法（OpenAI-compatible stub /embeddings）')

  await runEpisode(['讨论图数据库选型。', '决定暂时不上 Neo4j。'], 'stage4-live-graph')
  const semanticHits = await service.recall({ query: '为什么没有直接采用图数据库？', limit: 5 }, SCOPE)
  for (const hit of semanticHits) {
    say(`  [${hit.type}] score=${hit.score.toFixed(4)} ${hit.content.slice(0, 44)}`)
    say(`    理由：${hit.reasons.map((reason) => `${reason.type}${reason.detail ? ` ${reason.detail}` : ''}`).join('；')}`)
  }
  const semanticHit = semanticHits.find((hit) => hit.type === 'memory' || hit.type === 'episode')
  if (!semanticHit) throw new Error('语义改写问法必须命中记忆')
  if (!semanticHit.reasons.some((reason) => reason.type === 'semantic')) throw new Error('必须给出 semantic 理由')

  section('F. 证据链与 Scene')

  const inspection = service.inspect(pattern.id)
  say(`inspect(pattern)：证据=${inspection.evidence.length} 支持知识=${(inspection.memories ?? []).length}`)
  const firstMemory = (inspection.memories ?? [])[0]
  if (!firstMemory) throw new Error('Pattern 必须能下钻到 Memory')
  const memoryInspection = service.inspect(firstMemory.id)
  say(`inspect(memory)：episodes=${memoryInspection.episodes.length} experiences=${memoryInspection.experiences.length}`)

  const scene = service.getScene(SCOPE)
  const byType = {}
  for (const point of scene.points) byType[point.type] = (byType[point.type] ?? 0) + 1
  say(`scene points=${scene.points.length} edges=${scene.edges.length} types=${JSON.stringify(byType)} stats=${JSON.stringify(scene.stats)}`)
  const patternEdges = scene.edges.filter((edge) => edge.kind === 'supported_by' || edge.kind === 'contradicted_by')
  say(`模式边=${patternEdges.length} 示例 reason=${patternEdges[0]?.reason ?? '(无)'}`)
  const legacy = service.getLegacyScene(SCOPE)
  const legacyPattern = legacy.points.find((point) => point.type === 'pattern' || point.id === pattern.id)
  say(`legacy ok=${legacy.ok} patternPoint.kind=${legacyPattern?.kind} topic=${legacyPattern?.topic}`)

  const status = service.status(SCOPE)
  say('')
  say(`status: experiences=${status.experiences} episodes=${status.episodes} memories=${JSON.stringify(status.memories)}`)
  say(`patterns=${JSON.stringify(status.patterns)} review=${JSON.stringify(status.review)} jobs=${JSON.stringify(status.jobs)}`)
  say(`embedding=${JSON.stringify(status.embedding)}`)

  section('G. 结论')
  say(`写入完成。用宿主活实例读回来验证跨进程一致性：`)
  say(`  curl "http://127.0.0.1:59817/api/memory-sea/patterns?scope=${scopeId}"`)
  say(`  curl "http://127.0.0.1:59817/api/memory-sea/memories?scope=${scopeId}"`)
  say(`SCOPE_ID=${scopeId}`)
  say(`PATTERN_ID=${pattern.id}`)
  say('LIVE STAGE 4 DEMO DONE')
} finally {
  service.closeSync()
  await stub.close()
}
