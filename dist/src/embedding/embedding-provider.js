/**
 * embedding-provider.ts —— 可插拔向量化的选择层与向量数学（spec §24）。
 *
 * 分工（刻意的）：
 *   - 这里只做「按配置选 provider」+「cosine / 维度工具」；
 *   - 具体 provider 的 HTTP 细节在 openai-compatible-provider.ts / noop-provider.ts；
 *   - 向量存储与版本化在 embedding-repository.ts；
 *   - RecallEngine 完全不知道向量怎么来、怎么存。
 *
 * 默认 Noop：没配置 = 没有语义能力，Recall 自动归一化剩余权重，绝不报错。
 * 构造期不发网络请求（provider 生命周期必须显式）。
 */
import { NoopEmbeddingProvider } from './noop-provider.js';
import { OpenAiCompatibleEmbeddingProvider } from './openai-compatible-provider.js';
/** 环境变量：API Key（不写进插件配置文件时用）。 */
export const EMBEDDING_API_KEY_ENV = 'DSH_MEMORY_SEA_EMBEDDING_API_KEY';
/** 环境变量：API 根地址（例：https://api.openai.com/v1）。 */
export const EMBEDDING_BASE_URL_ENV = 'DSH_MEMORY_SEA_EMBEDDING_BASE_URL';
/**
 * 按配置选择 provider。
 *
 * 返回值语义：
 *   - configured=false：明确没有可用的配置，调用方应直接把 embedding 标成 disabled，
 *     不需要再探测远端；
 *   - configured=true：provider 已就绪，可以排 embedding job。
 */
export function createEmbeddingProvider(settings, env = process.env) {
    if (!settings.enabled) {
        return noopSelection('disabled', 'noop');
    }
    const requested = normalizeProviderName(settings.provider);
    if (requested === undefined || requested === 'noop') {
        return noopSelection('not-configured', 'noop');
    }
    if (requested !== 'openai-compatible') {
        // 配了未知 provider：不猜实现，明确告诉状态接口「有这个配置但不可用」。
        return noopSelection('not-configured', `${requested}:unavailable`);
    }
    const model = nonEmpty(settings.model);
    const apiKey = nonEmpty(settings.apiKey) ?? nonEmpty(env[EMBEDDING_API_KEY_ENV]);
    const baseUrl = nonEmpty(settings.baseUrl) ?? nonEmpty(env[EMBEDDING_BASE_URL_ENV]);
    if (!model || !apiKey || !baseUrl) {
        // 缺任意一项都不发网络请求：宁可 disabled，也不要后台任务反复失败刷日志。
        return noopSelection('not-configured', 'openai-compatible:not-configured');
    }
    const dimensions = positiveInt(settings.dimensions) ?? 0;
    const provider = new OpenAiCompatibleEmbeddingProvider({
        baseUrl,
        apiKey,
        model,
        dimensions: dimensions > 0 ? dimensions : undefined,
        timeoutMs: settings.timeoutMs,
    });
    return {
        provider,
        label: 'openai-compatible',
        model,
        dimensions,
        configured: true,
    };
}
/** 余弦相似度。向量为空或维度不一致时返回 0（不抛错，保持降级可预测）。 */
export function cosineSimilarity(a, b) {
    if (a.length === 0 || b.length !== a.length)
        return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
        const va = a[i] ?? 0;
        const vb = b[i] ?? 0;
        dot += va * vb;
        normA += va * va;
        normB += vb * vb;
    }
    if (normA === 0 || normB === 0)
        return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
// ------------------------------------------------------------------ 内部
function noopSelection(reason, label) {
    const provider = new NoopEmbeddingProvider(reason);
    return {
        provider,
        label,
        model: provider.model,
        dimensions: provider.dimensions,
        configured: false,
    };
}
function normalizeProviderName(value) {
    const trimmed = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return trimmed.length > 0 ? trimmed : undefined;
}
function nonEmpty(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function positiveInt(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return undefined;
    const int = Math.floor(value);
    return int > 0 ? int : undefined;
}
