/**
 * pattern-applier.ts —— 把结构化 PatternOperation 落到数据库（spec §55）。
 *
 * 三条硬约束：
 *   1. **整批事务化**：create / evidence / reinforce / supersede 都在一个事务里，绝不半完成。
 *   2. **幂等**：同一 Memory 重复分析 3 次，Pattern 数量、supportCount、Evidence 都不重复增长。
 *      - evidence 唯一键 (pattern_id, memory_id, relation) + INSERT OR IGNORE；
 *      - support_count 只按「真实新增的证据条数」增长；
 *      - 同一批次里同一个 Pattern 只被操作一次（touched 集合，沿用 Stage 3 的教训）。
 *   3. **先立后废**：supersede 必须先创建新 Pattern 再标记旧的，绝不允许只标旧不建新。
 */
import { initialPatternStatus, meetsActivationGate, shouldWeakenStatus, } from '../pattern/pattern-lifecycle.js';
import { bigramSimilarity } from '../recall/tokenizer.js';
export class PatternApplier {
    db;
    patterns;
    evidence;
    now;
    embeddingStatus;
    maxCreatesPerRun;
    duplicateSimilarity;
    minSupport;
    activationThreshold;
    constructor(deps) {
        this.db = deps.db;
        this.patterns = deps.patterns;
        this.evidence = deps.evidence;
        this.now = deps.now ?? (() => Date.now());
        this.embeddingStatus = deps.embeddingStatus ?? 'pending';
        this.maxCreatesPerRun = Math.max(1, Math.round(deps.maxCreatesPerRun ?? 2));
        this.duplicateSimilarity = deps.duplicateSimilarity ?? 0.72;
        this.minSupport = Math.max(2, Math.round(deps.minSupport));
        this.activationThreshold = deps.activationThreshold;
    }
    apply(context, result) {
        const state = {
            created: [],
            reinforced: [],
            weakened: [],
            superseded: [],
            skipped: 0,
            touched: new Set(),
            evidenceTouched: new Set(),
        };
        const operations = Array.isArray(result?.operations) ? result.operations : [];
        this.db.transaction(() => {
            for (const operation of operations) {
                try {
                    this.applyOne(context, operation, state);
                }
                catch {
                    // 单条操作失败不影响其余操作；计数留痕，绝不半写。
                    state.skipped += 1;
                }
            }
        });
        return {
            created: state.created,
            reinforced: state.reinforced,
            weakened: state.weakened,
            superseded: state.superseded,
            skipped: state.skipped,
        };
    }
    applyOne(context, operation, state) {
        switch (operation.type) {
            case 'create':
                this.applyCreate(context, operation, state);
                return;
            case 'reinforce':
                this.applyReinforce(context, operation, state);
                return;
            case 'weaken':
                this.applyWeaken(context, operation, state);
                return;
            case 'supersede':
                this.applySupersede(context, operation, state);
                return;
            case 'noop':
                return;
            default:
                state.skipped += 1;
        }
    }
    // --------------------------------------------------------------- create
    applyCreate(context, operation, state) {
        const supporters = this.resolveMemories(context, operation.supportingMemoryIds);
        // Pattern 不得从单个 Memory 创建（spec §4）：硬下限 2，宁可不做。
        if (supporters.length < 2) {
            state.skipped += 1;
            return;
        }
        const content = operation.content.trim();
        if (content.length < 6) {
            state.skipped += 1;
            return;
        }
        const confidence = clamp01(operation.confidence);
        const importance = clamp01(operation.importance);
        const policy = { minSupport: this.minSupport, activationThreshold: this.activationThreshold };
        // Dedup（spec §52）：命中的已有模式优先 reinforce，不造第二份同样的知识。
        const duplicate = this.findDuplicate(context, content);
        if (duplicate) {
            // 同批里同一个模式只强化一次（否则 supportCount 会被同一批重复刷高）。
            if (state.touched.has(duplicate.id)) {
                state.skipped += 1;
                return;
            }
            state.touched.add(duplicate.id);
            const inserted = this.attachEvidence(duplicate.id, supporters, 'supports', state);
            if (inserted === 0) {
                state.skipped += 1;
                return;
            }
            this.patterns.reinforce(duplicate.id, {
                evidenceAdded: inserted,
                observedAt: latestObserved(supporters),
                at: this.now(),
            });
            this.tryActivate(duplicate.id, policy);
            state.reinforced.push(duplicate.id);
            return;
        }
        if (state.created.length >= this.maxCreatesPerRun) {
            state.skipped += 1;
            return;
        }
        const observed = observedRange(supporters);
        const created = this.patterns.create({
            scopeId: context.scopeId,
            kind: operation.kind,
            content,
            ...(operation.subject ? { subject: operation.subject } : {}),
            ...(operation.domain ? { domain: operation.domain } : {}),
            confidence,
            importance,
            status: initialPatternStatus(supporters.length, confidence, policy),
            firstObservedAt: observed.first,
            lastObservedAt: observed.last,
            embeddingStatus: this.embeddingStatus,
        });
        const inserted = this.attachEvidence(created.id, supporters, 'supports', state);
        const supportCount = Math.max(inserted, 0);
        const stored = this.patterns.getById(created.id) ?? created;
        // 证据条数就是支持数：用一次显式改写保证 DB 与 evidence 对齐。
        if (supportCount !== stored.supportCount) {
            this.db.run('UPDATE patterns SET support_count = ? WHERE id = ?', supportCount, created.id);
        }
        const activated = this.tryActivate(created.id, policy);
        if (!activated && stored.status === 'active') {
            // 门槛不足时回到 candidate（候选先存着，达到支持数再激活）。
            this.patterns.setStatus(created.id, 'candidate', this.now());
        }
        state.touched.add(created.id);
        state.created.push(created.id);
    }
    // ------------------------------------------------------------- reinforce
    applyReinforce(context, operation, state) {
        const pattern = this.patterns.getById(operation.patternId);
        if (!pattern || pattern.status === 'superseded' || pattern.status === 'archived') {
            state.skipped += 1;
            return;
        }
        if (state.touched.has(pattern.id)) {
            state.skipped += 1;
            return;
        }
        const supporters = this.resolveMemories(context, operation.supportingMemoryIds);
        if (supporters.length === 0) {
            state.skipped += 1;
            return;
        }
        const inserted = this.attachEvidence(pattern.id, supporters, 'supports', state);
        if (inserted === 0) {
            // 证据已经全部存在 → 重复分析，不涨计数（幂等核心）。
            state.skipped += 1;
            return;
        }
        state.touched.add(pattern.id);
        this.patterns.reinforce(pattern.id, {
            evidenceAdded: inserted,
            observedAt: latestObserved(supporters),
            ...(operation.confidenceDelta === undefined ? {} : { confidenceDelta: operation.confidenceDelta }),
            at: this.now(),
        });
        this.tryActivate(pattern.id, { minSupport: this.minSupport, activationThreshold: this.activationThreshold });
        state.reinforced.push(pattern.id);
    }
    // ---------------------------------------------------------------- weaken
    applyWeaken(context, operation, state) {
        const pattern = this.patterns.getById(operation.patternId);
        if (!pattern || pattern.status === 'superseded' || pattern.status === 'archived' || pattern.status === 'stale') {
            state.skipped += 1;
            return;
        }
        if (state.touched.has(pattern.id)) {
            state.skipped += 1;
            return;
        }
        const contradicting = this.resolveMemories(context, operation.contradictingMemoryIds);
        if (contradicting.length === 0) {
            state.skipped += 1;
            return;
        }
        const inserted = this.attachEvidence(pattern.id, contradicting, 'contradicts', state);
        if (inserted === 0) {
            state.skipped += 1;
            return;
        }
        state.touched.add(pattern.id);
        const weakened = this.patterns.weaken(pattern.id, {
            evidenceAdded: inserted,
            ...(operation.confidenceDelta === undefined ? {} : { confidenceDelta: operation.confidenceDelta }),
            at: this.now(),
        });
        // 一次例外不推翻模式（spec §21 / §64）：只有弱到阈值以下才降到 weakened。
        if (weakened && weakened.status === 'active' && shouldWeakenStatus(weakened)) {
            this.patterns.markWeakened(pattern.id, this.now());
        }
        state.weakened.push(pattern.id);
    }
    // ------------------------------------------------------------- supersede
    applySupersede(context, operation, state) {
        const old = this.patterns.getById(operation.patternId);
        if (!old || old.status === 'superseded' || old.status === 'archived') {
            state.skipped += 1;
            return;
        }
        const supporters = this.resolveMemories(context, operation.supportingMemoryIds);
        if (supporters.length < 2) {
            state.skipped += 1;
            return;
        }
        const content = operation.content.trim();
        // 先立后废：必须先建出新模式，才允许把旧模式标为 superseded。
        const observed = observedRange(supporters);
        const created = this.patterns.create({
            scopeId: context.scopeId,
            kind: operation.kind,
            content,
            ...(operation.subject ? { subject: operation.subject } : {}),
            ...(operation.domain ? { domain: operation.domain } : {}),
            confidence: clamp01(operation.confidence),
            importance: clamp01(operation.importance),
            status: 'active',
            firstObservedAt: observed.first,
            lastObservedAt: observed.last,
            embeddingStatus: this.embeddingStatus,
        });
        const inserted = this.attachEvidence(created.id, supporters, 'supports', state);
        if (inserted !== created.supportCount) {
            this.db.run('UPDATE patterns SET support_count = ? WHERE id = ?', inserted, created.id);
        }
        // 旧模式的证据不丢：作为新模式的历史支持一并保留。
        const inherited = this.evidence.listMemoryIds(old.id, 'supports', 200);
        if (inherited.length > 0)
            this.attachEvidence(created.id, inherited, 'supports', state);
        this.patterns.markSuperseded(old.id, created.id, this.now());
        state.touched.add(created.id);
        state.touched.add(old.id);
        state.created.push(created.id);
        state.superseded.push(old.id);
    }
    // --------------------------------------------------------------- helpers
    resolveMemories(context, ids) {
        if (ids.length === 0)
            return [];
        const pool = new Map();
        pool.set(context.triggerMemory.id, context.triggerMemory);
        for (const memory of context.relatedMemories)
            pool.set(memory.id, memory);
        const out = [];
        const seen = new Set();
        for (const id of ids) {
            if (typeof id !== 'string' || seen.has(id))
                continue;
            const memory = pool.get(id);
            if (!memory)
                continue;
            seen.add(id);
            out.push(memory);
        }
        return out;
    }
    /** 写入证据并返回真正新增的条数（幂等的唯一来源）。 */
    attachEvidence(patternId, memories, relation, state) {
        const ids = [];
        for (const item of memories) {
            const id = typeof item === 'string' ? item : item.id;
            const key = `${patternId}:${id}:${relation}`;
            if (state.evidenceTouched.has(key))
                continue;
            state.evidenceTouched.add(key);
            ids.push(id);
        }
        if (ids.length === 0)
            return 0;
        return this.evidence.insertMany(patternId, ids, relation);
    }
    /** 支持数达到门槛且置信度够 → candidate 升 active。 */
    tryActivate(patternId, policy) {
        const pattern = this.patterns.getById(patternId);
        if (!pattern)
            return false;
        if (pattern.status === 'active')
            return true;
        if (pattern.status !== 'candidate' && pattern.status !== 'weakened')
            return false;
        if (!meetsActivationGate(pattern, policy))
            return false;
        this.patterns.markActive(patternId, this.now());
        return true;
    }
    findDuplicate(context, content) {
        const trimmed = content.trim();
        for (const pattern of context.existingPatterns) {
            if (pattern.status === 'superseded' || pattern.status === 'archived')
                continue;
            if (pattern.content.trim() === trimmed)
                return pattern;
        }
        // 上下文快照可能不含刚建的模式，再按库里的候选比一次。
        const candidates = this.patterns.findCandidates(context.scopeId, 20);
        for (const pattern of candidates) {
            if (pattern.content.trim() === trimmed)
                return pattern;
            const similarity = bigramSimilarity(pattern.content, trimmed);
            if (similarity >= this.duplicateSimilarity)
                return pattern;
        }
        return null;
    }
    /** 模式 → 支持它的 Memory（供 inspect / recall 展开）。 */
    listEvidence(patternId) {
        return this.evidence.listMemoryIds(patternId, 'supports', 200);
    }
}
/** 支持者覆盖的时间范围：first 取最早、last 取最晚（spec §28）。 */
export function observedRange(memories) {
    let first = Number.POSITIVE_INFINITY;
    let last = 0;
    for (const memory of memories) {
        const start = memory.validFrom ?? memory.createdAt;
        first = Math.min(first, start);
        last = Math.max(last, memory.updatedAt || memory.createdAt);
    }
    if (!Number.isFinite(first)) {
        const now = Date.now();
        return { first: now, last: now };
    }
    return { first, last: Math.max(first, last) };
}
function latestObserved(memories) {
    let last = 0;
    for (const memory of memories)
        last = Math.max(last, memory.updatedAt || memory.createdAt);
    return last;
}
function clamp01(value) {
    if (!Number.isFinite(value))
        return 0.5;
    return Math.min(1, Math.max(0, value));
}
