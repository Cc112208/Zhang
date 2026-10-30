/**
 * scripts/verify-stage4.mjs —— Stage 4 验收取证脚本（spec §85/§86 认知闭环 + 性能 + 真实 embedding stub）。
 *
 * 直接跑编译产物（dist/src），不 mock 存储、不 mock 服务：
 *   npm run build && node scripts/verify-stage4.mjs
 *
 * 证据链：Experiences → Episodes → Semantic Memories(M1..M4)
 *         → Pattern Analysis → Pattern Memory（证据 M1..M4）
 *         → 新 Knowledge 强化 → 新 Trend 不摧毁旧 Pattern
 *         → Pattern-aware Recall → Inspect → Scene → 语义召回（OpenAI-compatible stub）
 */

import { createServer } from 'node:http'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { MemorySeaService } = await import('../dist/src/service.js')

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const SCOPE = { rootPath: 'C:/work/verify-stage4' }
const NL = String.fromCharCode(10)

function say(line = '') {
  console.log(line)
}
function section(title) {
  say('')
  say(`=== ${title} ===`)
}

function createClock(start = Date.UTC(2026, 10, 2, 9, 0, 0)) {
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
const directory = mkdtempSync(join(tmpdir(), 'memory-sea-verify4-'))
const dbPath = join(directory, 'verify4.db')

const service = new MemorySeaService({
  now: clock.now,
  logger: silentLogger,
  config: {
    enabled: true,
    databasePath: dbPath,
    jobs: { enabled: false, intervalMs: 5000, maxPerTick: 8, staleMs: 60_000, maxAttempts: 3 },
    embedding: { enabled: false },
    pattern: { enabled: true, provider: 'rule', minSupport: 3, activationThreshold: 0.7 },
  },
})

async function settle() {
  for (let i = 0; i < 30; i += 1) {
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

function describePattern(pattern) {
  return [
    `  id=${shortId(pattern.id)} kind=${pattern.kind} status=${pattern.status}`,
    `  confidence=${pattern.confidence.toFixed(3)} support=${pattern.supportCount} contradict=${pattern.contradictionCount}`,
    `  content=${pattern.content}`,
  ].join(NL)
}

/** 三段「避免过早复杂化」的独立决策，供规则式分析器识别出同一模式（spec §15）。 */
const LOW_COMPLEXITY_STATEMENTS = [
  ['讨论 V0.3 架构。', '决定继续用 SQLite，因为简单，也不用额外部署。'],
  ['讨论并发模型。', '决定保持单进程，规模够用时不要过度设计。'],
  ['讨论缓存方案。', '决定省略缓存层，减少复杂度与运维。'],
]

/** 真实 embedding stub：OpenAI-compatible POST /embeddings，把文本映射成 3 维概念向量。 */
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
      response.end(JSON.stringify({ object: 'list', data, model: 'stub-embed', usage: { prompt_tokens: 1, total_tokens: 1 } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function conceptVector(text) {
  const lower = text.toLowerCase()
  if (lower.includes('neo4j') || lower.includes('图数据库') || lower.includes('graph')) return [1, 0, 0]
  if (lower.includes('sqlite') || lower.includes('关系型') || lower.includes('postgres')) return [0, 1, 0]
  if (lower.includes('复杂度') || lower.includes('简单') || lower.includes('部署')) return [0, 0, 1]
  return [0, 0.2, 0.8]
}

try {
  section('A. 形成模式：多条独立决策共同反映「避免过早复杂化」')

  for (const [index, messages] of LOW_COMPLEXITY_STATEMENTS.entries()) {
    await runEpisode(messages, `verify4-low-${index}`)
  }

  const memories = service.listMemories({ includeSuperseded: true }, SCOPE)
  say(`Semantic Memory 数量=${memories.length}`)
  for (const memory of memories) say(`  ${shortId(memory.id)} kind=${memory.kind} ${memory.content}`)

  const patterns = service.listPatterns({ includeSuperseded: true }, SCOPE)
  if (patterns.length !== 1) throw new Error(`三段同向决策应形成 1 条 Pattern，实际 ${patterns.length}`)
  const pattern = patterns[0]
  say(`Pattern：${NL}${describePattern(pattern)}`)

  const supports = service.listPatternEvidence(pattern.id)
  say(`  证据（Pattern → Memory）：`)
  for (const item of supports) {
    const linked = memories.find((memory) => memory.id === item.memoryId)
    say(`    ${item.relation} ${shortId(item.memoryId)} ${linked ? linked.content : ''}`)
  }
  if (supports.length < 3) throw new Error('模式必须由多条 Semantic Memory 支持')
  const memoryIds = new Set(memories.map((memory) => memory.id))
  for (const item of supports) {
    if (!memoryIds.has(item.memoryId)) throw new Error('证据必须指向 Semantic Memory 而不是原始 Experience')
  }
  if (pattern.status === 'candidate') throw new Error('满足 minSupport 与置信度门槛后模式应 active')

  section('B. 强化：新增一条同向知识只增支持数，不新建模式')

  clock.advance(2 * HOUR)
  await runEpisode(['讨论消息队列。', '仍然不上消息队列，避免过度设计，当前够用。'], 'verify4-low-4')

  const afterReinforce = service.listPatterns({ includeSuperseded: true }, SCOPE)
  const reinforced = afterReinforce.find((item) => item.id === pattern.id)
  say(`模式数量=${afterReinforce.length}（不应新增），support=${pattern.supportCount} → ${reinforced.supportCount}`)
  say(`confidence=${pattern.confidence.toFixed(3)} → ${reinforced.confidence.toFixed(3)}`)
  if (afterReinforce.length !== 1) throw new Error('强化不能产生第二条模式')
  if (reinforced.supportCount <= pattern.supportCount) throw new Error('强化后 supportCount 必须上升')

  section('C. 例外不摧毁模式：规模增长后迁移 PostgreSQL，模式仍在')

  clock.advance(3 * HOUR)
  await runEpisode(
    ['数据规模增长后决定迁移 PostgreSQL。', '这次是规模证明有需要之后才升级，不是推翻低复杂度原则。'],
    'verify4-scale',
  )

  const afterTrend = service.listPatterns({ includeSuperseded: true }, SCOPE)
  const survivor = afterTrend.find((item) => item.id === pattern.id)
  say(`模式数量=${afterTrend.length}`)
  for (const item of afterTrend) say(describePattern(item))
  if (!survivor) throw new Error('一次升级不能删除已有模式')
  if (survivor.status === 'superseded') throw new Error('一次例外不足以 supersede 模式')
  const preferencePatterns = afterTrend.filter((item) => item.content.includes('PostgreSQL'))
  say(`「偏好 PostgreSQL」类模式数量=${preferencePatterns.length}（应为 0：偶然事件不得升级成模式）`)
  if (preferencePatterns.length > 0) throw new Error('偶然事件不能直接产生模式')

  section('D. Pattern-aware Recall：模式类问法命中 Pattern，具体问法优先具体知识')

  const patternHits = await service.recall(
    { query: '我们的架构选择一直有什么特点？', limit: 5, expandEpisodes: true },
    SCOPE,
  )
  say('查询：我们的架构选择一直有什么特点？')
  for (const hit of patternHits) {
    say(`  [${hit.type}] score=${hit.score.toFixed(4)} ${hit.content.slice(0, 60)}`)
    say(`    理由：${hit.reasons.map((reason) => `${reason.type}${reason.detail ? ` ${reason.detail}` : ''}`).join('；')}`)
    for (const expanded of hit.expanded ?? []) {
      say(`    展开：${expanded.type} ${expanded.content.slice(0, 40)}`)
    }
  }
  if (patternHits[0]?.type !== 'pattern') throw new Error('模式类问法应让 Pattern 排在第一位')

  const specificHits = await service.recall({ query: '为什么 V0.2 先用 SQLite？', limit: 5 }, SCOPE)
  say('查询：为什么 V0.2 先用 SQLite？')
  for (const hit of specificHits) say(`  [${hit.type}] score=${hit.score.toFixed(4)} ${hit.content.slice(0, 50)}`)
  if (specificHits[0]?.type === 'pattern') throw new Error('具体问法不应被模式压过')
  if (!specificHits.some((hit) => hit.type === 'memory')) throw new Error('具体问法应命中具体 Semantic Memory')

  section('E. 证据链：inspect(pattern) → 支持知识；inspect(memory) → Episode → Experience')

  const patternInspection = service.inspect(pattern.id)
  say(`pattern inspection.type=${patternInspection.type} 证据=${patternInspection.evidence.length}`)
  say(`  支持知识：${(patternInspection.memories ?? []).map((memory) => shortId(memory.id)).join(', ')}`)
  const firstMemory = (patternInspection.memories ?? [])[0]
  if (!firstMemory) throw new Error('Pattern 必须能下钻到支持它的 Memory')
  const memoryInspection = service.inspect(firstMemory.id)
  say(`memory inspection.type=${memoryInspection.type}`)
  say(`  Episode：${memoryInspection.episodes.map((episode) => shortId(episode.id)).join(', ')}`)
  say(`  原始 Experience：${memoryInspection.experiences.map((item) => shortId(item.id)).join(', ')}`)
  if (memoryInspection.experiences.length === 0) throw new Error('Memory 必须能下钻到原始 Experience')

  section('F. Scene：四类节点 + 带 reason 的证据边（legacy 契约不变）')

  const scene = service.getScene(SCOPE)
  const byType = {}
  for (const point of scene.points) byType[point.type] = (byType[point.type] ?? 0) + 1
  say(`points=${scene.points.length} edges=${scene.edges.length} types=${JSON.stringify(byType)}`)
  say(`stats=${JSON.stringify(scene.stats)}`)
  const patternPoint = scene.points.find((point) => point.type === 'pattern')
  say(`pattern 节点 size=${patternPoint?.size} support=${patternPoint?.supportCount} stability=${patternPoint?.stabilityScore}`)
  const patternEdges = scene.edges.filter((edge) => edge.kind === 'supported_by' || edge.kind === 'contradicted_by')
  say(`模式边=${patternEdges.length}，示例 kind=${patternEdges[0]?.kind} reason=${patternEdges[0]?.reason ?? '(无)'}`)
  for (const edge of patternEdges) {
    if (!edge.reason) throw new Error('模式边必须带 reason')
  }
  for (const type of ['experience', 'episode', 'memory', 'pattern']) {
    if (!byType[type]) throw new Error(`Scene 缺少 ${type} 节点`)
  }

  const legacy = service.getLegacyScene(SCOPE)
  const legacyPattern = legacy.points.find((point) => point.id === patternPoint?.id)
  say(`legacy ok=${legacy.ok} patternPoint.kind=${legacyPattern?.kind} topic=${legacyPattern?.topic} cluster=${legacyPattern?.cluster}`)
  if (!legacy.ok) throw new Error('legacy scene 必须保持 ok:true')

  section('G. 真实向量通道：OpenAI-compatible stub /embeddings 下的语义召回')

  const stub = await startEmbeddingStub()
  const semanticDirectory = mkdtempSync(join(tmpdir(), 'memory-sea-verify4-embed-'))
  const semanticDbPath = join(semanticDirectory, 'verify4-embed.db')
  const semanticClock = createClock(Date.UTC(2026, 10, 5, 9, 0, 0))
  const semanticService = new MemorySeaService({
    now: semanticClock.now,
    logger: silentLogger,
    config: {
      enabled: true,
      databasePath: semanticDbPath,
      jobs: { enabled: false, intervalMs: 5000, maxPerTick: 8, staleMs: 60_000, maxAttempts: 3 },
      pattern: { enabled: false },
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
  try {
    let episodeId = ''
    for (const content of ['讨论图数据库选型。', '决定暂时不上 Neo4j。']) {
      episodeId = semanticService.capture({ content, sessionId: 'verify4-semantic' }, SCOPE).episode.id
    }
    semanticClock.advance(30 * MINUTE)
    semanticService.runMaintenance()
    for (let i = 0; i < 30; i += 1) {
      await semanticService.drainJobs()
      if (semanticService.status(SCOPE).jobs.pending === 0) break
    }
    const embedding = semanticService.status(SCOPE).embedding
    say(`embedding=${JSON.stringify(embedding)} episode=${shortId(episodeId)}`)

    const semanticHits = await semanticService.recall({ query: '为什么没有直接采用图数据库？', limit: 5 }, SCOPE)
    for (const hit of semanticHits) {
      say(`  [${hit.type}] score=${hit.score.toFixed(4)} ${hit.content.slice(0, 40)}`)
      say(`    理由：${hit.reasons.map((reason) => `${reason.type}${reason.detail ? ` ${reason.detail}` : ''}`).join('；')}`)
    }
    const semanticHit = semanticHits.find((hit) => hit.type === 'memory' || hit.type === 'episode')
    if (!semanticHit) throw new Error('语义改写问法必须命中记忆')
    const semanticReason = semanticHit.reasons.find((reason) => reason.type === 'semantic')
    if (!semanticReason) throw new Error('语义召回必须给出 semantic 理由')
    say(`  semantic 通道贡献：score=${semanticReason.score ?? '-'} detail=${semanticReason.detail ?? '-'}`)
  } finally {
    semanticService.closeSync()
    await stub.close()
    rmSync(semanticDirectory, { recursive: true, force: true })
  }

  section('H. 性能与体量')

  const captureStart = Date.now()
  const captureCount = 200
  for (let i = 0; i < captureCount; i += 1) {
    service.capture({ content: `性能测试第 ${i} 条：记录一次关于 SQLite 与 PostgreSQL 的讨论。`, sessionId: 'perf4' }, SCOPE)
  }
  const captureElapsed = Date.now() - captureStart
  say(`capture ${captureCount} 条 = ${captureElapsed} ms（平均 ${(captureElapsed / captureCount).toFixed(2)} ms/条）`)

  const recallStart = Date.now()
  const recallCount = 30
  for (let i = 0; i < recallCount; i += 1) {
    await service.recall({ query: 'SQLite PostgreSQL 架构倾向', limit: 8 }, SCOPE)
  }
  const recallElapsed = Date.now() - recallStart
  say(`recall ${recallCount} 次 = ${recallElapsed} ms（平均 ${(recallElapsed / recallCount).toFixed(2)} ms/次）`)

  await settle()
  const status = service.status(SCOPE)
  say(`status: experiences=${status.experiences} episodes=${status.episodes} memories=${JSON.stringify(status.memories)}`)
  say(`patterns=${JSON.stringify(status.patterns)} review=${JSON.stringify(status.review)} consolidation=${JSON.stringify(status.consolidation)}`)
  say(`jobs=${JSON.stringify(status.jobs)} fts=${status.fts} embedding=${JSON.stringify(status.embedding)}`)
  const sizeMb = (statSync(dbPath).size / (1024 * 1024)).toFixed(2)
  say(`数据库大小 = ${sizeMb} MB`)

  section('I. 结论')
  say('Stage 4 认知闭环成立：经历 → Episode → Memory → Pattern（多证据）→ 强化 → 例外不摧毁 → 可解释召回 → 证据链 → Scene。')
  say('VERIFY STAGE 4 DONE')
} finally {
  service.closeSync()
  rmSync(directory, { recursive: true, force: true })
}
