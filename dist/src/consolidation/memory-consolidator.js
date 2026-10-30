/**
 * memory-consolidator.ts —— 整理器的选择入口（spec §18 / §28 / §29 / §30）。
 *
 * 与 createEpisodeSummarizer 同构：
 *   - service 只拿到一个 MemoryConsolidator，不关心模型配置；
 *   - 选择结果带 label / kind / configured，供 status 与日志使用；
 *   - 「无 LLM 仍然能工作」是硬要求：默认永远是 RuleBasedConsolidator。
 *
 * apiKey 只出现在整理器内部（请求头），不进入 label/kind/日志。
 */
import { RuleBasedConsolidator } from './rule-based-consolidator.js';
import { LlmMemoryConsolidator } from './llm-consolidator.js';
export function createMemoryConsolidator(settings, env = process.env) {
    const ruleOptions = {
        minConfidence: settings.minConfidence ?? 0.5,
        autoSupersede: settings.autoSupersede ?? true,
        requireMultipleEvidenceForPreference: settings.requireMultipleEvidenceForPreference ?? true,
        maxOperations: settings.maxOperations ?? 3,
    };
    const ruleBased = new RuleBasedConsolidator(ruleOptions);
    if (!settings.enabled) {
        return {
            consolidator: ruleBased,
            label: 'rule-based (consolidation disabled)',
            kind: 'rule-based',
            configured: false,
        };
    }
    const provider = typeof settings.provider === 'string' ? settings.provider.trim().toLowerCase() : '';
    const endpoint = nonEmpty(settings.endpoint) ?? nonEmpty(env.DSH_MEMORY_SEA_CONSOLIDATION_ENDPOINT);
    const apiKey = nonEmpty(settings.apiKey) ?? nonEmpty(env.DSH_MEMORY_SEA_CONSOLIDATION_API_KEY) ?? '';
    const model = nonEmpty(settings.model) ?? nonEmpty(env.DSH_MEMORY_SEA_CONSOLIDATION_MODEL);
    if (provider === 'llm' && endpoint !== undefined && model !== undefined) {
        return {
            consolidator: new LlmMemoryConsolidator({
                endpoint,
                apiKey,
                model,
                ...(settings.timeoutMs !== undefined ? { timeoutMs: settings.timeoutMs } : {}),
                fallback: ruleBased,
            }),
            label: `llm:${model}`,
            kind: 'llm',
            configured: true,
        };
    }
    return {
        consolidator: ruleBased,
        label: provider === 'llm' ? 'rule-based (llm not configured)' : 'rule-based',
        kind: 'rule-based',
        configured: provider === 'llm' ? false : true,
    };
}
function nonEmpty(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
