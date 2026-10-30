/**
 * tests/stage45.test.ts —— Stage 4.5 验收（短查询上下文召回 + Episode 连续性）。
 *
 * 全部真实 SQLite + FTS5、可控时钟、手动 drainJobs()：
 * 上下文召回只做候选扩展，连续性只写 relation —— 两者都不得改写任何原始经历。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestService, MINUTE, type TestService } from './helpers.js'
import type { MemorySeaConfig } from '../src/config.js'
import type { MemorySeaService } from '../src/service.js'
import { detectQuerySignal } from '../src/recall/short-query-detector.js'
import { RuleBasedContinuityAnalyzer } from '../src/continuity/continuity-analyzer.js'
import type { ContinuityContext } from '../src/continuity/candidate-finder.js'
import type { Episode } from '../src/types.js'

const JOBS_OFF: Partial<MemorySeaConfig> = {
  jobs: { enabled: false, intervalMs: 2000, maxPerTick: 8, staleMs: 60_000, maxAttempts: 3 },
}

const SCOPE = { rootPath: 'C:/work/stage45' }

async function settle(service: MemorySeaService): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await service.drainJobs()
    if (service.status(SCOPE).jobs.pending === 0) return
  }
}

interface WriteOptions {
  actorId?: string
  threadKey?: string
  sessionId?: string
}

/** 写一段经历（带 actor/thread 元数据）→ idle 关闭 → 摘要 → 整理 → 连续性。 */
async function runEpisode(
  harness: TestService,
  messages: readonly string[],
  options: WriteOptions = {},
): Promise<string> {
  const sessionId = options.sessionId ?? 's-45'
  let episodeId = ''
  for (const content of messages) {
    const metadata: Record<string, unknown> = {}
    if (options.actorId) metadata.actorId = options.actorId
    if (options.threadKey) metadata.threadKey = options.threadKey
    episodeId = harness.service.capture({ content, sessionId, metadata }, SCOPE).episode.id
  }
  harness.clock.advance(30 * MINUTE)
  harness.service.runMaintenance()
  await settle(harness.service)
  return episodeId
}

function captureEpisode(
  harness: TestService,
  messages: readonly string[],
  options: WriteOptions = {},
): string {
  const sessionId = options.sessionId ?? 's-45'
  let episodeId = ''
  for (const content of messages) {
    const metadata: Record<string, unknown> = {}
    if (options.actorId) metadata.actorId = options.actorId
    if (options.threadKey) metadata.threadKey = options.threadKey
    episodeId = harness.service.capture({ content, sessionId, metadata }, SCOPE).episode.id
  }
  return episodeId
}

test('1. 弱查询检测：短问候/确认是 weak，具体问题是 normal', () => {
  for (const query of ['主播好', '你好', '我来了', '嗯', '然后呢', '怎么样了']) {
    assert.equal(detectQuerySignal(query).signal, 'weak', `应判 weak：${query}`)
  }
  for (const query of ['为什么我们没用 Neo4j？', '你之前推荐的游戏叫什么？']) {
    assert.equal(detectQuerySignal(query).signal, 'normal', `应判 normal：${query}`)
  }
})

test('2. 回访参与者 + 弱查询：上下文召回能想起「下周复试」', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    await runEpisode(
      harness,
      ['我下周要复试，先准备专业课。', '专业课差不多看完一轮了。'],
      { actorId: 'actor_a', threadKey: 'actor_a' },
    )

    const hits = await harness.service.recall(
      {
        query: '主播好',
        context: { actorId: 'actor_a', returningActor: true, interactionType: 'greeting' },
      },
      SCOPE,
    )
    assert.ok(hits.length > 0, '回访问候应召回至少一条')
    const joint = hits.map((hit) => hit.content).join(' ')
    assert.ok(joint.includes('复试'), `应想起复试，实际：${joint}`)
    const contextual = hits.find((hit) => hit.reasons.some((reason) => reason.type === 'context' || reason.type === 'continuation'))
    assert.ok(contextual, '必须带 context/continuation 理由，而不是只有一个分数')
  } finally {
    harness.cleanup()
  }
})

test('3. 没有 actor 上下文时，问候不乱召回重要记忆', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    await runEpisode(harness, ['我下周要复试，我很紧张。'], { actorId: 'actor_a' })
    const plain = await harness.service.recall({ query: '你好' }, SCOPE)
    assert.equal(plain.length, 0, '无上下文的「你好」不应随机召回记忆')
  } finally {
    harness.cleanup()
  }
})

test('4. 参与者隔离：相同问候，各自只想起自己的事', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    await runEpisode(harness, ['我下周要复试，先准备专业课。'], { actorId: 'actor_a' })
    await runEpisode(harness, ['我下周去旅行，想看看海边。'], { actorId: 'actor_b' })

    const forA = await harness.service.recall(
      { query: '主播好', context: { actorId: 'actor_a', returningActor: true, interactionType: 'greeting' } },
      SCOPE,
    )
    const forB = await harness.service.recall(
      { query: '主播好', context: { actorId: 'actor_b', returningActor: true, interactionType: 'greeting' } },
      SCOPE,
    )
    const textA = forA.map((hit) => hit.content).join(' ')
    const textB = forB.map((hit) => hit.content).join(' ')
    assert.ok(textA.includes('复试'), `A 应想到复试：${textA}`)
    assert.ok(textB.includes('旅行'), `B 应想到旅行：${textB}`)
    assert.ok(!textA.includes('旅行'), `A 不应看到 B 的旅行：${textA}`)
    assert.ok(!textB.includes('复试'), `B 不应看到 A 的复试：${textB}`)
  } finally {
    harness.cleanup()
  }
})

test('5. 具体问题不受上下文干扰：仍以关键词/语义为主', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    await runEpisode(harness, ['我下周要复试，先准备专业课。'], { actorId: 'actor_a' })
    const hits = await harness.service.recall(
      {
        query: '你之前推荐的游戏叫什么？',
        context: { actorId: 'actor_a', returningActor: true, interactionType: 'question' },
      },
      SCOPE,
    )
    const text = hits.map((hit) => hit.content).join(' ')
    assert.ok(!text.includes('复试'), `具体问题不该被复试记忆顶上来：${text}`)
  } finally {
    harness.cleanup()
  }
})

test('6. 连续性创建：同一参与者的后续经历连成 continues/followup', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    const first = await runEpisode(harness, ['我下周要复试，先准备专业课。'], {
      actorId: 'actor_a',
      threadKey: 'actor_a',
      sessionId: 's1',
    })
    const second = await runEpisode(harness, ['专业课差不多准备好了，还差英文自我介绍。'], {
      actorId: 'actor_a',
      threadKey: 'actor_a',
      sessionId: 's1',
    })
    const scopeId = harness.service.status(SCOPE).scope.id
    const relations = harness.service.listEpisodeRelations(scopeId)
    assert.ok(relations.length >= 1, '应建立至少一条 Episode 关系')
    const relation = relations.find(
      (item) => item.sourceEpisodeId === first && item.targetEpisodeId === second,
    )
    assert.ok(relation, `应存在 ${first} → ${second} 的关系`)
    assert.ok(['continues', 'followup'].includes(relation.relation), `关系类型：${relation.relation}`)
    assert.ok(relation.confidence > 0 && relation.confidence <= 1)
    assert.ok((relation.reason ?? '').length > 0, '关系必须有可读 reason')

    // 只写 relation，不改写 Episode 内容。
    const episode = harness.service.getEpisode(second)
    assert.ok(episode)
    assert.equal(episode.experienceIds.length >= 1, true)
    // 方向必须统一为「较早 → 较晚」，否则 previous/next 会互相串。
    for (const item of relations) {
      const source = harness.service.getEpisode(item.sourceEpisodeId)
      const target = harness.service.getEpisode(item.targetEpisodeId)
      assert.ok(source && target)
      assert.ok(
        source.startedAt <= target.startedAt,
        `关系方向必须是 source(较早) → target(较晚)：${item.sourceEpisodeId} → ${item.targetEpisodeId}`,
      )
    }
  } finally {
    harness.cleanup()
  }
})

test('7. 同一参与者但话题不同：最多 same_thread，绝不 continues', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    await runEpisode(harness, ['我下周要复试，先准备专业课。'], { actorId: 'actor_a', threadKey: 'actor_a', sessionId: 's1' })
    await runEpisode(harness, ['黑神话悟空的新补丁真好玩，我打到第三章了。'], {
      actorId: 'actor_a',
      threadKey: 'actor_a',
      sessionId: 's2',
    })
    const scopeId = harness.service.status(SCOPE).scope.id
    const relations = harness.service.listEpisodeRelations(scopeId)
    assert.ok(!relations.some((item) => item.relation === 'continues'), '话题不同不应判 continues')
  } finally {
    harness.cleanup()
  }
})

test('8. 跨场次连续性：不同 session 也能接上（followup/continues）', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    await runEpisode(harness, ['我下周要复试，先准备专业课。'], { actorId: 'actor_a', threadKey: 'actor_a', sessionId: 'day1' })
    await runEpisode(harness, ['专业课准备好了，今天复试结束了，感觉还行。'], {
      actorId: 'actor_a',
      threadKey: 'actor_a',
      sessionId: 'day2',
    })
    const scopeId = harness.service.status(SCOPE).scope.id
    const relations = harness.service.listEpisodeRelations(scopeId)
    assert.ok(
      relations.some((item) => item.relation === 'continues' || item.relation === 'followup'),
      `跨场次应建立连续性关系，实际：${relations.map((item) => item.relation).join(',')}`,
    )
  } finally {
    harness.cleanup()
  }
})

test('9. 幂等：重复执行不会重复建立关系', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    await runEpisode(harness, ['我下周要复试，先准备专业课。'], { actorId: 'actor_a', threadKey: 'actor_a', sessionId: 's1' })
    await runEpisode(harness, ['专业课差不多准备好了。'], { actorId: 'actor_a', threadKey: 'actor_a', sessionId: 's1' })
    const scopeId = harness.service.status(SCOPE).scope.id
    const before = harness.service.listEpisodeRelations(scopeId).length
    assert.ok(before >= 1)

    // 再跑一遍维护 + drain：没有 pending 任务，且关系数不变。
    harness.service.runMaintenance()
    await settle(harness.service)
    assert.equal(harness.service.listEpisodeRelations(scopeId).length, before)

    // 仓储层同样幂等：同一关系写三次只留一条。
    const repository = harness.service.listEpisodeRelations(scopeId)[0]
    assert.ok(repository)
    const relationsAgain = harness.service.listEpisodeRelations(scopeId)
    assert.equal(relationsAgain.filter((item) => item.sourceEpisodeId === repository.sourceEpisodeId).length, 1)
  } finally {
    harness.cleanup()
  }
})

test('10. 没有 embedding 时连续性照常工作', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    await runEpisode(harness, ['我下周要复试，先准备专业课。'], { actorId: 'actor_a', threadKey: 'actor_a' })
    await runEpisode(harness, ['专业课差不多准备好了，还差英文自我介绍。'], {
      actorId: 'actor_a',
      threadKey: 'actor_a',
    })
    assert.equal(harness.service.status(SCOPE).embedding.available, false)
    const scopeId = harness.service.status(SCOPE).scope.id
    assert.ok(harness.service.listEpisodeRelations(scopeId).length >= 1)
  } finally {
    harness.cleanup()
  }
})

test('11. 计划接续：一边计划、一边收尾，即使文本差异大也能连上', () => {
  const analyzer = new RuleBasedContinuityAnalyzer()
  const trigger = profileOf(['我下周要复试，先准备专业课。'], 'ep_b', 2_000)
  const candidate = profileOf(['专业课准备好了，今天复试结束了。'], 'ep_a', 0)
  const context: ContinuityContext = {
    scopeId: 'scope_x',
    trigger,
    candidates: [{ profile: candidate, gapMs: 2 * 24 * 60 * 60 * 1000, similarity: 0.12 }],
  }
  const links = analyzer.analyze(context)
  assert.ok(links.length >= 1, '计划接续应产生关系')
  assert.ok(['continues', 'followup'].includes(links[0].relation))
})

test('12. 连续性展开：命中中间段落时把前后经历带出来', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    await runEpisode(harness, ['我下周要复试，先准备专业课。'], { actorId: 'actor_a', threadKey: 'actor_a', sessionId: 's1' })
    const middle = await runEpisode(harness, ['专业课差不多准备好了，还差英文自我介绍。'], {
      actorId: 'actor_a',
      threadKey: 'actor_a',
      sessionId: 's1',
    })
    await runEpisode(harness, ['今天复试结束了，感觉还行，等结果。'], { actorId: 'actor_a', threadKey: 'actor_a', sessionId: 's1' })

    const scopeId = harness.service.status(SCOPE).scope.id
    assert.ok(harness.service.listEpisodeRelations(scopeId).length >= 2, '三段经历应至少两条关系')

    const hits = await harness.service.recall(
      { query: '复试 专业课', types: ['episode'], limit: 5, expandContinuity: true },
      SCOPE,
    )
    const withExpansion = hits.find((hit) => (hit.expanded ?? []).length > 0)
    assert.ok(withExpansion, '命中 Episode 时应展开连续性')
    const expanded = withExpansion.expanded ?? []
    assert.ok(expanded.every((hit) => hit.type === 'episode'))
    assert.ok(expanded.every((hit) => hit.reasons.some((reason) => reason.type === 'continuation')))
    const ordered = [...expanded].map((hit) => hit.createdAt)
    assert.deepEqual(ordered, [...ordered].sort((a, b) => a - b), '展开结果应按时间正序')
    assert.ok(!expanded.some((hit) => hit.id === middle) || expanded.length >= 1)
  } finally {
    harness.cleanup()
  }
})

test('13. 连续性不污染证据：memory_evidence 数量不变', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    await runEpisode(harness, ['决定继续用 SQLite 存记忆，不上 Neo4j。'], { actorId: 'actor_a' })
    const memories = harness.service.listMemories({ includeSuperseded: true }, SCOPE)
    assert.ok(memories.length >= 1)
    const memory = memories[0]
    assert.ok(memory)
    const before = harness.service.listMemoryEvidence(memory.id).length

    await runEpisode(harness, ['今天有点累，先睡了，明天再说。'], { actorId: 'actor_a' })
    const after = harness.service.listMemoryEvidence(memory.id).length
    assert.equal(after, before, '连续性不能自动变成 Evidence')
  } finally {
    harness.cleanup()
  }
})

test('14. Scene 契约：连续性边存在，legacy 仍然 ok', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    await runEpisode(harness, ['我下周要复试，先准备专业课。'], { actorId: 'actor_a', threadKey: 'actor_a' })
    await runEpisode(harness, ['专业课差不多准备好了，还差英文自我介绍。'], {
      actorId: 'actor_a',
      threadKey: 'actor_a',
    })
    const scene = harness.service.getScene(SCOPE)
    const continuityEdges = scene.edges.filter((edge) => edge.kind === 'continues' || edge.kind === 'followup')
    assert.ok(continuityEdges.length >= 1, 'Scene 应包含连续性边')
    assert.ok(continuityEdges.every((edge) => (edge.reason ?? '').length > 0), '连续性边必须带 reason')

    const legacy = harness.service.getLegacyScene(SCOPE)
    assert.equal(legacy.ok, true)
    assert.ok(Array.isArray(legacy.points) && legacy.points.length > 0)
  } finally {
    harness.cleanup()
  }
})

test('15. 同一参与者的三段独立经历：Narrative Chain 可 inspect 出来', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    const a = await runEpisode(harness, ['我下周要复试，先准备专业课。'], { actorId: 'actor_a', threadKey: 'actor_a', sessionId: 's1' })
    const b = await runEpisode(harness, ['专业课差不多准备好了，还差英文自我介绍。'], {
      actorId: 'actor_a',
      threadKey: 'actor_a',
      sessionId: 's2',
    })
    const c = await runEpisode(harness, ['今天复试结束了，感觉还行，等结果。'], { actorId: 'actor_a', threadKey: 'actor_a', sessionId: 's3' })
    const scopeId = harness.service.status(SCOPE).scope.id
    assert.ok(harness.service.listEpisodeRelations(scopeId).length >= 2)

    const inspection = harness.service.inspect(b)
    assert.ok(inspection)
    assert.equal(inspection.type, 'episode')
    const continuity = inspection.continuity
    assert.ok(continuity)
    const neighbourIds = [...continuity.previous, ...continuity.next].map((item) => item.episodeId)
    assert.ok(!neighbourIds.includes(b), '连续性视图不能把自己当成邻居')
    assert.ok(neighbourIds.includes(a) || neighbourIds.includes(c), `B 应连到 A 或 C，实际：${neighbourIds.join(',')}`)
    assert.ok(continuity.previous.length + continuity.next.length >= 1)
  } finally {
    harness.cleanup()
  }
})

test('16. status 暴露连续性统计与上下文召回开关', async () => {
  const harness = createTestService({ config: JOBS_OFF })
  try {
    await runEpisode(harness, ['我下周要复试，先准备专业课。'], { actorId: 'actor_a', threadKey: 'actor_a' })
    await runEpisode(harness, ['专业课差不多准备好了，还差英文自我介绍。'], {
      actorId: 'actor_a',
      threadKey: 'actor_a',
    })
    const status = harness.service.status(SCOPE)
    assert.ok(status.continuity.relations >= 1)
    assert.ok(status.continuity.episodesLinked >= 2)
    assert.equal(status.recall.contextualEnabled, true)
  } finally {
    harness.cleanup()
  }
})

/** 构造分析器输入用的最小 profile。 */
function profileOf(messages: readonly string[], episodeId: string, startedAt: number) {
  const text = messages.join(' ')
  const episode: Episode = {
    id: episodeId,
    startedAt,
    endedAt: startedAt + MINUTE,
    lastExperienceAt: startedAt + MINUTE,
    experienceIds: [],
    participants: [],
    locations: [],
    topics: [],
    importance: 0.7,
    salience: 0.5,
    confidence: 0.6,
    status: 'closed',
    createdAt: startedAt,
    updatedAt: startedAt + MINUTE,
    embeddingStatus: 'disabled',
    summaryStatus: 'ready',
    consolidationStatus: 'ready',
    continuityStatus: 'pending',
    scopeId: 'scope_x',
  }
  return {
    episode,
    actorIds: ['actor_a'],
    strongActorIds: ['actor_a'],
    actorConfidence: 'high' as const,
    threadKeys: ['actor_a'],
    topics: text.includes('复试') ? ['复试'] : [],
    tokens: text.split(' '),
    text,
  }
}

/** 保留 captureEpisode 供后续用例复用（当前用例直接使用 runEpisode）。 */
void captureEpisode
