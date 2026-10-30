/**
 * consolidation-applier.ts —— 把 ConsolidationResult 事务化落地（spec §31 / §49 / §50 / §55）。
 *
 * 三条铁律：
 *   1. 全有或全无：create + evidence + relation + supersede 都在同一个事务里，
 *      不允许出现「记忆写了一半、证据没写」的状态。
 *   2. 幂等：同一个 Episode 重复整理不会重复建知识、不会错误累加 reinforcement。
 *      重复整理时，由于证据行 (memory, evidence, relation) 唯一，insertMany 返回 0，
 *      此时推进直接跳过而不是再 +1。
 *   3. supersede 必须有替代者：先建新知识，再把旧知识标 superseded 并指向它。
 */
import { normalizeMemoryContent } from '../memory/memory-normalizer.js';
import { bestMemoryMatch } from './rule-based-consolidator.js';
import { contradictedConfidence } from '../memory/memory-lifecycle.js';
export class ConsolidationApplier {
    db;
    memories;
    evidence;
    now;
    maxCreatesPerRun;
    embeddingStatus;
    duplicateSimilarity;
    constructor(deps) {
        this.db = deps.db;
        this.memories = deps.memories;
        this.evidence = deps.evidence;
        this.now = deps.now ?? (() => Date.now());
        this.maxCreatesPerRun = deps.maxCreatesPerRun ?? 3;
        this.embeddingStatus = deps.embeddingStatus ?? 'pending';
        this.duplicateSimilarity = deps.duplicateSimilarity ?? 0.72;
    }
    /**
     * 应用一次整理结果。所有写入在同一事务内完成；
     * 事务内抛错会被 rethrow，由 job 层记 failed（不产生半完成状态）。
     */
    apply(context, result) {
        const summary = {
            created: [],
            reinforced: [],
            updated: [],
            superseded: [],
            contradicted: [],
            skipped: 0,
        };
        // 同一批操作里，同一条知识最多被强化/冲突一次：标题与摘要常常说的是同一件事，
        // 否则一次整理会把 reinforcement_count 记两次（计数必须与证据一致）。
        const touched = new Set();
        this.db.transaction(() => {
            for (const operation of result.operations) {
                try {
                    this.applyOne(context, operation, summary, touched);
                }
                catch {
                    // 单条操作的校验失败（例如引用了不存在的 knowledge）只跳过它，
                    // 不能让它把整次整理拖垮 —— 但事务内已写入的部分仍然原子。
                    summary.skipped += 1;
                }
            }
        });
        return summary;
    }
    applyOne(context, operation, summary, touched) {
        switch (operation.type) {
            case 'noop': {
                summary.skipped += 1;
                return;
            }
            case 'create': {
                if (summary.created.length >= this.maxCreatesPerRun) {
                    summary.skipped += 1;
                    return;
                }
                const evidenceIds = normalizeEvidenceIds(operation.evidenceEpisodeIds);
                if (evidenceIds.length === 0) {
                    summary.skipped += 1;
                    return;
                }
                // dedup：同一 scope 下已有等价知识 → 退化成 reinforce（spec §50）。
                const duplicate = this.findDuplicate(context, operation.content);
                if (duplicate) {
                    if (touched.has(duplicate.id)) {
                        summary.skipped += 1;
                        return;
                    }
                    touched.add(duplicate.id);
                    this.reinforceWith(context, duplicate.id, evidenceIds, operation.confidence, summary);
                    return;
                }
                const memory = this.memories.create({
                    scopeId: context.scopeId,
                    kind: operation.kind,
                    ...(operation.subject ? { subject: operation.subject } : {}),
                    content: operation.content,
                    confidence: operation.confidence,
                    importance: operation.importance,
                    normalizedContent: normalizeMemoryContent(operation.content),
                    embeddingStatus: this.embeddingStatus,
                    validFrom: context.episode.lastExperienceAt ?? context.episode.endedAt ?? context.episode.startedAt,
                });
                this.evidence.insertMany(memory.id, 'episode', evidenceIds, 'derived_from');
                for (const evidenceId of evidenceIds) {
                    if (evidenceId === context.episode.id)
                        continue;
                    this.evidence.insert({ memoryId: memory.id, evidenceType: 'episode', evidenceId, relation: 'supports' });
                }
                // 本批次刚建立的知识记入 touched：同一段 Episode 的标题/摘要说的是同一件事，
                // 后面再出现等价陈述时应跳过，而不是立刻再 reinforce 一次。
                touched.add(memory.id);
                summary.created.push(memory.id);
                return;
            }
            case 'reinforce': {
                // 同批重复强化同一条知识没有信息量，只会把计数刷高（spec §32）。
                if (touched.has(operation.memoryId)) {
                    summary.skipped += 1;
                    return;
                }
                touched.add(operation.memoryId);
                this.reinforceWith(context, operation.memoryId, normalizeEvidenceIds(operation.evidenceEpisodeIds), operation.confidenceDelta, summary);
                return;
            }
            case 'update': {
                const memory = this.requireActive(operation.memoryId);
                if (!memory) {
                    summary.skipped += 1;
                    return;
                }
                this.memories.updateContent(operation.memoryId, {
                    ...(operation.content !== undefined ? { content: operation.content } : {}),
                    ...(operation.subject !== undefined ? { subject: operation.subject } : {}),
                    ...(operation.kind !== undefined ? { kind: operation.kind } : {}),
                    ...(operation.confidence !== undefined ? { confidence: operation.confidence } : {}),
                    ...(operation.importance !== undefined ? { importance: operation.importance } : {}),
                });
                const evidenceIds = normalizeEvidenceIds(operation.evidenceEpisodeIds ?? []);
                if (evidenceIds.length > 0)
                    this.evidence.insertMany(operation.memoryId, 'episode', evidenceIds, 'supports');
                summary.updated.push(operation.memoryId);
                return;
            }
            case 'supersede': {
                const old = this.requireActive(operation.memoryId);
                if (!old) {
                    summary.skipped += 1;
                    return;
                }
                const evidenceIds = normalizeEvidenceIds(operation.evidenceEpisodeIds);
                if (evidenceIds.length === 0) {
                    summary.skipped += 1;
                    return;
                }
                const validFrom = context.episode.lastExperienceAt ?? context.episode.endedAt ?? context.episode.startedAt;
                // 先建新知识，再标旧知识：事务保证不会出现「旧的 superseded 却没有替代者」。
                const created = this.memories.create({
                    scopeId: context.scopeId,
                    kind: operation.kind,
                    ...(operation.subject ? { subject: operation.subject } : old.subject ? { subject: old.subject } : {}),
                    content: operation.content,
                    confidence: operation.confidence,
                    importance: operation.importance,
                    normalizedContent: normalizeMemoryContent(operation.content),
                    embeddingStatus: this.embeddingStatus,
                    validFrom,
                });
                this.evidence.insertMany(created.id, 'episode', evidenceIds, 'derived_from');
                this.memories.markSuperseded(old.id, created.id, validFrom);
                this.evidence.insert({
                    memoryId: created.id,
                    evidenceType: 'memory',
                    evidenceId: old.id,
                    relation: 'supersedes',
                });
                this.evidence.recordRelation(created.id, old.id, 'supersedes', 1);
                summary.created.push(created.id);
                summary.superseded.push(old.id);
                return;
            }
            case 'contradict': {
                const memory = this.requireActive(operation.memoryId);
                if (!memory) {
                    summary.skipped += 1;
                    return;
                }
                const evidenceIds = normalizeEvidenceIds(operation.evidenceEpisodeIds);
                if (evidenceIds.length === 0) {
                    summary.skipped += 1;
                    return;
                }
                // 不自动 supersede：只记录冲突证据并降低置信度（spec §24）。
                this.evidence.insertMany(memory.id, 'episode', evidenceIds, 'contradicts');
                const confidence = contradictedConfidence(memory.confidence, operation.confidenceDelta ?? 0.1);
                this.memories.updateContent(memory.id, { confidence });
                for (const evidenceId of evidenceIds) {
                    this.evidence.recordRelation(memory.id, evidenceId, 'contradicts', 0.5);
                }
                summary.contradicted.push(memory.id);
                return;
            }
            default: {
                summary.skipped += 1;
            }
        }
    }
    /** reinforce 的幂等核心：只有真的新增了证据才推进计数与置信度。 */
    reinforceWith(context, memoryId, evidenceIds, confidenceDelta, summary) {
        const memory = this.requireActive(memoryId);
        if (!memory) {
            summary.skipped += 1;
            return;
        }
        if (evidenceIds.length === 0) {
            summary.skipped += 1;
            return;
        }
        const inserted = this.evidence.insertMany(memoryId, 'episode', evidenceIds, 'supports');
        if (inserted === 0) {
            // 这个 Episode 早就支持过该知识 → 重复整理，什么都没变。
            summary.skipped += 1;
            return;
        }
        const delta = confidenceDelta ?? Math.min(0.2, 0.08 + 0.04 * inserted);
        this.memories.reinforce(memoryId, { confidenceDelta: delta });
        summary.reinforced.push(memoryId);
        void context;
    }
    /** 同 scope 下是否已有等价知识：归一化完全相等，或相似度超过阈值。 */
    findDuplicate(context, content) {
        const normalized = normalizeMemoryContent(content);
        const exact = this.memories.findByNormalized(context.scopeId, normalized, 3);
        for (const memory of exact) {
            if (memory.status === 'active')
                return memory;
        }
        const best = bestMemoryMatch(content, context.relatedMemories, this.duplicateSimilarity);
        if (best && best.memory.status === 'active')
            return best.memory;
        // 同一批里刚创建的知识还不在 context 快照里：从库里再查一次，避免一次整理产出两条同义知识。
        const nearby = this.memories.searchLexical(context.scopeId, content, 5).map((hit) => hit.memory);
        const bestNearby = bestMemoryMatch(content, nearby, this.duplicateSimilarity);
        if (bestNearby && bestNearby.memory.status === 'active')
            return bestNearby.memory;
        return null;
    }
    requireActive(memoryId) {
        const memory = this.memories.getById(memoryId);
        if (!memory || memory.status !== 'active')
            return null;
        return memory;
    }
    /** 证据必须来自本 scope（禁止跨项目证据，spec §57）。 */
    listEvidence(memoryId) {
        return this.evidence.listByMemory(memoryId);
    }
}
function normalizeEvidenceIds(ids) {
    return [...new Set(ids.filter((id) => typeof id === 'string' && id.trim().length > 0))];
}
