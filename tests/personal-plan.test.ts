import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createTestService, MINUTE } from './helpers.js'

// 第一人称的个人计划没有「决定/目标」这类字眼，但确实是值得长期记住的个人事实。
// 直播场景的「我下周要复试」就靠这条规则沉淀（Live Agent 的验收依赖它）。
test('个人计划（无决定字眼）也能形成 goal 知识', async () => {
  const harness = createTestService()
  const scope = { rootPath: 'C:/work/personal-plan' }
  try {
    harness.service.capture(
      {
        content: '我下周要复试，专业课差不多了。',
        sourceType: 'chat',
        sessionId: 's-plan',
        role: 'user',
        observedAt: harness.clock.now,
      },
      { rootPath: scope.rootPath },
    )
    harness.clock.advance(30 * MINUTE)
    await harness.service.runMaintenance()
    for (let round = 0; round < 20; round += 1) {
      const handled = await harness.service.drainJobs()
      if (handled === 0 && round > 1) break
    }

    const memories = harness.service.listMemories({ limit: 10 }, { rootPath: scope.rootPath })
    assert.ok(memories.length >= 1, '应该形成一条长期知识')
    const goal = memories.find((memory) => memory.content.includes('复试'))
    assert.ok(goal, '知识内容应包含复试')
    assert.equal(goal?.status, 'active')
  } finally {
    harness.cleanup()
  }
})
