/**
 * legacy-adapter.ts —— 给现有 3d-memory-sea 前端用的兼容层（spec §17 / §25）。
 *
 * 现有前端只认 `GET /api/scene` 返回的旧格式：
 *   { ok, name, builtAt, points: [{ id, t, kind, topic, text, weight, cluster, source, keywords }], edges, stats }
 * 它自己也用 `rand(point.id + 'a')` 在浏览器里做球面布局，所以这里**不需要**输出 x/y/z，
 * 但输出它们也无害（前端会覆盖），这里只填旧字段。
 *
 * 旧格式里的 kind 是展示用的五种情绪/语义类型，V0.2 没有对应概念，按来源做确定性映射。
 */
const LEGACY_KIND_BY_SOURCE = {
    chat: 'event',
    tool: 'fact',
    manual: 'plan',
    diary: 'feeling',
    file: 'fact',
    web: 'fact',
};
const LEGACY_SOURCE_BY_SOURCE_TYPE = {
    chat: 'messages',
    diary: 'diary',
    tool: 'longterm',
    manual: 'longterm',
    file: 'longterm',
    web: 'longterm',
};
export function toLegacyScene(scene, options = {}) {
    const now = options.now ?? Date.now();
    const textMax = options.textMax ?? 160;
    const clusterOf = new Map();
    for (const point of scene.points) {
        if (point.type === 'episode')
            clusterOf.set(point.id, point.label);
    }
    const points = [];
    for (const point of scene.points) {
        const text = truncateText(point.label, textMax);
        if (text.length < 2)
            continue;
        points.push({
            id: point.id,
            t: point.createdAt,
            kind: legacyKind(point),
            topic: point.type,
            text,
            weight: legacyWeight(point),
            cluster: clusterFor(point, clusterOf),
            ...(point.summary ? { full: point.summary } : {}),
            source: {
                type: LEGACY_SOURCE_BY_SOURCE_TYPE[point.sourceType ?? ''] ?? 'longterm',
                id: point.id,
            },
            keywords: [],
        });
    }
    const edges = scene.edges.map((edge) => ({
        a: edge.a,
        b: edge.b,
        score: edge.score,
        // 旧前端只用 'topic' 与其他做颜色区分；contains 语义上最接近「同主题」，映射为 topic。
        kind: 'topic',
    }));
    return {
        ok: true,
        name: options.name ?? '3D Memory Sea',
        builtAt: now,
        points,
        edges,
        stats: legacyStats(points, edges, scene.stats.span),
    };
}
function legacyKind(point) {
    // Memory / Pattern 都是提炼出的知识，旧前端里最接近「结论」节点
    // （spec §43：type='pattern' → kind='conclusion'，前端不改）。
    if (point.type === 'memory' || point.type === 'pattern' || point.type === 'episode')
        return 'conclusion';
    return LEGACY_KIND_BY_SOURCE[point.sourceType ?? ''] ?? 'event';
}
/** 旧前端用它算半径：radius = 1.1 + min(2.4, weight * 0.55)。 */
function legacyWeight(point) {
    let weight;
    if (point.type === 'pattern') {
        // Pattern 是深层结构：比 Memory 更靠核心，但只能到 4（旧前端半径上限）。
        weight = 3.4 + point.importance * 1.2 + (point.confidence ?? 0.5) * 0.8 + Math.min(4, point.supportCount ?? 0) * 0.12;
    }
    else if (point.type === 'memory') {
        // 旧前端 radius = 1.1 + min(2.4, weight * 0.55)：Memory 要明显大于 Episode。
        weight = 3 + point.importance * 1.4 + (point.confidence ?? 0.5) * 0.6;
    }
    else if (point.type === 'episode') {
        weight = 2.4 + point.importance * 1.6;
    }
    else {
        weight = 0.6 + point.importance * 2.2;
    }
    return Math.round(Math.min(4, Math.max(0.2, weight)) * 100) / 100;
}
function clusterFor(point, clusterOf) {
    if (point.type === 'pattern')
        return '长期模式';
    if (point.type === 'memory')
        return '语义记忆';
    if (point.type === 'episode')
        return point.label;
    return '未归属经历';
}
function legacyStats(points, edges, span) {
    const byKind = {};
    const byTopic = {};
    const byCluster = {};
    for (const point of points) {
        byKind[point.kind] = (byKind[point.kind] ?? 0) + 1;
        byTopic[point.topic] = (byTopic[point.topic] ?? 0) + 1;
        byCluster[point.cluster] = (byCluster[point.cluster] ?? 0) + 1;
    }
    return { total: points.length, edges: edges.length, byKind, byTopic, byCluster, span };
}
function truncateText(text, maxChars) {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxChars)
        return normalized;
    return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}
