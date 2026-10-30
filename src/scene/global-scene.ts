/**
 * global-scene.ts —— 多 Scope 全景聚合（Stage 7 / All Scopes）。
 *
 * 设计边界（spec §4/§6）：
 * - 只读聚合：逐 scope 复用现有 `SceneBuilder` 的真实输出，不读第二套数据、不改写入语义；
 * - 节点 id 加 scope 命名空间，边端点同步重映射，保证跨 scope 无歧义；
 * - **不跨 scope 造边**：每条边都来自某个 scope 内部真实存在的边，缺证据就不画；
 * - 某个 scope 失败时如实记入 `failures` 并把 `complete` 置 false，绝不把部分数据当完整全景。
 */
import type {
  GlobalScene,
  GlobalSceneEdge,
  GlobalScenePoint,
  GlobalSceneScopeSummary,
  GlobalSceneStats,
  MemorySeaScene,
} from '../types.js'

/** 全局节点 id 的命名空间分隔符（原始 id 里不会出现两种字符组合）。 */
export const GLOBAL_ID_SEPARATOR = '::'

/** 把某个 scope 内的节点 id 映射成全局唯一 id。 */
export function globalPointId(scopeId: string, pointId: string): string {
  return scopeId + GLOBAL_ID_SEPARATOR + pointId
}

/** 一次聚合的输入：一个 scope 及其真实 Scene。 */
export interface GlobalSceneSource {
  scopeId: string
  rootPath?: string
  scene: MemorySeaScene
}

export interface GlobalSceneFailureInput {
  scopeId: string
  error: string
}

export interface BuildGlobalSceneOptions {
  failures?: readonly GlobalSceneFailureInput[]
  now?: () => number
}

function finiteSpan(from: number, to: number): { from: number; to: number } {
  const safeFrom = Number.isFinite(from) ? from : 0
  const safeTo = Number.isFinite(to) ? to : safeFrom
  return { from: Math.min(safeFrom, safeTo), to: Math.max(safeFrom, safeTo) }
}

/**
 * 把多个 scope 的 Scene 合并成一张全景图。
 *
 * 纯函数：不访问数据库、不产生随机数；同一批输入永远得到同一份输出
 * （节点顺序 = 输入顺序，边顺序 = 输入顺序），便于测试与前端稳定渲染。
 */
export function buildGlobalScene(
  sources: readonly GlobalSceneSource[],
  options: BuildGlobalSceneOptions = {},
): GlobalScene {
  const points: GlobalScenePoint[] = []
  const edges: GlobalSceneEdge[] = []
  const scopes: GlobalSceneScopeSummary[] = []
  const seenPointIds = new Set<string>()
  const seenEdgeKeys = new Set<string>()

  let spanFrom = Number.POSITIVE_INFINITY
  let spanTo = Number.NEGATIVE_INFINITY
  const totals = { experiences: 0, episodes: 0, memories: 0, patterns: 0, relations: 0 }

  for (const source of sources) {
    const scene = source.scene
    const scenePoints = Array.isArray(scene?.points) ? scene.points : []
    const sceneEdges = Array.isArray(scene?.edges) ? scene.edges : []
    const localIdMap = new Map<string, string>()

    for (const point of scenePoints) {
      if (!point || typeof point.id !== 'string' || point.id.length === 0) continue
      const id = globalPointId(source.scopeId, point.id)
      if (seenPointIds.has(id)) continue
      seenPointIds.add(id)
      localIdMap.set(point.id, id)
      points.push({
        ...point,
        id,
        originalId: point.id,
        scopeId: source.scopeId,
        ...(source.rootPath ? { scopeRootPath: source.rootPath } : {}),
      })
      spanFrom = Math.min(spanFrom, point.createdAt)
      spanTo = Math.max(spanTo, point.createdAt)
    }

    let keptEdges = 0
    let keptRelations = 0
    for (const edge of sceneEdges) {
      if (!edge) continue
      const a = localIdMap.get(edge.a)
      const b = localIdMap.get(edge.b)
      // 端点必须都在本 scope 的真实节点集合里；跨 scope 或悬空的边直接丢弃。
      if (!a || !b) continue
      const key = a + '->' + b + '->' + edge.kind
      if (seenEdgeKeys.has(key)) continue
      seenEdgeKeys.add(key)
      edges.push({ ...edge, a, b, scopeId: source.scopeId })
      keptEdges += 1
      // 关系数只统计真实语义/证据关系（contains 是归属骨架，不算关系）。
      if (edge.kind !== 'contains') keptRelations += 1
    }

    const stats = scene?.stats
    const experiences = Number.isFinite(stats?.experiences) ? Number(stats?.experiences) : 0
    const episodes = Number.isFinite(stats?.episodes) ? Number(stats?.episodes) : 0
    const memories = Number.isFinite(stats?.memories) ? Number(stats?.memories) : 0
    const patterns = Number.isFinite(stats?.patterns) ? Number(stats?.patterns) : 0
    totals.experiences += experiences
    totals.episodes += episodes
    totals.memories += memories
    totals.patterns += patterns
    totals.relations += keptRelations

    scopes.push({
      scopeId: source.scopeId,
      ...(source.rootPath ? { rootPath: source.rootPath } : {}),
      points: localIdMap.size,
      edges: keptEdges,
      relations: keptRelations,
      experiences,
      episodes,
      memories,
      patterns,
    })
  }

  const failures = (options.failures ?? []).map((failure) => ({
    scopeId: failure.scopeId,
    error: failure.error,
  }))
  const now = options.now ?? Date.now
  const stats: GlobalSceneStats = {
    experiences: totals.experiences,
    episodes: totals.episodes,
    memories: totals.memories,
    patterns: totals.patterns,
    relations: totals.relations,
    edges: edges.length,
    span: finiteSpan(spanFrom, spanTo),
    scopes: scopes.length + failures.length,
    loadedScopes: scopes.length,
    nodeTotal: points.length,
  }

  return {
    points,
    edges,
    stats,
    scopes,
    failures,
    complete: failures.length === 0,
    builtAt: now(),
  }
}
