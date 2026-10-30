/**
 * tests/recall.test.ts —— 可解释召回（spec §11 / §22）。
 *
 * 覆盖：关键词召回 Experience / Episode、before-after 过滤、embedding 关闭仍可用、reasons 完整。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTestService, MINUTE, HOUR } from './helpers.js'
import type { MemorySeaService } from '../src/service.js'
import type { TestClock } from './helpers.js'

const chat = { sourceType: 'chat' as const, role: 'user' as const }
const ALLOWED_REASON_TYPES = new Set(['keyword', 'semantic', 'temporal', 'importance', 'session'])

async function seedThreeExperiences(service: MemorySeaService, clock: TestClock) {
  const first = service.capture({ ...chat, sessionId: 's1', content: '今天研究 Memory Sea。' })
  clock.advance(MINUTE)
  const key = service.capture({ ...chat, sessionId: 's1', content: '决定 V0.2 先用 SQLite，因为本地优先且零运维。' })
  clock.advance(MINUTE)
  const third = service.capture({ ...chat, sessionId: 's1', content: 'Neo4j 后面再上，这一版先不上图数据库。' })
  return { first, key, third }
}

test('关键词能召回正确的 Experience，并给出关键词理由', async () => {
  const { service, clock, cleanup } = createTestService()
  try {
    const { key } = await seedThreeExperiences(service, clock)
    const hits = await service.recall({ query: 'SQLite' })

    assert.ok(hits.length > 0)
    const hit = hits.find((item) => item.id === key.experience.id)
    assert.ok(hit, '应召回包含 SQLite 的那条 Experience')
    assert.equal(hit.type, 'experience')
    assert.ok(hit.score > 0 && hit.score <= 1)
    assert.ok(hit.reasons.some((reason) => reason.type === 'keyword'))
    assert.ok(hit.reasons.some((reason) => reason.type === 'importance'))
    assert.ok(hit.content.includes('SQLite'))
  } finally {
    cleanup()
  }
})

test('关键词能召回正确的 Episode', async () => {
  const { service, clock, cleanup } = createTestService()
  try {
    const { first } = await seedThreeExperiences(service, clock)
    const hits = await service.recall({ query: 'Memory Sea', types: ['episode'] })

    assert.ok(hits.length > 0)
    assert.ok(hits.every((hit) => hit.type === 'episode'))
    assert.ok(hits.some((hit) => hit.id === first.episode.id))
  } finally {
    cleanup()
  }
})

test('before / after 时间窗口正确过滤', async () => {
  const { service, clock, cleanup } = createTestService()
  try {
    const start = clock.now
    const early = service.capture({ ...chat, sessionId: 's1', content: '早上讨论 SQLite 选型。' })
    clock.advance(2 * HOUR)
    const late = service.capture({ ...chat, sessionId: 's2', content: '下午复盘 SQLite 的写入性能。' })
    const middle = start + HOUR

    const afterHits = await service.recall({ query: 'SQLite', after: middle })
    assert.ok(afterHits.length > 0)
    assert.ok(afterHits.every((hit) => hit.createdAt > middle))
    assert.ok(afterHits.some((hit) => hit.id === late.experience.id))
    assert.ok(!afterHits.some((hit) => hit.id === early.experience.id))

    const beforeHits = await service.recall({ query: 'SQLite', before: middle })
    assert.ok(beforeHits.length > 0)
    assert.ok(beforeHits.every((hit) => hit.createdAt < middle))
    assert.ok(beforeHits.some((hit) => hit.id === early.experience.id))
    assert.ok(!beforeHits.some((hit) => hit.id === late.experience.id))

    // 时间窗口命中时，理由里应出现时间说明
    const windowed = await service.recall({ query: 'SQLite', after: middle, types: ['experience'] })
    const windowHit = windowed.find((hit) => hit.id === late.experience.id)
    assert.ok(windowHit)
    assert.ok(windowHit.reasons.some((reason) => reason.type === 'temporal'))
  } finally {
    cleanup()
  }
})

test('embedding 关闭时 Recall 仍然工作，权重自动重新归一化', async () => {
  const { service, clock, cleanup } = createTestService()
  try {
    await seedThreeExperiences(service, clock)
    const status = service.status()
    assert.equal(status.embedding.available, false)

    const detailed = await service.recallDetailed({ query: 'SQLite' })
    assert.equal(detailed.weights.semanticAvailable, false)
    assert.equal(detailed.weights.semantic, 0)
    assert.equal(detailed.weights.renormalized, true)
    // 其余四路权重归一化后和为 1
    const sum =
      detailed.weights.lexical +
      detailed.weights.semantic +
      detailed.weights.temporal +
      detailed.weights.importance +
      detailed.weights.recency
    assert.ok(Math.abs(sum - 1) < 1e-9)
    assert.ok(detailed.hits.length > 0)
    // 每一条命中的分数仍然落在 0..1
    for (const hit of detailed.hits) assert.ok(hit.score >= 0 && hit.score <= 1)
  } finally {
    cleanup()
  }
})

test('所有 RecallHit 都带 reasons，且类型合法', async () => {
  const { service, clock, cleanup } = createTestService()
  try {
    await seedThreeExperiences(service, clock)
    const hits = await service.recall({ query: 'Memory Sea SQLite Neo4j', limit: 5 })

    assert.ok(hits.length > 0)
    for (const hit of hits) {
      assert.ok(Array.isArray(hit.reasons) && hit.reasons.length > 0, '每条命中都必须可解释')
      for (const reason of hit.reasons) {
        assert.ok(ALLOWED_REASON_TYPES.has(reason.type), `非法 reason 类型：${reason.type}`)
      }
      if (hit.type === 'experience') {
        assert.ok(hit.reasons.some((reason) => reason.type === 'temporal'))
      }
    }
  } finally {
    cleanup()
  }
})

test('limit 生效，空查询返回空数组', async () => {
  const { service, clock, cleanup } = createTestService()
  try {
    await seedThreeExperiences(service, clock)
    const limited = await service.recall({ query: 'SQLite', limit: 1 })
    assert.equal(limited.length, 1)

    assert.deepEqual(await service.recall({ query: '   ' }), [])
    assert.deepEqual(await service.recall({ query: '完全不存在这个词组xyzzy' }), [])
  } finally {
    cleanup()
  }
})
