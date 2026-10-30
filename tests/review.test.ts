/**
 * tests/review.test.ts —— Stage 4 Review / Stale 验收（spec §31–§36）。
 *
 * 全部用真实 SQLite（临时库 + 真实迁移 013_memory_review），不 mock 仓储；
 * 时间用可控时钟，需要「老」数据时直接写一行 SQL 改 created_at / last_reinforced_at ——
 * 仓储本身不暴露「回拨时间」的方法，这是测试唯一允许的越权手法。
 *
 * 核心断言：Review 只改状态、不删行、不 supersede；老 + 高置信度只 keep。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryDatabase } from '../src/storage/database.js'
import { MemoryRepository } from '../src/memory/memory-repository.js'
import { PatternRepository } from '../src/pattern/pattern-repository.js'
import { MemoryReviewService, type MemoryReviewSettings } from '../src/review/memory-review-service.js'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 固定起点：2026-01-01 09:00 UTC。 */
const T0 = Date.UTC(2026, 0, 1, 9, 0, 0)
/** 仓储只按 scope_id 精确匹配，不校验格式。 */
const SCOPE = 'project_memory_sea_review'

interface ReviewHarness {
  directory: string
  db: MemoryDatabase
  memories: MemoryRepository
  patterns: PatternRepository
  service: MemoryReviewService
  /** 可变对象：测试通过 clock.now = ... 推进时间。 */
  clock: { now: number }
  settings: MemoryReviewSettings
  cleanup(): void
}

function createHarness(overrides: Partial<MemoryReviewSettings> = {}): ReviewHarness {
  const directory = mkdtempSync(join(tmpdir(), 'memory-sea-review-'))
  const db = MemoryDatabase.open(join(directory, 'review.db'))
  const clock = { now: T0 }
  const settings: MemoryReviewSettings = {
    memoryStaleAfterMs: 30 * DAY,
    patternStaleAfterMs: 30 * DAY,
    maxItemsPerRun: 20,
    memoryStaleConfidence: 0.75,
    ...overrides,
  }
  const memories = new MemoryRepository({ db, now: () => clock.now })
  const patterns = new PatternRepository({ db, now: () => clock.now })
  const service = new MemoryReviewService({ memories, patterns, now: () => clock.now, settings })
  return {
    directory,
    db,
    memories,
    patterns,
    service,
    clock,
    settings,
    cleanup() {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

/** 把知识改成「很久以前创建、从未再被强化」。 */
function ageMemory(harness: ReviewHarness, memoryId: string, ageMs = 90 * DAY): void {
  harness.db.run(
    'UPDATE memories SET created_at = ?, last_reinforced_at = NULL WHERE id = ?',
    harness.clock.now - ageMs,
    memoryId,
  )
}

/** 创建很老、但刚刚被新证据强化的知识（created_at 老，last_reinforced_at 新）。 */
function reinforceRecently(harness: ReviewHarness, memoryId: string, ageMs = 1000): void {
  harness.db.run(
    'UPDATE memories SET created_at = ?, last_reinforced_at = ? WHERE id = ?',
    harness.clock.now - 365 * DAY,
    harness.clock.now - ageMs,
    memoryId,
  )
}

interface PatternOptions {
  status?: 'active' | 'weakened'
  supportCount?: number
  contradictionCount?: number
  /** last_observed_at 距今多久（不传则保持 create 时的 60 天前）。 */
  observedAgeMs?: number
}

/** 造一条 Pattern；support/contradiction 计数用 SQL 补写（create 入参暂无这两个字段）。 */
function createPattern(harness: ReviewHarness, content: string, options: PatternOptions = {}): string {
  const observedAt = options.observedAgeMs === undefined ? T0 - 60 * DAY : harness.clock.now - options.observedAgeMs
  const pattern = harness.patterns.create({
    scopeId: SCOPE,
    kind: 'recurring_decision',
    content,
    confidence: 0.7,
    importance: 0.6,
    status: options.status ?? 'active',
    firstObservedAt: T0 - 180 * DAY,
    lastObservedAt: observedAt,
    embeddingStatus: 'disabled',
  })
  harness.db.run(
    'UPDATE patterns SET support_count = ?, contradiction_count = ?, last_reinforced_at = NULL WHERE id = ?',
    options.supportCount ?? 3,
    options.contradictionCount ?? 0,
    pattern.id,
  )
  return pattern.id
}

function countRows(harness: ReviewHarness, table: 'memories' | 'patterns'): number {
  const row = harness.db.get<{ total: number }>(`SELECT COUNT(*) AS total FROM ${table}`)
  assert.ok(row)
  return Number(row.total)
}

test('老 + 低置信度：mark_stale，status=stale，行仍在且绝不会 supersede', () => {
  const harness = createHarness()
  try {
    const memory = harness.memories.create({
      scopeId: SCOPE,
      kind: 'decision',
      content: '决定 V0.2 继续用 SQLite 存记忆。',
      confidence: 0.5,
      importance: 0.6,
      embeddingStatus: 'disabled',
    })
    ageMemory(harness, memory.id)

    // 到期扫描先能看到它（review 只处理到期项）。
    const due = harness.service.findDueMemories(SCOPE)
    assert.equal(due.length, 1)
    assert.equal(due[0]?.id, memory.id)

    const result = harness.service.reviewMemory(memory.id)
    assert.deepEqual(result, { memoryId: memory.id, decision: 'mark_stale', reviewStatus: 'stale' })

    const after = harness.memories.getById(memory.id)
    assert.ok(after, 'Review 不删除任何行，getById 必须还能读到')
    assert.equal(after.status, 'stale')
    assert.notEqual(after.status, 'superseded', 'stale 不等于 superseded；后者只能由 Consolidation 产生')
    assert.equal(after.supersededBy, undefined)
    assert.equal(after.reviewStatus, 'stale')
    assert.equal(after.lastReviewedAt, T0)
    assert.equal(countRows(harness, 'memories'), 1)
  } finally {
    harness.cleanup()
  }
})

test('老 + 最近刚强化：不进 due 队列，review 也不会把它标 stale', () => {
  const harness = createHarness()
  try {
    const neverReinforced = harness.memories.create({
      scopeId: SCOPE,
      kind: 'decision',
      content: '很久没被重新确认的旧知识。',
      confidence: 0.9,
      importance: 0.5,
      embeddingStatus: 'disabled',
    })
    ageMemory(harness, neverReinforced.id)

    const reinforced = harness.memories.create({
      scopeId: SCOPE,
      kind: 'decision',
      content: '创建很早，但一分钟前刚被新证据强化。',
      confidence: 0.9,
      importance: 0.5,
      embeddingStatus: 'disabled',
    })
    reinforceRecently(harness, reinforced.id)

    const dueIds = harness.service.findDueMemories(SCOPE).map((memory) => memory.id)
    assert.deepEqual(dueIds, [neverReinforced.id], '刚被强化的知识即使 created_at 很老也不该到期')

    const result = harness.service.reviewMemory(reinforced.id)
    assert.equal(result?.decision, 'keep')
    const after = harness.memories.getById(reinforced.id)
    assert.ok(after)
    assert.equal(after.status, 'active', '刚被支持过的知识不能被 Review 降级')
    assert.equal(after.reviewStatus, 'reviewed')
  } finally {
    harness.cleanup()
  }
})

test('老 + 高置信度：decision=keep，review_status=reviewed，status 仍是 active', () => {
  const harness = createHarness()
  try {
    const memory = harness.memories.create({
      scopeId: SCOPE,
      kind: 'principle',
      content: '证据链完整的结论，虽然旧但置信度仍高。',
      confidence: 0.9,
      importance: 0.8,
      embeddingStatus: 'disabled',
    })
    ageMemory(harness, memory.id)

    assert.equal(harness.service.findDueMemories(SCOPE).length, 1)

    const result = harness.service.reviewMemory(memory.id)
    assert.deepEqual(result, { memoryId: memory.id, decision: 'keep', reviewStatus: 'reviewed' })

    const after = harness.memories.getById(memory.id)
    assert.ok(after)
    assert.equal(after.status, 'active')
    assert.equal(after.reviewStatus, 'reviewed')
    assert.equal(after.lastReviewedAt, T0)
  } finally {
    harness.cleanup()
  }
})

test('Pattern：有反证的到期 active → weakened，再扫一次才 → stale，行仍在', () => {
  const harness = createHarness()
  try {
    const patternId = createPattern(harness, '每次讨论存储选型都先比较 SQLite 与 Postgres。', {
      contradictionCount: 2,
    })

    const first = harness.service.sweepPatterns(SCOPE)
    assert.deepEqual(first, { weakened: 1, stale: 0 }, '一次扫描只能降一级，不能直接 stale')
    assert.equal(harness.patterns.getById(patternId)?.status, 'weakened')

    const second = harness.service.sweepPatterns(SCOPE)
    assert.deepEqual(second, { weakened: 0, stale: 1 })
    const after = harness.patterns.getById(patternId)
    assert.ok(after, 'Pattern 降级同样不删除行')
    assert.equal(after.status, 'stale')
    assert.equal(countRows(harness, 'patterns'), 1)
  } finally {
    harness.cleanup()
  }
})

test('Pattern：到期但没有反证 → 只记录 review，不降级', () => {
  const harness = createHarness()
  try {
    const patternId = createPattern(harness, '周会把复杂任务拆成小步交付。', { contradictionCount: 0 })

    const result = harness.service.sweepPatterns(SCOPE)
    assert.deepEqual(result, { weakened: 0, stale: 0 })

    const after = harness.patterns.getById(patternId)
    assert.ok(after)
    assert.equal(after.status, 'active', '没有反证就不该 weakened')
    assert.equal(after.lastReviewedAt, T0)
  } finally {
    harness.cleanup()
  }
})

test('dueCounts 与 findDueMemories / Pattern due 列表口径一致，且只读', () => {
  const harness = createHarness()
  try {
    const dueMemory = harness.memories.create({
      scopeId: SCOPE,
      kind: 'fact',
      content: '到期知识：很久没有新证据支持。',
      confidence: 0.8,
      importance: 0.5,
      embeddingStatus: 'disabled',
    })
    ageMemory(harness, dueMemory.id)

    // 刚创建、还没到期。
    harness.memories.create({
      scopeId: SCOPE,
      kind: 'fact',
      content: '刚刚形成的知识。',
      confidence: 0.8,
      importance: 0.5,
      embeddingStatus: 'disabled',
    })

    const duePatternId = createPattern(harness, '常见问题总是先查索引再改代码。', {
      contradictionCount: 1,
    })
    // 最近仍被观察到的 Pattern 不到期。
    harness.patterns.create({
      scopeId: SCOPE,
      kind: 'habit',
      content: '最近仍在重复出现的习惯。',
      confidence: 0.6,
      importance: 0.4,
      status: 'active',
      firstObservedAt: T0 - 10 * DAY,
      lastObservedAt: T0,
      embeddingStatus: 'disabled',
    })

    const counts = harness.service.dueCounts(SCOPE)
    assert.deepEqual(counts, { dueMemories: 1, duePatterns: 1 })

    const dueMemories = harness.service.findDueMemories(SCOPE)
    assert.equal(dueMemories.length, counts.dueMemories)
    assert.deepEqual(dueMemories.map((memory) => memory.id), [dueMemory.id])

    const duePatterns = harness.patterns.listDueForReview(SCOPE, {
      staleAfterMs: harness.settings.patternStaleAfterMs,
      limit: 50,
      now: harness.clock.now,
    })
    assert.equal(duePatterns.length, counts.duePatterns)
    assert.equal(duePatterns[0]?.id, duePatternId)

    // 只读：dueCounts 不改任何状态。
    assert.equal(harness.memories.getById(dueMemory.id)?.status, 'active')
    assert.equal(harness.patterns.getById(duePatternId)?.status, 'active')
    assert.deepEqual(harness.service.dueCounts(SCOPE), counts)
  } finally {
    harness.cleanup()
  }
})

test('非 active 与不存在的知识：Review 一律 keep / null，不改历史', () => {
  const harness = createHarness()
  try {
    const memory = harness.memories.create({
      scopeId: SCOPE,
      kind: 'decision',
      content: '已经被新结论取代的旧决定。',
      confidence: 0.4,
      importance: 0.5,
      embeddingStatus: 'disabled',
    })
    harness.memories.setStatus(memory.id, 'superseded')

    const result = harness.service.reviewMemory(memory.id)
    assert.deepEqual(result, { memoryId: memory.id, decision: 'keep', reviewStatus: 'fresh' })

    const after = harness.memories.getById(memory.id)
    assert.ok(after)
    assert.equal(after.status, 'superseded')
    assert.equal(after.lastReviewedAt, undefined, '非 active 的知识不写 review 时间')

    assert.equal(harness.service.reviewMemory('memory_does_not_exist'), null)
  } finally {
    harness.cleanup()
  }
})
