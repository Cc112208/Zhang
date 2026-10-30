/**
 * pattern-lifecycle.ts —— Pattern 的纯函数生命周期逻辑（不碰数据库）。
 *
 * 关键约束（spec §4 / §22 / §29）：
 *   - Pattern 不得从单个 Memory 创建：minSupport 默认 3。
 *   - candidate → active 需要 supportCount >= minSupport 且 confidence >= activationThreshold。
 *   - stability 是内部计算值：confidence × 时间跨度 × 支持度 × 反证惩罚，不追求精确公式。
 *
 * **Pattern is descriptive. Skill is executable.** 这里只有描述性判断，没有任何执行能力。
 */
function clamp01(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.min(1, Math.max(0, value));
}
export function round4(value) {
    return Math.round(value * 10_000) / 10_000;
}
/**
 * 稳定性 = 置信度 × 支持度因子 × 时间跨度因子 × 反证惩罚（spec §29）。
 * 只用于排序 / Scene 大小 / 之后 Review 判断，不参与"是否 active"的硬门槛。
 */
export function stabilityParts(pattern, now) {
    const support = Math.max(0, pattern.supportCount);
    const supportFactor = clamp01(0.4 + 0.6 * Math.min(1, support / 4));
    const spanMs = Math.max(0, pattern.lastObservedAt - pattern.firstObservedAt);
    const spanDays = spanMs / (24 * 60 * 60 * 1000);
    const spanFactor = clamp01(0.5 + 0.5 * Math.min(1, spanDays / 30));
    const contradictionPenalty = 1 / (1 + Math.max(0, pattern.contradictionCount) * 0.6);
    const recencyMs = Math.max(0, now - (pattern.lastObservedAt || pattern.firstObservedAt));
    const recencyFactor = clamp01(1 - Math.min(1, recencyMs / (180 * 24 * 60 * 60 * 1000)) * 0.25);
    return { supportFactor, spanFactor, contradictionPenalty: round4(contradictionPenalty * recencyFactor) };
}
export function stabilityScore(pattern, now = Date.now()) {
    const parts = stabilityParts(pattern, now);
    return round4(clamp01(pattern.confidence) * parts.supportFactor * parts.spanFactor * parts.contradictionPenalty);
}
/** candidate → active 的硬门槛（spec §22）。 */
export function meetsActivationGate(pattern, policy) {
    return pattern.supportCount >= Math.max(2, policy.minSupport) && pattern.confidence >= policy.activationThreshold;
}
/** 根据门槛决定新模式的初始状态：候选先存着，达到门槛才 active。 */
export function initialPatternStatus(supportCount, confidence, policy) {
    return supportCount >= Math.max(2, policy.minSupport) && confidence >= policy.activationThreshold
        ? 'active'
        : 'candidate';
}
/** 多段证据的初始置信度：证据越多越可信，但单批不超过 0.8。 */
export function initialPatternConfidence(memories) {
    if (memories.length === 0)
        return 0.5;
    const avg = memories.reduce((sum, memory) => sum + clamp01(memory.confidence), 0) / memories.length;
    const supportBonus = Math.min(0.12, (memories.length - 1) * 0.03);
    return round4(clamp01(0.55 + avg * 0.2 + supportBonus));
}
/** 支持强化：`1-(1-c)(1-d)`，一次强化永远不会变成 1.0。 */
export function reinforcedConfidence(current, delta = 0.12) {
    const d = clamp01(delta);
    return round4(clamp01(1 - (1 - clamp01(current)) * (1 - d)));
}
/** 弱化：只降置信度，不直接改状态（spec §20 / §64）。 */
export function weakenedConfidence(current, delta = 0.1) {
    return round4(clamp01(clamp01(current) - clamp01(delta)));
}
/** 冲突/弱化到什么程度才值得把状态降级（仍然不删除历史）。 */
export function shouldWeakenStatus(pattern) {
    return pattern.confidence < 0.45 || pattern.contradictionCount >= Math.max(2, pattern.supportCount);
}
/** 时间跨度（天），用于展示"这是最近才出现还是持续半年了"。 */
export function observedSpanDays(pattern) {
    const span = Math.max(0, pattern.lastObservedAt - pattern.firstObservedAt);
    return Math.round(span / (24 * 60 * 60 * 1000));
}
export const PATTERN_CONCEPTS = [
    {
        id: 'avoid_infra_complexity',
        statement: '该项目在早期架构决策中持续倾向避免过早引入额外基础设施，优先选择简单、本地、当前规模够用的方案。',
        kind: 'recurring_decision',
        tokens: [
            '简单',
            '轻量',
            '复杂度',
            '复杂',
            '额外',
            '没必要',
            '不需要',
            '过度',
            '过早',
            '单进程',
            '够用',
            '足够',
            '运维',
            '部署',
            '基础设施',
            '本地',
            '当前规模',
        ],
    },
    {
        id: 'avoid_extra_services',
        statement: '该项目反复推迟引入额外的独立服务组件（Redis / 消息队列等），只在明确需要时才考虑。',
        kind: 'recurring_decision',
        tokens: ['redis', '消息队列', 'kafka', '队列', '缓存服务', '中间件', '额外服务', '独立服务'],
    },
    {
        id: 'avoid_graph_database',
        statement: '该项目多次明确暂不引入图数据库 / 知识图谱这类重组件。',
        kind: 'recurring_problem',
        tokens: ['neo4j', '图数据库', '知识图谱', '图谱'],
    },
    {
        id: 'local_first',
        statement: '该项目长期倾向本地优先（数据与计算尽量留在本地），而不是依赖外部托管。',
        kind: 'preference',
        tokens: ['本地', '本地优先', '自托管', '离线', '自己部署', '本地文件'],
    },
    {
        id: 'upgrade_after_scale',
        statement: '该项目的升级路径是"先简单，出现明确规模压力后再升级"，而不是提前复杂化。',
        kind: 'strategy',
        tokens: ['规模', '压力', '之后再', '再升级', '等有需要', '证明有需要', '迁移', '升级'],
    },
    {
        id: 'hosted_cloud_shift',
        statement: '该项目近期更多采用托管云服务，说明基础设施策略正在从"本地自建"向"托管"转移。',
        kind: 'trend',
        tokens: ['云', '托管', 'managed', '云服务', '云数据库', 'saas'],
    },
];
/** 命中的概念 id 列表（顺序稳定，便于测试）。 */
export function conceptsOf(text) {
    const normalized = text.toLowerCase();
    const hits = [];
    for (const concept of PATTERN_CONCEPTS) {
        if (concept.tokens.some((token) => normalized.includes(token)))
            hits.push(concept.id);
    }
    return hits;
}
export function conceptById(id) {
    return PATTERN_CONCEPTS.find((concept) => concept.id === id);
}
/** 两段文本共享的概念（用于把"同主题但不同文本"的知识聚在一起）。 */
export function sharedConcepts(a, b) {
    const setB = new Set(conceptsOf(b));
    return conceptsOf(a).filter((id) => setB.has(id));
}
/**
 * 一组 Memory 里出现次数最多的概念（出现 >= minSupport 才算模式候选）。
 * 返回 null 表示证据不足以说"反复出现"，应该 no_op。
 */
export function dominantConcept(texts, minSupport) {
    const counts = new Map();
    for (const text of texts) {
        for (const id of new Set(conceptsOf(text)))
            counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    let best = null;
    for (const concept of PATTERN_CONCEPTS) {
        const support = counts.get(concept.id) ?? 0;
        if (support < Math.max(2, minSupport))
            continue;
        if (!best || support > best.support)
            best = { conceptId: concept.id, support };
    }
    return best;
}
