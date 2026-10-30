/** 全局节点 id 的命名空间分隔符（原始 id 里不会出现两种字符组合）。 */
export const GLOBAL_ID_SEPARATOR = '::';
/** 把某个 scope 内的节点 id 映射成全局唯一 id。 */
export function globalPointId(scopeId, pointId) {
    return scopeId + GLOBAL_ID_SEPARATOR + pointId;
}
function finiteSpan(from, to) {
    const safeFrom = Number.isFinite(from) ? from : 0;
    const safeTo = Number.isFinite(to) ? to : safeFrom;
    return { from: Math.min(safeFrom, safeTo), to: Math.max(safeFrom, safeTo) };
}
/**
 * 把多个 scope 的 Scene 合并成一张全景图。
 *
 * 纯函数：不访问数据库、不产生随机数；同一批输入永远得到同一份输出
 * （节点顺序 = 输入顺序，边顺序 = 输入顺序），便于测试与前端稳定渲染。
 */
export function buildGlobalScene(sources, options = {}) {
    const points = [];
    const edges = [];
    const scopes = [];
    const seenPointIds = new Set();
    const seenEdgeKeys = new Set();
    let spanFrom = Number.POSITIVE_INFINITY;
    let spanTo = Number.NEGATIVE_INFINITY;
    const totals = { experiences: 0, episodes: 0, memories: 0, patterns: 0, relations: 0 };
    for (const source of sources) {
        const scene = source.scene;
        const scenePoints = Array.isArray(scene?.points) ? scene.points : [];
        const sceneEdges = Array.isArray(scene?.edges) ? scene.edges : [];
        const localIdMap = new Map();
        for (const point of scenePoints) {
            if (!point || typeof point.id !== 'string' || point.id.length === 0)
                continue;
            const id = globalPointId(source.scopeId, point.id);
            if (seenPointIds.has(id))
                continue;
            seenPointIds.add(id);
            localIdMap.set(point.id, id);
            points.push({
                ...point,
                id,
                originalId: point.id,
                scopeId: source.scopeId,
                ...(source.rootPath ? { scopeRootPath: source.rootPath } : {}),
            });
            spanFrom = Math.min(spanFrom, point.createdAt);
            spanTo = Math.max(spanTo, point.createdAt);
        }
        let keptEdges = 0;
        let keptRelations = 0;
        for (const edge of sceneEdges) {
            if (!edge)
                continue;
            const a = localIdMap.get(edge.a);
            const b = localIdMap.get(edge.b);
            // 端点必须都在本 scope 的真实节点集合里；跨 scope 或悬空的边直接丢弃。
            if (!a || !b)
                continue;
            const key = a + '->' + b + '->' + edge.kind;
            if (seenEdgeKeys.has(key))
                continue;
            seenEdgeKeys.add(key);
            edges.push({ ...edge, a, b, scopeId: source.scopeId });
            keptEdges += 1;
            // 关系数只统计真实语义/证据关系（contains 是归属骨架，不算关系）。
            if (edge.kind !== 'contains')
                keptRelations += 1;
        }
        const stats = scene?.stats;
        const experiences = Number.isFinite(stats?.experiences) ? Number(stats?.experiences) : 0;
        const episodes = Number.isFinite(stats?.episodes) ? Number(stats?.episodes) : 0;
        const memories = Number.isFinite(stats?.memories) ? Number(stats?.memories) : 0;
        const patterns = Number.isFinite(stats?.patterns) ? Number(stats?.patterns) : 0;
        totals.experiences += experiences;
        totals.episodes += episodes;
        totals.memories += memories;
        totals.patterns += patterns;
        totals.relations += keptRelations;
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
        });
    }
    const failures = (options.failures ?? []).map((failure) => ({
        scopeId: failure.scopeId,
        error: failure.error,
    }));
    const now = options.now ?? Date.now;
    const stats = {
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
    };
    return {
        points,
        edges,
        stats,
        scopes,
        failures,
        complete: failures.length === 0,
        builtAt: now(),
    };
}
