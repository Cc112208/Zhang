/**
 * stage7.test.ts —— Stage 7 全景（All Scopes）聚合与只读页面测试。
 *
 * 覆盖：多 scope 真实聚合、计数与单 scope 一致、命名空间 id 唯一、
 * 同原始 id 不误合并、边端点重映射、无跨 scope 边、空 scope、
 * 失败 scope 显式标记、详情读取正确 scope、确定性、只读边界。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createTestService } from './helpers.js'
import { buildGlobalScene, globalPointId } from '../src/scene/global-scene.js'
import { renderScenePage } from '../src/web/scene-page.js'
import type { GlobalScene, MemorySeaScene } from '../src/types.js'

const BASE = Date.UTC(2026, 9, 30, 9, 0, 0)
const ROOT_A = 'C:/work/global-a'
const ROOT_B = 'C:/work/global-b'
const ROOT_EMPTY = 'C:/work/global-empty'

function emptyScene(): MemorySeaScene {
  return {
    points: [],
    edges: [],
    stats: { experiences: 0, episodes: 0, edges: 0, span: { from: 0, to: 0 } },
  }
}

function withService(run: (harness: ReturnType<typeof createTestService>) => void): void {
  const harness = createTestService({ config: { enabled: true } })
  try {
    run(harness)
  } finally {
    harness.cleanup()
  }
}

function seed(
  harness: ReturnType<typeof createTestService>,
  rootPath: string,
  contents: Array<{ content: string; id?: string }>,
  sessionId: string,
): string {
  let scopeId = ''
  contents.forEach((item, index) => {
    const result = harness.service.capture(
      {
        ...(item.id ? { id: item.id } : {}),
        content: item.content,
        sourceType: 'chat',
        role: 'user',
        sessionId,
        observedAt: BASE + index * 1000,
      },
      { rootPath },
    )
    scopeId = result.scopeId
  })
  return scopeId
}

function seedTwoScopes(harness: ReturnType<typeof createTestService>): { scopeA: string; scopeB: string } {
  const scopeA = seed(
    harness,
    ROOT_A,
    [{ content: '决定 Memory Sea 先用 SQLite 存记忆。' }, { content: '继续用本地单进程方案。' }],
    'session-a',
  )
  const scopeB = seed(
    harness,
    ROOT_B,
    [{ content: '项目的长期模式是避免过早引入基础设施。' }],
    'session-b',
  )
  return { scopeA, scopeB }
}

test('全景聚合包含多个真实 scope，节点数与各 scope 一致', () => {
  withService((harness) => {
    const { scopeA, scopeB } = seedTwoScopes(harness)
    const sceneA = harness.service.getScene({ scopeId: scopeA })
    const sceneB = harness.service.getScene({ scopeId: scopeB })
    const global = harness.service.getGlobalScene()

    const scopeIds = global.scopes.map((scope) => scope.scopeId)
    assert.ok(scopeIds.includes(scopeA), '应包含 scope A')
    assert.ok(scopeIds.includes(scopeB), '应包含 scope B')
    assert.ok(global.stats.scopes >= 2, `scope 数应 >=2，实际 ${global.stats.scopes}`)
    assert.equal(global.points.length, sceneA.points.length + sceneB.points.length)
    assert.ok(global.points.length >= sceneA.points.length + sceneB.points.length)
    assert.equal(global.stats.loadedScopes, global.scopes.length)
    assert.equal(global.complete, true)
  })
})

test('每个 scope 的计数与单独读取时一致（不重复、不遗漏）', () => {
  withService((harness) => {
    const { scopeA, scopeB } = seedTwoScopes(harness)
    const sceneA = harness.service.getScene({ scopeId: scopeA })
    const sceneB = harness.service.getScene({ scopeId: scopeB })
    const global = harness.service.getGlobalScene()

    assert.equal(global.stats.experiences, sceneA.stats.experiences + sceneB.stats.experiences)
    assert.equal(global.stats.episodes, sceneA.stats.episodes + sceneB.stats.episodes)
    assert.equal(global.edges.length, sceneA.edges.length + sceneB.edges.length)

    const empty = global.scopes.find((scope) => scope.scopeId === scopeA)
    assert.ok(empty, 'scopeA 应有汇总')
    assert.equal(empty?.points, sceneA.points.length)
    assert.equal(empty?.edges, sceneA.edges.length)
  })
})

test('节点 id 带 scope 命名空间；同原始 id 在多个 scope 里不会合并', () => {
  const point = (id: string, label: string) => ({
    id,
    type: 'experience' as const,
    label,
    x: 0,
    y: 0,
    z: 0,
    size: 1,
    importance: 1,
    activation: 1,
    createdAt: BASE,
  })
  // 真实库里 Experience.id 是主键，同一 id 不会真的出现在两个 scope；
  // 这里直接验证聚合器的命名空间行为（外部导入/未来来源可能出现同 id）。
  const scene = buildGlobalScene(
    [
      { scopeId: 'project_a', scene: { points: [point('xp_shared', 'A 的真实经历')], edges: [], stats: { experiences: 1, episodes: 0, edges: 0, span: { from: BASE, to: BASE } } } },
      { scopeId: 'project_b', scene: { points: [point('xp_shared', 'B 的真实经历')], edges: [], stats: { experiences: 1, episodes: 0, edges: 0, span: { from: BASE, to: BASE } } } },
    ],
    { now: () => BASE },
  )
  assert.equal(scene.points.length, 2, '同原始 id 属于两个 scope 时应保留两个节点')
  const ids = scene.points.map((item) => item.id)
  assert.ok(ids.includes(globalPointId('project_a', 'xp_shared')))
  assert.ok(ids.includes(globalPointId('project_b', 'xp_shared')))
  assert.equal(new Set(ids).size, 2, '全局 id 必须唯一')
})

test('真实聚合结果的全局 id 全部唯一且带各自 scope 前缀', () => {
  withService((harness) => {
    seedTwoScopes(harness)
    const global = harness.service.getGlobalScene()
    assert.equal(new Set(global.points.map((point) => point.id)).size, global.points.length)
    for (const point of global.points) {
      assert.equal(point.id, globalPointId(point.scopeId, point.originalId))
    }
  })
})

test('边端点全部映射到本 scope 的真实节点，且不存在跨 scope 边', () => {
  withService((harness) => {
    seedTwoScopes(harness)
    const global = harness.service.getGlobalScene()
    const byId = new Map(global.points.map((point) => [point.id, point]))

    for (const edge of global.edges) {
      const a = byId.get(edge.a)
      const b = byId.get(edge.b)
      assert.ok(a && b, `边 ${edge.a}->${edge.b} 的端点必须存在`)
      assert.equal(a?.scopeId, edge.scopeId)
      assert.equal(b?.scopeId, edge.scopeId)
      assert.equal(a?.scopeId, b?.scopeId, '边端点不得跨 scope')
    }
  })
})

test('只聚合指定 scope 时结果与单 scope 读取一致（单 Scope 模式不回归）', () => {
  withService((harness) => {
    const { scopeA, scopeB } = seedTwoScopes(harness)
    const onlyA = harness.service.getGlobalScene({ scopeIds: [scopeA] })
    const sceneA = harness.service.getScene({ scopeId: scopeA })

    assert.equal(onlyA.scopes.length, 1)
    assert.equal(onlyA.points.length, sceneA.points.length)
    assert.equal(onlyA.edges.length, sceneA.edges.length)
    assert.ok(onlyA.points.every((point) => point.scopeId === scopeA))
    assert.ok(!onlyA.points.some((point) => point.scopeId === scopeB))
  })
})

test('关系统计等于真实聚合的语义关系边（不含 contains 归属边）', () => {
  withService((harness) => {
    const { scopeA } = seedTwoScopes(harness)
    // 让 scope A 的两个 Episode 之间建立真实的连续性关系。
    harness.clock.advance(30 * 60 * 1000)
    harness.service.runMaintenance()
    harness.service.drainJobs()
    seed(harness, ROOT_A, [{ content: '继续讨论 SQLite 的取舍与本地优先。' }], 'session-a')
    harness.clock.advance(30 * 60 * 1000)
    harness.service.runMaintenance()
    harness.service.drainJobs()
    harness.service.runMaintenance()

    const global = harness.service.getGlobalScene()
    const relationEdges = global.edges.filter((edge) => edge.kind !== 'contains')
    assert.equal(global.stats.relations, relationEdges.length)
    assert.equal(
      global.scopes.reduce((sum, item) => sum + item.relations, 0),
      relationEdges.length,
      '每个 scope 的关系数之和必须等于全景关系数',
    )
    const byId = new Map(global.points.map((point) => [point.id, point]))
    for (const edge of relationEdges) {
      assert.ok(byId.has(edge.a), `关系边端点 a 必须存在：${edge.a}`)
      assert.ok(byId.has(edge.b), `关系边端点 b 必须存在：${edge.b}`)
      assert.equal(byId.get(edge.a)?.scopeId, byId.get(edge.b)?.scopeId, '关系边不得跨 scope')
    }
    const sceneA = harness.service.getScene({ scopeId: scopeA })
    const containsA = sceneA.edges.filter((edge) => edge.kind === 'contains').length
    const globalContainsA = global.edges.filter(
      (edge) => edge.kind === 'contains' && edge.scopeId === scopeA,
    ).length
    assert.equal(globalContainsA, containsA, 'contains 归属边在聚合后不应丢失')
  })
})

test('空 scope 与空 Scene 不报错，也不伪造节点', () => {
  withService((harness) => {
    const emptyScope = seed(harness, ROOT_EMPTY, [], 'session-empty')
    assert.equal(emptyScope, '')
    const scene = buildGlobalScene([{ scopeId: 'project_empty', scene: emptyScene() }], { now: () => BASE })
    assert.equal(scene.points.length, 0)
    assert.equal(scene.edges.length, 0)
    assert.equal(scene.complete, true)
    assert.equal(scene.stats.experiences, 0)
  })
})

test('某个 scope 读取失败时显式标记 complete=false 与 failures', () => {
  withService((harness) => {
    const { scopeA } = seedTwoScopes(harness)
    const scene = harness.service.getGlobalScene({ scopeIds: [scopeA, 'project_does_not_exist'] })

    assert.equal(scene.complete, false)
    assert.equal(scene.failures.length, 1)
    assert.equal(scene.failures[0].scopeId, 'project_does_not_exist')
    assert.equal(scene.stats.loadedScopes, 1)
    assert.equal(scene.stats.scopes, 2)
    assert.ok(scene.points.length > 0, '已成功读取的 scope 数据要保留')
  })
})

test('全景节点的详情按节点自身 scope 读取', () => {
  withService((harness) => {
    const { scopeA, scopeB } = seedTwoScopes(harness)
    const global = harness.service.getGlobalScene()
    const episodePoint = global.points.find((point) => point.type === 'episode' && point.scopeId === scopeA)
    const experiencePoint = global.points.find((point) => point.type === 'experience' && point.scopeId === scopeB)
    assert.ok(episodePoint, '应存在 scopeA 的 Episode 节点')
    assert.ok(experiencePoint, '应存在 scopeB 的 Experience 节点')

    const episodeDetail = harness.service.getEpisodeDetail(episodePoint!.originalId)
    assert.ok(episodeDetail)
    assert.equal(episodeDetail?.episode.scopeId, scopeA)

    const experienceDetail = harness.service.getExperienceDetail(experiencePoint!.originalId)
    assert.ok(experienceDetail)
    assert.equal(experienceDetail?.experience.scopeId, scopeB)
  })
})

test('重复调用得到完全相同的全景（确定性，无随机布局）', () => {
  withService((harness) => {
    seedTwoScopes(harness)
    const first = harness.service.getGlobalScene()
    const second = harness.service.getGlobalScene()
    const strip = (scene: GlobalScene) => ({ ...scene, builtAt: 0 })
    assert.equal(JSON.stringify(strip(first)), JSON.stringify(strip(second)))
  })
})

test('全局统计对无效输入保持有限数值，不返回 NaN', () => {
  const scene = buildGlobalScene(
    [
      {
        scopeId: 'project_broken',
        scene: {
          points: [{ id: 'p1', type: 'experience', label: 'x', x: 0, y: 0, z: 0, size: 1, importance: 1, activation: 1, createdAt: BASE }],
          edges: [{ a: 'p1', b: 'missing', score: 1, kind: 'contains' }],
          stats: { experiences: Number.NaN, episodes: 0, edges: 0, span: { from: Number.NaN, to: Number.NaN } },
        },
      },
    ],
    { now: () => BASE },
  )
  assert.equal(scene.edges.length, 0, '悬空边必须丢弃')
  assert.ok(Number.isFinite(scene.stats.experiences))
  assert.ok(Number.isFinite(scene.stats.span.from) && Number.isFinite(scene.stats.span.to))
})

test('页面包含全景/单 Scope 切换与 Scope 过滤控件，且没有写操作', () => {
  const page = renderScenePage()
  assert.ok(page.includes('id="mode-global"'), '页面应有全景模式按钮')
  assert.ok(page.includes('id="mode-scope"'), '页面应有单 Scope 模式按钮')
  assert.ok(page.includes('id="scope-filter"'), '页面应有 Scope 过滤容器')
  assert.ok(page.includes('id="stat-scopes"'), '页面应显示 Scope 数量')
  assert.ok(page.includes('/global-scene'), '页面应请求全景接口')
  assert.ok(!/method\s*=\s*['"]?(post|put|delete)/i.test(page), '页面不得包含写请求')
})
