/**
 * memory-review-service.ts —— Stage 4：Memory / Pattern 的 Review 与「变旧」降级（spec §31–§36）。
 *
 * 三条必须守住的设计前提：
 *   1. Review 不删除任何东西，也绝不把知识标成 superseded —— superseded 需要明确的新证据，
 *      属于 Consolidation 的职责（spec §35）。这里最多只做 active → stale。
 *   2. 「老」不等于「错」（spec §33）：只有「很久没有新证据支持」且「置信度已经偏低」的知识
 *      才 mark_stale；高置信度的老知识只记一次 review（keep），status 保持 active。
 *   3. Pattern 的退化必须分两步：active --(长期无支持 + 有反证)--> weakened
 *      --(仍然没有支持)--> stale。一次扫描绝不连跳两级。
 *
 * 所有时间都走注入的 now()（默认 Date.now），测试才能用可控时钟验证到期边界。
 */
/** 一条知识当前的 Review 状态：status 已是 stale 时以 stale 为准（避免手工改 status 后读回 fresh）。 */
function currentReviewStatus(memory) {
    if (memory.status === 'stale')
        return 'stale';
    return memory.reviewStatus ?? 'fresh';
}
function decisionResult(memoryId, decision, reviewStatus) {
    return { memoryId, decision, reviewStatus };
}
export class MemoryReviewService {
    memories;
    patterns;
    now;
    settings;
    constructor(deps) {
        this.memories = deps.memories;
        this.patterns = deps.patterns;
        this.now = deps.now ?? (() => Date.now());
        this.settings = deps.settings;
    }
    /** 到期但还没进 review 队列的知识（按最久未支持排序，最多 maxItemsPerRun 条）。 */
    findDueMemories(scopeId) {
        return this.memories.listDueForReview(scopeId, {
            staleAfterMs: this.settings.memoryStaleAfterMs,
            limit: this.limit(),
            now: this.now(),
        });
    }
    /**
     * 复核单条知识：keep（仍 active）或 mark_stale（status='stale'）。
     *
     * 只处理 active 的知识；superseded / expired / stale 一律 keep 且不改动 ——
     * Review 不是回收站，历史该由 Consolidation 显式 supersede。
     */
    reviewMemory(memoryId) {
        const memory = this.memories.getById(memoryId);
        if (!memory)
            return null;
        if (memory.status !== 'active') {
            return decisionResult(memoryId, 'keep', currentReviewStatus(memory));
        }
        const at = this.now();
        const staleConfidence = this.settings.memoryStaleConfidence;
        if (memory.confidence < staleConfidence) {
            // stale 只表示「旧了、该重新确认」，行仍然存在，更不会被 supersede。
            this.memories.setStatus(memoryId, 'stale', at);
            this.memories.markReviewed(memoryId, 'stale', at);
            return decisionResult(memoryId, 'mark_stale', 'stale');
        }
        // 高置信度的老知识只是「看过、确认仍然成立」。
        this.memories.markReviewed(memoryId, 'reviewed', at);
        return decisionResult(memoryId, 'keep', 'reviewed');
    }
    /**
     * 扫描并降级到期 Pattern（active→weakened→stale），返回本次变更数。
     *
     * 单条失败只跳过：一次坏数据不该让整轮 Review 失败（下轮还会再扫到）。
     */
    sweepPatterns(scopeId) {
        const at = this.now();
        let due;
        try {
            due = this.patterns.listDueForReview(scopeId, {
                staleAfterMs: this.settings.patternStaleAfterMs,
                limit: this.limit(),
                now: at,
            });
        }
        catch {
            return { weakened: 0, stale: 0 };
        }
        let weakened = 0;
        let stale = 0;
        for (const pattern of due) {
            try {
                if (pattern.status === 'active' && pattern.contradictionCount > 0) {
                    this.patterns.markWeakened(pattern.id, at);
                    weakened += 1;
                }
                else if (pattern.status === 'weakened') {
                    this.patterns.markStale(pattern.id, at);
                    stale += 1;
                }
                else {
                    // 没有反证的 active（或其它可复核状态）：只记录「看过」，不改状态。
                    this.patterns.markReviewed(pattern.id, at);
                }
            }
            catch {
                // 跳过这一条，继续处理同批其它 Pattern。
            }
        }
        return { weakened, stale };
    }
    /** status API 用：当前到期数量（只读，不改状态）。 */
    dueCounts(scopeId) {
        const at = this.now();
        const dueMemories = this.memories.countDueForReview(scopeId, this.settings.memoryStaleAfterMs, at);
        // Pattern 侧没有 countDueForReview：用同口径的 list 取长度，limit 放大到单轮上限的 5 倍。
        const duePatterns = this.patterns.listDueForReview(scopeId, {
            staleAfterMs: this.settings.patternStaleAfterMs,
            limit: Math.max(50, this.limit() * 5),
            now: at,
        }).length;
        return { dueMemories, duePatterns };
    }
    /** maxItemsPerRun 至少为 1，避免配置成 0 时整条 Review 永远不动。 */
    limit() {
        return Math.max(1, Math.floor(this.settings.maxItemsPerRun));
    }
}
