/**
 * tests/stage4.test.ts —— Stage 4 验收（spec §61–§76 十六项）。
 *
 * 与 Stage 3 测试同样的口径：真实 SQLite + FTS5（临时库）、可控时钟、关掉后台定时器后手动 drainJobs()。
 * 这里额外验证「模式」不是「另一份记忆」：数量必须远少于 Memory，且证据必须可回溯。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestService, MINUTE, HOUR, DAY, type TestService } from './helpers.js'
import type { MemorySeaConfig } from '../src/config.js'
import type { MemorySeaService } from '../src/service.js'
import { MemoryDatabase } from '../src/storage/database.js'
import { MemoryRepository } from '../src/memory/memory-repository.js'
import { PatternRepository } from '../src/pattern/pattern-repository.js'
import { PatternEvidenceRepository } from '../src/pattern/pattern-evidence-repository.js'
import { PatternApplier } from '../src/pattern-analysis/pattern-applier.js'

const JOBS_OFF: Partial<MemorySeaConfig> = {
  jobs: { enabled: false, intervalMs: 2000, maxPerTick: 8, staleMs: 60_000, maxAttempts: 3 },
}

const SCOPE = { rootPath: 'C:/work/stage4' }

/** 手动把队列抽干（摘要 → 整理 → 模式分析 → 复核 会依次排队）。 */
async function settle(service: MemorySeaService, scope = SCOPE): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await service.drainJobs()
    if (service.status(scope).jobs.pending === 0) return
  }
}

/** 写入一组连续消息 → idle 关闭 → 摘要 → 整理 → 模式分析。 */
async function runEpisode(
  harness: TestService,
  messages: readonly string[],
  sessionId: string,
  scope = SCOPE,
): Promise<string> {
  let episodeId = ''
  for (const content of messages) {
    episodeId = harness.service.capture({ content, sessionId }, scope).episode.id
  }
  harness.clock.advance(30 * MINUTE)
  harness.service.runMaintenance()
  await settle(harness.service, scope)
  return episodeId
}

/** 三条「避免过早复杂化」的独立决策 → 应该被抽象成同一个模式。 */
const LOW_COMPLEXITY_STATEMENTS: readonly (readonly string[])[] = [
  ['讨论 V0.3 架构。', '决定继续用 SQLite，因为简单，也不用额外部署。'],
  ['讨论并发模型。', '决定保持单进程，规模够用时不要过度设计。'],
  ['讨论缓存方案。', '决定省略缓存层，减少复杂度与运维。'],
]

async function buildLowComplexityMemories(harness: TestService, scope = SCOPE): Promise<void> {
  let index = 0
  for (const messages of LOW_COMPLEXITY_STATEMENTS) {
    index += 1
    await runEpisode(harness, messages, `s-low-${index}`, scope)
  }
}

test('模式创建：多条独立决策共同反映「避免过早复杂化」，证据包含支持它的知识', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    await buildLowComplexityMemories(harness)

    const patterns = harness.service.listPatterns({ includeSuperseded: true }, SCOPE)
    assert.equal(patterns.length, 1, '多条独立知识应该收敛成一个模式，而不是每种说法一个')
    const pattern = patterns[0]
    assert.ok(pattern)
    assert.equal(pattern.status, 'active')
    assert.equal(pattern.kind, 'recurring_decision')
    assert.ok(pattern.supportCount >= 3, `支持数应该 >= 3，实际 ${pattern.supportCount}`)
    assert.ok(pattern.confidence >= 0.7 && pattern.confidence <= 1)
    assert.ok(pattern.firstObservedAt > 0 && pattern.lastObservedAt >= pattern.firstObservedAt)

    const evidence = harness.service.listPatternEvidence(pattern.id)
    const supports = evidence.filter((item) => item.relation === 'supports')
    assert.ok(supports.length >= 3, '模式必须有多个 Semantic Memory 作证据')
    // 证据指向 Memory 而不是原始 Experience（spec §7）。
    const memories = harness.service.listMemories({ includeSuperseded: true }, SCOPE)
    const memoryIds = new Set(memories.map((memory) => memory.id))
    for (const item of supports) assert.ok(memoryIds.has(item.memoryId))
  } finally {
    harness.cleanup()
  }
})

test('证据不足不创建：只有两条相关知识时不产生 active 模式', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    await runEpisode(harness, ['决定继续用 SQLite，因为简单、不用额外部署。'], 's-two-1')
    await runEpisode(harness, ['先保持单进程，当前规模够用，不要过度设计。'], 's-two-2')

    const patterns = harness.service.listPatterns({ includeSuperseded: true }, SCOPE)
    assert.equal(patterns.length, 0, '两条知识不足以declare反复出现的模式')
  } finally {
    harness.cleanup()
  }
})

test('模式强化：新增一条同向知识只增加支持数与证据，不新建第二个模式', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    await buildLowComplexityMemories(harness)
    const before = harness.service.listPatterns({ includeSuperseded: true }, SCOPE)
    assert.equal(before.length, 1)
    const original = before[0]
    assert.ok(original)

    harness.clock.advance(2 * HOUR)
    await runEpisode(harness, ['讨论消息队列。', '仍然不上消息队列，避免过度设计，当前够用。'], 's-low-4')

    const after = harness.service.listPatterns({ includeSuperseded: true }, SCOPE)
    assert.equal(after.length, 1, '强化不能产生第二个模式')
    const reinforced = after[0]
    assert.ok(reinforced)
    assert.equal(reinforced.id, original.id)
    assert.ok(reinforced.supportCount > original.supportCount, '支持数应该上升')
    assert.ok(reinforced.confidence >= original.confidence, '置信度不该下降')
    assert.ok(reinforced.lastObservedAt >= original.lastObservedAt)
  } finally {
    harness.cleanup()
  }
})

test('模式弱化（applier 语义）：一次反证只降置信度并记录矛盾，不推翻、不取代', () => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-sea-stage4-weaken-'))
  const db = MemoryDatabase.open(join(directory, 'p.db'))
  try {
    const now = Date.UTC(2026, 2, 3, 9, 0, 0)
    const memories = new MemoryRepository({ db, now: () => now })
    const patterns = new PatternRepository({ db, now: () => now })
    const evidence = new PatternEvidenceRepository({ db, now: () => now })
    const applier = new PatternApplier({ db, patterns, evidence, now: () => now, minSupport: 3, activationThreshold: 0.7 })
    const scopeId = 'project_stage4_weaken'

    const supporters = [
      memories.create({ scopeId, kind: 'decision', confidence: 0.8, importance: 0.6, content: '偏好本地部署，数据留在自己机器上。' }),
      memories.create({ scopeId, kind: 'decision', confidence: 0.8, importance: 0.6, content: '继续本地部署，不引入外部托管服务。' }),
      memories.create({ scopeId, kind: 'decision', confidence: 0.8, importance: 0.6, content: '本地部署更简单，暂时不需要云。' }),
    ]
    const pattern = patterns.create({
      scopeId,
      kind: 'principle',
      content: '该项目长期偏好本地部署。',
      confidence: 0.8,
      importance: 0.6,
      supportCount: supporters.length,
      status: 'active',
      firstObservedAt: now,
      lastObservedAt: now,
    })
    for (const memory of supporters) evidence.insert({ patternId: pattern.id, memoryId: memory.id, relation: 'supports' })
    const outlier = memories.create({
      scopeId,
      kind: 'decision',
      confidence: 0.7,
      importance: 0.6,
      content: '这一次明确选择托管数据库。',
    })

    const applied = applier.apply(
      { scopeId, triggerMemory: outlier, relatedMemories: [outlier, ...supporters], existingPatterns: [pattern] },
      { operations: [{ type: 'weaken', patternId: pattern.id, contradictingMemoryIds: [outlier.id], confidenceDelta: 0.1 }] },
    )

    assert.equal(applied.weakened.length, 1)
    const weakened = patterns.getById(pattern.id)
    assert.ok(weakened)
    assert.equal(weakened.status, 'active', '一次例外不足以让模式失效')
    assert.equal(weakened.contradictionCount, 1, '反证必须被记录')
    assert.ok(weakened.confidence < pattern.confidence, '反证应该降低置信度')
    assert.equal(weakened.supersededBy, undefined, '不能用 supersede 处理一次例外')
    const relations = evidence.listByPattern(pattern.id).filter((item) => item.relation === 'contradicts')
    assert.equal(relations.length, 1)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('模式取代（applier 语义）：先立后废，旧模式保留历史链', () => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-sea-stage4-supersede-'))
  const db = MemoryDatabase.open(join(directory, 'p.db'))
  try {
    const now = Date.UTC(2026, 2, 1, 9, 0, 0)
    const memories = new MemoryRepository({ db, now: () => now })
    const patterns = new PatternRepository({ db, now: () => now })
    const evidence = new PatternEvidenceRepository({ db, now: () => now })
    const applier = new PatternApplier({ db, patterns, evidence, now: () => now, minSupport: 3, activationThreshold: 0.7 })
    const scopeId = 'project_stage4_supersede'

    const supporters = [
      memories.create({ scopeId, kind: 'decision', confidence: 0.8, importance: 0.6, content: '偏好本地部署，数据留在自己机器上。' }),
      memories.create({ scopeId, kind: 'decision', confidence: 0.8, importance: 0.6, content: '继续本地部署，不引入外部托管服务。' }),
      memories.create({ scopeId, kind: 'decision', confidence: 0.8, importance: 0.6, content: '本地部署更简单，暂时不需要云。' }),
    ]
    const old = patterns.create({
      scopeId,
      kind: 'principle',
      content: '该项目长期偏好本地部署。',
      confidence: 0.8,
      importance: 0.6,
      supportCount: supporters.length,
      status: 'active',
      firstObservedAt: now,
      lastObservedAt: now,
    })
    for (const memory of supporters) evidence.insert({ patternId: old.id, memoryId: memory.id, relation: 'supports' })

    const applied = applier.apply(
      { scopeId, triggerMemory: supporters[0]!, relatedMemories: supporters, existingPatterns: [old] },
      {
        operations: [
          {
            type: 'supersede',
            patternId: old.id,
            kind: 'trend',
            content: '该项目已转向全面采用托管云服务。',
            confidence: 0.75,
            importance: 0.7,
            supportingMemoryIds: [supporters[0]!.id, supporters[1]!.id],
          },
        ],
      },
    )

    assert.equal(applied.superseded.length, 1)
    const superseded = patterns.getById(old.id)
    assert.ok(superseded)
    assert.equal(superseded.status, 'superseded')
    assert.ok(superseded.supersededBy)
    const created = patterns.getById(superseded.supersededBy)
    assert.ok(created)
    assert.equal(created.status, 'active')
    // 旧模式的支持证据仍然保留，历史可查（spec §21 / §90「History before deletion」）。
    assert.ok(evidence.listByPattern(old.id).length >= 3)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('模式幂等：同一个 PatternApplyResult 重复应用不会重复增长支持数或证据', () => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-sea-stage4-idem-'))
  const db = MemoryDatabase.open(join(directory, 'p.db'))
  try {
    const now = Date.UTC(2026, 2, 2, 9, 0, 0)
    const memories = new MemoryRepository({ db, now: () => now })
    const patterns = new PatternRepository({ db, now: () => now })
    const evidence = new PatternEvidenceRepository({ db, now: () => now })
    const applier = new PatternApplier({ db, patterns, evidence, now: () => now, minSupport: 3, activationThreshold: 0.7 })
    const scopeId = 'project_stage4_idem'

    const supporters = [
      memories.create({ scopeId, kind: 'decision', confidence: 0.8, importance: 0.6, content: '先用 SQLite，简单、不用额外部署。' }),
      memories.create({ scopeId, kind: 'decision', confidence: 0.8, importance: 0.6, content: '保持单进程，当前规模够用。' }),
      memories.create({ scopeId, kind: 'decision', confidence: 0.8, importance: 0.6, content: '避免复杂度，暂时不上额外组件。' }),
    ]
    const context = { scopeId, triggerMemory: supporters[0]!, relatedMemories: supporters, existingPatterns: [] }
    const result = {
      operations: [
        {
          type: 'create' as const,
          kind: 'recurring_decision' as const,
          content: '该项目在早期架构决策中持续倾向避免过早引入额外基础设施。',
          confidence: 0.78,
          importance: 0.6,
          supportingMemoryIds: supporters.map((memory) => memory.id),
        },
      ],
    }

    applier.apply(context, result)
    const first = patterns.list(scopeId)
    assert.equal(first.length, 1)
    const snapshot = first[0]!
    const evidenceCount = evidence.listByPattern(snapshot.id).length

    const second = applier.apply(context, result)
    const third = applier.apply(context, result)
    const after = patterns.list(scopeId)
    assert.equal(after.length, 1, '重复分析不能让模式数量增长')
    assert.equal(after[0]!.supportCount, snapshot.supportCount, '支持数不能重复累加')
    assert.equal(evidence.listByPattern(snapshot.id).length, evidenceCount, '证据不能重复写入')
    assert.ok(second.skipped + third.skipped >= 1, '重复操作应被识别并跳过，而不是再强化一次')
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Scope 隔离：Project A 的模式不会出现在 Project B', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    const scopeA = { rootPath: 'C:/work/stage4-a' }
    const scopeB = { rootPath: 'C:/work/stage4-b' }

    await buildLowComplexityMemories(harness, scopeA)
    harness.clock.advance(DAY)
    await runEpisode(harness, ['讨论云方案。', '决定全面采用托管云服务，接受运维成本。'], 's-b-1', scopeB)
    harness.clock.advance(30 * MINUTE)
    await runEpisode(harness, ['讨论云方案二。', '继续采用托管云数据库，弹性优先。'], 's-b-2', scopeB)
    harness.clock.advance(30 * MINUTE)
    await runEpisode(harness, ['讨论云方案三。', '还是用托管云服务，不再自己维护。'], 's-b-3', scopeB)

    const patternsA = harness.service.listPatterns({ includeSuperseded: true }, scopeA)
    const patternsB = harness.service.listPatterns({ includeSuperseded: true }, scopeB)
    assert.equal(patternsA.length, 1)
    assert.ok(patternsA[0]!.content.includes('避免') || patternsA[0]!.content.includes('基础设施'))
    for (const pattern of patternsB) assert.notEqual(pattern.id, patternsA[0]!.id)

    const memoriesB = harness.service.listMemories({ includeSuperseded: true }, scopeB)
    assert.ok(memoriesB.length >= 1)
    for (const pattern of patternsB) assert.equal(pattern.scopeId, harness.service.status(scopeB).scope.id)
  } finally {
    harness.cleanup()
  }
})

test('没有 embedding 时：模式创建与复核照常工作（embedding 只是增强项）', async () => {
  const harness = createTestService({
    config: { ...JOBS_OFF, embedding: { enabled: false }, pattern: { enabled: true, provider: 'rule', minSupport: 3, activationThreshold: 0.7, maxRelatedMemories: 12, maxExistingPatterns: 8, confidenceDecayOnContradiction: 0.1 } },
  })
  try {
    await buildLowComplexityMemories(harness)
    const status = harness.service.status(SCOPE)
    assert.equal(status.embedding.available, false)
    assert.equal(status.patterns.active + status.patterns.candidate >= 1, true)
    const patterns = harness.service.listPatterns({ includeSuperseded: true }, SCOPE)
    assert.equal(patterns.length, 1)
    assert.equal(patterns[0]!.embeddingStatus, 'disabled')
  } finally {
    harness.cleanup()
  }
})

test('真实语义召回：OpenAI-compatible embedding 下，改写过的问法仍能命中', async () => {
  const server = await startEmbeddingStub()
  const harness = createTestService({
    config: {
      ...JOBS_OFF,
      embedding: { enabled: true, provider: 'openai-compatible', model: 'stub-embed', apiKey: 'test-key', baseUrl: server.url, dimensions: 3 },
    },
  })
  try {
    await runEpisode(harness, ['讨论图数据库。', '决定暂时不上 Neo4j。'], 's-semantic')
    const status = harness.service.status(SCOPE)
    assert.equal(status.embedding.available, true)
    assert.equal(status.embedding.provider, 'openai-compatible')

    const hits = await harness.service.recall(
      { query: '为什么没有直接采用图数据库？', types: ['memory'] },
      SCOPE,
    )
    assert.ok(hits.length >= 1, '改写过的问法也应该命中语义知识')
    const semantic = hits.some((hit) => hit.reasons.some((reason) => reason.type === 'semantic'))
    assert.equal(semantic, true, '命中理由里必须能看见语义通道的贡献')
  } finally {
    harness.cleanup()
    await server.close()
  }
})

test('模式召回：问「一直有什么倾向」时 Pattern 排在最前面', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    await buildLowComplexityMemories(harness)
    const hits = await harness.service.recall({ query: '我们的架构选择一直有什么倾向？', limit: 5 }, SCOPE)
    assert.ok(hits.length >= 1)
    assert.equal(hits[0]!.type, 'pattern')
    const reasons = hits[0]!.reasons.map((reason) => reason.type)
    assert.ok(reasons.includes('support') || reasons.includes('stability'), '模式命中要能解释支持度/稳定度')
  } finally {
    harness.cleanup()
  }
})

test('具体问题优先具体知识：问「为什么 V0.2 没上 Neo4j」时 Memory 排在 Pattern 前面', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    await runEpisode(harness, ['讨论存储选型。', '决定 V0.2 先用 SQLite，不上 Neo4j。'], 's-neo-1')
    await runEpisode(harness, ['再次确认选型。', '继续用 SQLite，图数据库暂时不引入。'], 's-neo-2')
    await runEpisode(harness, ['讨论复杂度。', '保持简单，够用就好，避免过度设计。'], 's-neo-3')

    const hits = await harness.service.recall({ query: '为什么 V0.2 没上 Neo4j？', limit: 5 }, SCOPE)
    assert.ok(hits.length >= 1)
    assert.notEqual(hits[0]!.type, 'pattern', '具体问题不该被抽象模式压过去')
  } finally {
    harness.cleanup()
  }
})

test('证据下钻：inspect(pattern) → 支持知识；再 inspect(memory) → Episode → 原始 Experience', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    await buildLowComplexityMemories(harness)
    const pattern = harness.service.listPatterns({ includeSuperseded: true }, SCOPE)[0]
    assert.ok(pattern)

    const patternInspection = harness.service.inspect(pattern.id)
    assert.ok(patternInspection)
    assert.equal(patternInspection.type, 'pattern')
    assert.equal(patternInspection.pattern?.id, pattern.id)
    assert.ok((patternInspection.patternEvidence ?? []).length >= 3)
    const supporting = patternInspection.memories ?? []
    assert.ok(supporting.length >= 1, '应该能展开支持这条模式的知识')
    assert.ok((patternInspection.episodes ?? []).length >= 1)
    assert.ok((patternInspection.experiences ?? []).length >= 1)

    const memoryInspection = harness.service.inspect(supporting[0]!.id)
    assert.ok(memoryInspection)
    assert.equal(memoryInspection.type, 'memory')
    assert.ok((memoryInspection.episodes ?? []).length >= 1)
    assert.ok((memoryInspection.experiences ?? []).length >= 1)
  } finally {
    harness.cleanup()
  }
})

test('旧知识变陈旧：很久没被强化且置信度低时标 stale，但数据保留', async () => {
  const harness = createTestService({
    config: {
      ...JOBS_OFF,
      review: { enabled: true, intervalMs: 6 * HOUR, memoryStaleAfterMs: 30 * MINUTE, patternStaleAfterMs: 90 * DAY, maxItemsPerRun: 50, memoryStaleConfidence: 0.95 },
    },
  })
  try {
    await runEpisode(harness, ['讨论选型。', '决定先用 SQLite，简单、不用额外部署。'], 's-stale')
    harness.clock.advance(2 * HOUR)
    harness.service.runMaintenance()
    await settle(harness.service)

    const memories = harness.service.listMemories({ includeSuperseded: true }, SCOPE)
    assert.ok(memories.length >= 1)
    // 低置信度 + 久未强化 → 应该被标记 stale（不删除）。
    assert.ok(memories.some((memory) => memory.status === 'stale'), '久未验证的低置信度知识应被标记 stale')
    const stale = memories.find((memory) => memory.status === 'stale')!
    assert.equal(harness.service.getMemory(stale.id)?.content, stale.content)
    assert.ok(harness.service.listMemoryEvidence(stale.id).length >= 1, '标 stale 不能丢证据')
  } finally {
    harness.cleanup()
  }
})

test('最近刚被强化过的知识不会被标 stale', async () => {
  const harness = createTestService({
    config: {
      ...JOBS_OFF,
      review: { enabled: true, intervalMs: 6 * HOUR, memoryStaleAfterMs: 30 * MINUTE, patternStaleAfterMs: 90 * DAY, maxItemsPerRun: 50, memoryStaleConfidence: 0.95 },
    },
  })
  try {
    await runEpisode(harness, ['讨论选型。', '决定先用 SQLite，简单、不用额外部署。'], 's-fresh-1')

    // 只过去 5 分钟，远小于 stale 阈值：即使置信度低于阈值也不该被标 stale。
    harness.clock.advance(5 * MINUTE)
    harness.service.runMaintenance()
    await settle(harness.service)

    const memories = harness.service.listMemories({ includeSuperseded: true }, SCOPE)
    const alive = memories.filter((memory) => memory.status === 'active')
    assert.ok(alive.length >= 1, '最近产生/被强化的知识必须保持 active')
    assert.equal(harness.service.status(SCOPE).review.dueMemories, 0, '刚强化的知识不该进入复核队列')
  } finally {
    harness.cleanup()
  }
})

test('Scene：四类节点与带 reason 的证据边同时存在，legacy 契约不变', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    await buildLowComplexityMemories(harness)

    const scene = harness.service.getScene(SCOPE)
    const types = new Set(scene.points.map((point) => point.type))
    assert.ok(types.has('experience'))
    assert.ok(types.has('episode'))
    assert.ok(types.has('memory'))
    assert.ok(types.has('pattern'))
    assert.equal(scene.stats.patterns, 1)

    const patternPoint = scene.points.find((point) => point.type === 'pattern')
    assert.ok(patternPoint)
    assert.ok(Number.isFinite(patternPoint.x) && Number.isFinite(patternPoint.y) && Number.isFinite(patternPoint.z))
    assert.ok(patternPoint.supportCount !== undefined && patternPoint.supportCount >= 3)
    assert.ok(patternPoint.stabilityScore !== undefined)

    const evidenceEdges = scene.edges.filter((edge) => edge.kind === 'supported_by' || edge.kind === 'contradicted_by')
    assert.ok(evidenceEdges.length >= 1, '模式与支持知识之间必须有边')
    for (const edge of evidenceEdges) assert.ok(typeof edge.reason === 'string' && edge.reason.length > 0, '证据边必须带原因')

    // 坐标必须稳定：两次构建完全一致（刷新不跳动）。
    const again = harness.service.getScene(SCOPE)
    assert.deepEqual(
      again.points.map((point) => [point.id, point.x, point.y, point.z]),
      scene.points.map((point) => [point.id, point.x, point.y, point.z]),
    )

    const legacy = harness.service.getLegacyScene(SCOPE)
    assert.equal(legacy.ok, true)
    const legacyPattern = legacy.points.find((point) => point.topic === 'pattern')
    assert.ok(legacyPattern)
    assert.equal(legacyPattern.kind, 'conclusion')
  } finally {
    harness.cleanup()
  }
})

test('端到端：Experiences → Episodes → Memories → Pattern → 强化 → 召回 → inspect → Scene', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    await buildLowComplexityMemories(harness)

    const status = harness.service.status(SCOPE)
    assert.equal(status.experiences >= 6, true)
    assert.equal(status.episodes >= 3, true)
    assert.equal(status.memories.active >= 3, true)
    assert.equal(status.patterns.active, 1)
    assert.equal(status.review.dueMemories >= 0, true)
    assert.equal(status.jobs.failed, 0)

    const hits = await harness.service.recall(
      { query: '为什么我们一直倾向简单方案？', expandEpisodes: true, limit: 5 },
      SCOPE,
    )
    assert.ok(hits.length >= 1)
    assert.equal(hits[0]!.type, 'pattern')
    assert.ok((hits[0]!.expanded ?? []).length >= 1, '模式命中应该能展开支持知识与证据 Episode')

    const patterns = harness.service.listPatterns({ includeSuperseded: true }, SCOPE)
    const inspection = harness.service.inspect(patterns[0]!.id)
    assert.equal(inspection?.type, 'pattern')

    const scene = harness.service.getScene(SCOPE)
    assert.ok(scene.points.some((point) => point.type === 'pattern'))
    assert.equal(harness.service.getLegacyScene(SCOPE).ok, true)
  } finally {
    harness.cleanup()
  }
})

/**
 * 一个最小的 OpenAI-compatible /embeddings 端点。
 * 关键词映射成 3 维向量：图数据库 / Neo4j → [1,0,0]，SQLite → [0,1,0]，其它 → [0,0,1]。
 * 这样「为什么没有直接采用图数据库？」与「Neo4j 暂时不上」在语义通道上必然相近。
 */
async function startEmbeddingStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/embeddings')) {
      res.writeHead(404).end('not found')
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
    })
    req.on('end', () => {
      let inputs: string[] = []
      try {
        const parsed = JSON.parse(body) as { input?: string | string[] }
        inputs = Array.isArray(parsed.input) ? parsed.input : typeof parsed.input === 'string' ? [parsed.input] : []
      } catch {
        inputs = []
      }
      const data = inputs.map((text, index) => ({ object: 'embedding', index, embedding: stubVector(text) }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data, model: 'stub-embed' }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

function stubVector(text: string): number[] {
  const value = text.toLowerCase()
  if (value.includes('neo4j') || value.includes('图数据库') || value.includes('graph')) return [1, 0, 0]
  if (value.includes('sqlite') || value.includes('关系型')) return [0, 1, 0]
  return [0, 0, 1]
}
