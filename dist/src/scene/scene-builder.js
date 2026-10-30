/**
 * scene-builder.ts —— Episode / Experience → Memory Sea 可视化数据（spec §17 / §18）。
 *
 * 只做数据转换，不碰前端、不碰 UI 布局。
 * 布局原则：同一节点每次生成的位置必须完全一致（基于 id 的稳定伪随机），刷新不跳动。
 */
import { unitRand } from '../util/stable-random.js';
import { preview, truncate } from '../util/text.js';
import { DEFAULT_RECENCY_HALF_LIFE_MS } from '../recall/temporal-recall.js';
import { stabilityScore } from '../pattern/pattern-lifecycle.js';
/** Memory 是核心节点：放在比 Episode 更内层的主球壳上（spec §41）。 */
const MEMORY_SHELL_RADIUS = 30;
const MEMORY_LABEL_CHARS = 60;
const MEMORY_SIZE_MIN = 3.2;
const MEMORY_SIZE_MAX = 7.5;
/**
 * Pattern 是最深层、最稳定的结构（spec §43–§47）：放在更内层的小球壳，
 * 但位置优先取「支持它的 Memory 质心」，让人看得出它长在哪些知识之上。
 */
const PATTERN_SHELL_RADIUS = 14;
const PATTERN_LABEL_CHARS = 60;
const PATTERN_SIZE_MIN = 4;
const PATTERN_SIZE_MAX = 9;
/** Pattern 数量必须远少于 Memory（spec §78）：场景里最多画这么多个。 */
const PATTERN_POINT_LIMIT = 3;
/** Episode 所在球壳半径。Experience 在父 Episode 附近的小球壳里。 */
const EPISODE_SHELL_RADIUS = 68;
const EXPERIENCE_SHELL_MIN = 9;
const EXPERIENCE_SHELL_MAX = 24;
const EXPERIENCE_LABEL_CHARS = 120;
export class SceneBuilder {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    build(scopeId) {
        const budget = Math.max(1, Math.trunc(this.deps.maxPoints));
        // Episode 是骨架：先留出 Episode 位，其余给 Experience。
        const episodeBudget = Math.max(1, Math.min(budget, Math.ceil(budget / 4)));
        const episodeList = this.deps.episodes.listForScene(scopeId, episodeBudget);
        const episodeIds = new Set(episodeList.map((episode) => episode.id));
        const experienceBudget = Math.max(0, budget - episodeList.length);
        const experienceList = this.deps.experiences.listForScene(scopeId, Math.max(budget, episodeList.length + experienceBudget));
        const now = (this.deps.now ?? Date.now)();
        const points = [];
        const positions = new Map();
        for (const episode of episodeList) {
            const position = spherePosition(episode.id, EPISODE_SHELL_RADIUS);
            positions.set(episode.id, position);
            points.push({
                id: episode.id,
                type: 'episode',
                label: truncate(episode.title?.trim() || `Episode ${episode.id.slice(-6)}`, 28),
                ...position,
                size: round2(2.6 + episode.importance * 1.6),
                importance: round4(episode.importance),
                activation: round4(activationOf(episode.startedAt, now)),
                createdAt: episode.startedAt,
                experienceCount: episode.experienceIds.length,
                ...(episode.summary ? { summary: truncate(episode.summary, 400) } : {}),
            });
        }
        // ---- Semantic Memory：大而稳定的核心节点（数量少、必须 clamp）----
        const memoryBudget = Math.max(0, Math.min(budget, Math.ceil(budget / 8)));
        const memoryList = memoryBudget > 0 && this.deps.memories
            ? this.deps.memories.list(scopeId, { status: 'active', limit: memoryBudget })
            : [];
        const edges = [];
        for (const memory of memoryList) {
            const position = spherePosition(memory.id, MEMORY_SHELL_RADIUS);
            positions.set(memory.id, position);
            points.push({
                id: memory.id,
                type: 'memory',
                kind: memory.kind,
                label: truncate(memory.subject?.trim() || memory.content, MEMORY_LABEL_CHARS),
                ...position,
                size: round2(memorySize(memory)),
                importance: round4(memory.importance),
                confidence: round4(memory.confidence),
                reinforcementCount: memory.reinforcementCount,
                activation: round4(activationOf(memory.lastReinforcedAt ?? memory.updatedAt, now)),
                createdAt: memory.createdAt,
                ...(memory.content ? { summary: truncate(memory.content, 200) } : {}),
            });
            // 证据边：memory --derived_from/supports--> episode，必须带 reason（spec §41/§44）。
            if (!this.deps.evidence)
                continue;
            for (const link of this.deps.evidence.listByMemory(memory.id)) {
                if (link.evidenceType !== 'episode')
                    continue;
                if (!episodeIds.has(link.evidenceId))
                    continue;
                edges.push({
                    a: link.evidenceId,
                    b: memory.id,
                    score: link.relation === 'derived_from' ? 0.95 : 0.8,
                    kind: link.relation === 'supersedes' ? 'supports' : 'derived_from',
                    reason: link.relation === 'derived_from'
                        ? '这条记忆由该段经历提炼而来'
                        : '这段经历支持这条记忆',
                });
            }
        }
        // ---- Pattern：深层稳定结构（数量必须远少于 Memory，且 size 必须 clamp）----
        const patternBudget = Math.max(0, Math.min(PATTERN_POINT_LIMIT, Math.ceil(budget / 40)));
        const patternList = patternBudget > 0 && this.deps.patterns
            ? this.deps.patterns
                .list(scopeId, { status: ['candidate', 'active', 'weakened'], limit: patternBudget })
                .slice(0, patternBudget)
            : [];
        for (const pattern of patternList) {
            const links = this.deps.patternEvidence?.listByPattern(pattern.id) ?? [];
            const supportIds = links.filter((link) => link.relation === 'supports').map((link) => link.memoryId);
            const position = centroidOf(supportIds, positions) ?? spherePosition(pattern.id, PATTERN_SHELL_RADIUS);
            positions.set(pattern.id, position);
            points.push({
                id: pattern.id,
                type: 'pattern',
                patternKind: pattern.kind,
                patternStatus: pattern.status,
                kind: 'principle',
                label: truncate(pattern.subject?.trim() || pattern.content, PATTERN_LABEL_CHARS),
                ...position,
                size: round2(patternSize(pattern)),
                importance: round4(pattern.importance),
                confidence: round4(pattern.confidence),
                supportCount: pattern.supportCount,
                stabilityScore: round4(stabilityScore(pattern, now)),
                activation: round4(activationOf(pattern.lastReinforcedAt ?? pattern.lastObservedAt, now)),
                createdAt: pattern.createdAt,
                ...(pattern.content ? { summary: truncate(pattern.content, 200) } : {}),
            });
            // Pattern --supported_by/contradicted_by--> Memory：每条边都要说明缘由（spec §45）。
            for (const link of links) {
                if (!positions.has(link.memoryId))
                    continue;
                edges.push({
                    a: pattern.id,
                    b: link.memoryId,
                    score: link.relation === 'contradicts' ? 0.5 : 0.92,
                    kind: link.relation === 'contradicts' ? 'contradicted_by' : 'supported_by',
                    reason: link.relation === 'contradicts'
                        ? '这条知识与该模式相冲突，正在削弱它'
                        : '这条知识是该模式的支持证据',
                });
            }
        }
        // 优先装「有归属」的 Experience（保证 contains 边完整），再用孤儿 Experience 补满预算。
        const attached = [];
        const orphans = [];
        for (const experience of experienceList) {
            if (experience.episodeId && episodeIds.has(experience.episodeId))
                attached.push(experience);
            else
                orphans.push(experience);
        }
        const selected = [...attached, ...orphans].slice(0, experienceBudget);
        for (const experience of selected) {
            const parentId = experience.episodeId && episodeIds.has(experience.episodeId) ? experience.episodeId : null;
            const anchor = parentId ? positions.get(parentId) : undefined;
            const offset = spherePosition(experience.id, EXPERIENCE_SHELL_MIN + unitRand(experience.id, 'nr') * (EXPERIENCE_SHELL_MAX - EXPERIENCE_SHELL_MIN));
            const position = anchor
                ? { x: round2(anchor.x + offset.x), y: round2(anchor.y + offset.y), z: round2(anchor.z + offset.z) }
                : { x: round2(offset.x), y: round2(offset.y), z: round2(offset.z) };
            positions.set(experience.id, position);
            points.push({
                id: experience.id,
                type: 'experience',
                sourceType: experience.sourceType,
                label: preview(experience.content, EXPERIENCE_LABEL_CHARS),
                ...position,
                size: round2(0.9 + experience.importance * 1.2),
                importance: round4(experience.importance),
                activation: round4(activationOf(experience.observedAt || experience.createdAt, now)),
                createdAt: experience.observedAt || experience.createdAt,
            });
            if (parentId) {
                // 每条边都要能解释自己（Stage 6 前端会把 reason 直接展示给用户）。
                edges.push({
                    a: parentId,
                    b: experience.id,
                    score: 0.9,
                    kind: 'contains',
                    reason: '这段经历归属于该段连续经历',
                });
            }
        }
        // ---- Episode 连续性边（Stage 4.5）：只在两端都出现在本次场景里时才画 ----
        // 关系不是证据：这里只是「这两段经历是连着的」，不改变任何权重与召回。
        let relationEdges = 0;
        if (this.deps.relations) {
            const relationLimit = Math.max(0, Math.min(budget * 2, 400));
            const relations = relationLimit > 0 ? this.deps.relations.listForScope(scopeId, relationLimit) : [];
            for (const relation of relations) {
                if (!positions.has(relation.sourceEpisodeId) || !positions.has(relation.targetEpisodeId))
                    continue;
                if (relation.relation !== 'continues' && relation.relation !== 'followup')
                    continue;
                edges.push({
                    a: relation.sourceEpisodeId,
                    b: relation.targetEpisodeId,
                    score: relation.confidence,
                    kind: relation.relation,
                    reason: relation.reason
                        ? `连续性：${relation.reason}`
                        : relation.relation === 'continues'
                            ? '这两段经历是同一段经历的延续'
                            : '这段经历是前一段的后续'
                });
                relationEdges += 1;
            }
        }
        points.sort((a, b) => (a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id < b.id ? -1 : 1));
        edges.sort((a, b) => (a.a === b.a ? (a.b < b.b ? -1 : 1) : a.a < b.a ? -1 : 1));
        return {
            scopeId,
            points,
            edges,
            stats: buildStats(points, edges, episodeList.length, selected.length, memoryList.length, patternList.length, relationEdges),
        };
    }
}
/** 稳定球面坐标：同 id → 同坐标。 */
function spherePosition(seed, radius) {
    const theta = unitRand(seed, 'theta') * Math.PI * 2;
    const phi = Math.acos(2 * unitRand(seed, 'phi') - 1);
    const r = radius * (0.72 + unitRand(seed, 'radius') * 0.28);
    return {
        x: round2(r * Math.sin(phi) * Math.cos(theta)),
        y: round2(r * Math.sin(phi) * Math.sin(theta)),
        z: round2(r * Math.cos(phi)),
    };
}
function activationOf(at, now) {
    const age = Math.max(0, now - at);
    return Math.min(1, Math.exp((-Math.LN2 * age) / DEFAULT_RECENCY_HALF_LIFE_MS));
}
/** Pattern 的视觉大小：重要、可信、被多条知识支持、且稳定 —— 但必须 clamp（spec §44）。 */
function patternSize(pattern) {
    const raw = PATTERN_SIZE_MIN +
        pattern.importance * 1.4 +
        pattern.confidence * 1.2 +
        Math.min(6, Math.max(0, pattern.supportCount)) * 0.3 +
        stabilityScore(pattern, pattern.lastObservedAt || pattern.createdAt) * 0.8;
    return Math.min(PATTERN_SIZE_MAX, Math.max(PATTERN_SIZE_MIN, raw));
}
/** 支持者的位置质心（spec §46）：模式长在它的证据之上，而不是随机独立坐标。 */
function centroidOf(ids, positions) {
    let x = 0;
    let y = 0;
    let z = 0;
    let count = 0;
    for (const id of ids) {
        const position = positions.get(id);
        if (!position)
            continue;
        x += position.x;
        y += position.y;
        z += position.z;
        count += 1;
    }
    if (count === 0)
        return null;
    return { x: round2(x / count), y: round2(y / count), z: round2(z / count) };
}
function memorySize(memory) {
    const raw = MEMORY_SIZE_MIN +
        memory.importance * 1.6 +
        memory.confidence * 1.2 +
        Math.min(4, Math.max(0, memory.reinforcementCount)) * 0.25;
    return Math.min(MEMORY_SIZE_MAX, Math.max(MEMORY_SIZE_MIN, raw));
}
function buildStats(points, edges, episodes, experiences, memories, patterns, relations) {
    let from = Number.POSITIVE_INFINITY;
    let to = 0;
    for (const point of points) {
        if (point.createdAt < from)
            from = point.createdAt;
        if (point.createdAt > to)
            to = point.createdAt;
    }
    return {
        experiences,
        episodes,
        memories,
        patterns,
        relations,
        edges: edges.length,
        span: points.length > 0 ? { from, to } : { from: 0, to: 0 },
    };
}
function round2(value) {
    return Math.round(value * 100) / 100;
}
function round4(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
}
