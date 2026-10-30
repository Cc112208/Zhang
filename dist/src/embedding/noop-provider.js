/**
 * noop-provider.ts —— 默认 embedding 提供者：不产生向量。
 *
 * 它的存在意义是让「没有 embedding」成为一等公民：
 *   - 所有调用方都不需要判空；
 *   - Experience / Episode 的 embeddingStatus 统一写 'disabled'；
 *   - Recall 只走 lexical + temporal + importance + recency。
 *
 * 注意：Noop 不是「出错的实现」，而是一个合法的 provider。它的 dimensions 恒为 0，
 * 上层据此判断「当前没有语义能力」，绝不能用空向量去写 embeddings 表。
 */
/** Noop 的 dimensions 用 0 表示「无向量」，调用方据此跳过语义召回。 */
export const NOOP_DIMENSIONS = 0;
export class NoopEmbeddingProvider {
    name = 'noop';
    model = 'noop';
    dimensions = NOOP_DIMENSIONS;
    /**
     * 说明为什么没有向量。状态接口/日志用它解释「为什么 embedding 是 disabled」，
     * 避免上层靠 name==='noop' 猜原因。
     */
    reason;
    constructor(reason = 'disabled') {
        this.reason = reason;
    }
    /** Noop 永远不可用：无需探测远端。 */
    async isAvailable() {
        return false;
    }
    async embed(_text) {
        return new Float32Array(0);
    }
    /**
     * 批量接口返回空数组：Noop 没有「每个文本对应一个向量」的概念，
     * 空数组让调用方直接进入 disabled 分支，而不是拿到长度对齐的空向量。
     */
    async embedBatch(_texts) {
        return [];
    }
}
