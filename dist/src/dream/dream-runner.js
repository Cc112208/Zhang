/**
 * dream-runner.ts —— 「Dream」的唯一职责（spec §11 / §47 / §48）。
 *
 * Dream 不是神秘 Agent，也不自己实现队列：
 *   它只负责「发现谁该被整理」并把持久化 job 排进 Stage 2 的 JobRunner。
 *
 * 三条触发路径（都不依赖夜间定时）：
 *   A. Episode 关闭 + 摘要就绪 → enqueue（由 service 的 onEpisodeClosed / 摘要 job 触发）
 *   B. 插件启动 → 扫描库里漏掉的 closed episode（startup recovery）
 *   C. 手动 maintenance（runDreamMaintenance）
 */
export class DreamRunner {
    episodes;
    jobs;
    maxPerScope;
    logger;
    constructor(deps) {
        this.episodes = deps.episodes;
        this.jobs = deps.jobs;
        this.maxPerScope = deps.maxPerScope ?? 8;
        this.logger = deps.logger;
    }
    /**
     * 扫描一个 scope 里「已关闭 + 摘要就绪 + 尚未整理」的 Episode 并排队。
     * 幂等：memory_jobs 的唯一键 + enqueue 的 pending/running 短路保证不会重复排队。
     */
    scanScope(scopeId, limit = this.maxPerScope) {
        let enqueued = 0;
        for (const episode of this.episodes.listPendingConsolidation(scopeId, limit)) {
            if (this.enqueueEpisode(episode, scopeId))
                enqueued += 1;
        }
        return enqueued;
    }
    /** 单个 Episode 排队（A 路径：Episode 关闭时 / 摘要完成时调用）。 */
    enqueueEpisode(episode, scopeId = episode.scopeId ?? 'global') {
        try {
            const job = this.jobs.enqueue({
                type: 'episode_consolidation',
                ownerType: 'episode',
                ownerId: episode.id,
                scopeId,
            });
            if (job) {
                this.logger?.info?.(`[memory-sea] dream enqueued episode_consolidation episode=${episode.id} scope=${scopeId}`);
                return true;
            }
            return false;
        }
        catch (error) {
            // Dream 排不上队不应该影响 Episode 本身或宿主。
            this.logger?.warn?.('[memory-sea] dream 排整理任务失败', error);
            return false;
        }
    }
    /** 多 scope 扫描（启动恢复 / 手动 maintenance 用）。 */
    scanScopes(scopeIds, limit = this.maxPerScope) {
        let total = 0;
        for (const scopeId of scopeIds) {
            try {
                total += this.scanScope(scopeId, limit);
            }
            catch (error) {
                this.logger?.warn?.(`[memory-sea] dream 扫描 scope=${scopeId} 失败`, error);
            }
        }
        return total;
    }
}
