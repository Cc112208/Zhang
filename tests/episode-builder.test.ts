/**
 * tests/episode-builder.test.ts —— Experience → Episode 的确定性规则（spec §7 / §22）。
 *
 * 场景 A 的直接验证：连续三句话 → 3 Experiences + 1 Episode。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { createClock, createTemporaryDirectory, createTestService, reopenService, MINUTE } from './helpers.js'
import { MessageCapture } from '../src/capture/message-capture.js'
import { resolveConfig } from '../src/config.js'

const chat = { sourceType: 'chat' as const, role: 'user' as const }

test('同 session 的连续消息归入同一个 Episode', () => {
  const { service, clock, cleanup } = createTestService()
  try {
    const first = service.capture({ ...chat, sessionId: 's1', content: '今天研究 Memory Sea。' })
    clock.advance(MINUTE)
    const second = service.capture({ ...chat, sessionId: 's1', content: '决定 V0.2 先用 SQLite。' })
    clock.advance(MINUTE)
    const third = service.capture({ ...chat, sessionId: 's1', content: 'Neo4j 后面再上。' })

    assert.equal(first.createdEpisode, true)
    assert.equal(second.createdEpisode, false)
    assert.equal(second.episode.id, first.episode.id)
    assert.equal(third.episode.id, first.episode.id)

    const episode = service.getEpisode(first.episode.id)
    assert.ok(episode)
    assert.equal(episode.experienceIds.length, 3)
    assert.equal(episode.status, 'open')
    for (const id of episode.experienceIds) {
      assert.equal(service.getExperience(id)?.episodeId, episode.id)
    }
    // 场景 A：3 Experiences + 1 Episode
    assert.equal(service.status().experiences, 3)
    assert.equal(service.status().episodes, 1)
  } finally {
    cleanup()
  }
})

test('间隔超过 episodeIdleMs（20 分钟）会关闭旧 Episode 并新建', () => {
  const { service, clock, cleanup } = createTestService()
  try {
    const first = service.capture({ ...chat, sessionId: 's1', content: '先记一条。' })
    clock.advance(21 * MINUTE)
    const second = service.capture({ ...chat, sessionId: 's1', content: '隔了很久又说一句。' })

    assert.notEqual(second.episode.id, first.episode.id)
    assert.equal(second.createdEpisode, true)
    assert.equal(service.getEpisode(first.episode.id)?.status, 'closed')
    assert.equal(service.getEpisode(second.episode.id)?.status, 'open')
    assert.equal(service.status().experiences, 2)
    assert.equal(service.status().episodes, 2)
  } finally {
    cleanup()
  }
})

test('不同 session 归入不同 Episode', () => {
  const { service, cleanup } = createTestService()
  try {
    const a = service.capture({ ...chat, sessionId: 'session-a', content: 'A 会话的甲。' })
    const b = service.capture({ ...chat, sessionId: 'session-b', content: 'B 会话的乙。' })
    const c = service.capture({ ...chat, sessionId: 'session-a', content: 'A 会话的丙。' })

    assert.notEqual(a.episode.id, b.episode.id)
    assert.equal(c.episode.id, a.episode.id)
    assert.equal(c.createdEpisode, false)
    assert.equal(service.status().episodes, 2)
  } finally {
    cleanup()
  }
})

test('重启后会关闭遗留的陈旧 open Episode', () => {
  const directory = createTemporaryDirectory()
  const dbPath = join(directory, 'restart.db')
  const clock = createClock()
  try {
    const first = reopenService(dbPath, clock)
    const captured = first.capture({ ...chat, sessionId: 's1', content: '崩溃前写入的一条。' })
    assert.equal(first.getEpisode(captured.episode.id)?.status, 'open')
    first.closeSync()

    clock.advance(30 * MINUTE)
    const restarted = reopenService(dbPath, clock)
    try {
      assert.equal(restarted.getEpisode(captured.episode.id)?.status, 'closed')
      assert.equal(restarted.status().openEpisodes, 0)
      // 原文仍然完好
      assert.equal(restarted.getExperience(captured.experience.id)?.content, '崩溃前写入的一条。')
    } finally {
      restarted.closeSync()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Episode 的派生字段随经历增长而更新', () => {
  const { service, cleanup } = createTestService()
  try {
    const first = service.capture({
      ...chat,
      sessionId: 's1',
      content: '和老王聊 Memory Sea，决定先用 SQLite，在公司。',
    })
    service.capture({
      sourceType: 'tool',
      role: 'tool',
      sessionId: 's1',
      content: '工具结果：SQLite FTS5 可用。',
      importance: 0.92,
    })
    const episode = service.getEpisode(first.episode.id)
    assert.ok(episode)
    assert.equal(episode.experienceIds.length, 2)
    assert.ok(episode.topics.length > 0)
    assert.ok(episode.participants.includes('老王'))
    assert.ok(episode.locations.includes('公司'))
    assert.ok(episode.importance >= 0.92)
    assert.ok(episode.confidence > 0)
  } finally {
    cleanup()
  }
})

test('结构化工具回执不会成为 Episode 标题，聊天内容优先', () => {
  const { service, cleanup } = createTestService()
  try {
    const tool = service.capture({
      sourceType: 'tool',
      role: 'tool',
      sessionId: 's1',
      content: '{"stage":"enable","target":"dsh-3d-memory-sea","changed":true}',
    })
    assert.equal(tool.episode.title, '工具与操作记录')

    const chatResult = service.capture({ ...chat, sessionId: 's1', content: '检查一下插件安装状态。' })
    assert.equal(chatResult.episode.id, tool.episode.id)
    assert.equal(service.getEpisode(tool.episode.id)?.title, '检查一下插件安装状态。')
  } finally {
    cleanup()
  }
})

test('会话事件捕获：超长工具输出被截断、结构化回执重要性降低', () => {
  const capture = new MessageCapture({ config: resolveConfig({ enabled: true }) })
  const huge = '{"ok":true,"log":"' + 'x'.repeat(20000) + '"}'
  const [input] = capture.fromSessionEvent(
    { id: 's-evt' },
    { type: 'tool/result', seq: 7, time: 1_700_000_000_000, data: { message: { content: huge } } },
  )
  assert.ok(input)
  assert.equal(input.sourceType, 'tool')
  assert.ok(input.content.length <= 8001, '工具输出应被截断')
  assert.equal(input.importance, 0.2)
  assert.equal(input.id, 'xp_evt_s-evt_7')

  // 自然语言的工具结果保留原重要性估计
  const [natural] = capture.fromSessionEvent(
    { id: 's-evt' },
    { type: 'tool/result', seq: 8, time: 1_700_000_000_000, data: { message: { content: '测试全部通过，共 16 个用例。' } } },
  )
  assert.ok(natural)
  assert.notEqual(natural.importance, 0.2)
})

test('宿主注入的运行上下文行不会成为 Episode 标题', () => {
  const { service, cleanup } = createTestService()
  try {
    // 用数组 join 构造多行文本，避免测试文件里出现转义换行。
    const content = [
      'Time sampled while preparing turn 1, step 1: 2026-10-29T04:10:15+08:00[Asia/Shanghai]',
      'Browser time zone for this request: Asia/Shanghai.',
      '决定 V0.2 先用 SQLite。',
    ].join(String.fromCharCode(10))
    const result = service.capture({ ...chat, sessionId: 's1', content })
    assert.equal(result.episode.title, '决定 V0.2 先用 SQLite。')
    // 原文仍然是完整的（标题只是派生字段，不影响证据）
    assert.ok(result.experience.content.includes('Time sampled'))
  } finally {
    cleanup()
  }
})
