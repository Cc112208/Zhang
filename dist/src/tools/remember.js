/**
 * tools/remember.ts —— memory_remember（spec §16）。
 *
 * Agent 主动记录用户明确要求记住的信息。
 * 注意：这里**仍然只写 Experience**（sourceType 'manual'），不直接创建 Semantic Memory 或长期记忆。
 */
import { asRecord, flattenPreview, formatTime, optionalNumber, optionalRecord, requireString, textOutput, } from './tool-definition.js';
const MAX_CONTENT_CHARS = 4000;
export function createRememberTool(service) {
    return {
        name: 'memory_remember',
        description: '把用户明确要求长期记住的信息记为一条原始经历（Experience），并自动归入当前 Episode。只记录，不做推断或改写。',
        parameters: {
            type: 'object',
            properties: {
                content: {
                    type: 'string',
                    description: '要记住的原始内容，尽量保留用户原话，不要自己总结或改写（上限 4000 字）。',
                },
                importance: {
                    type: 'number',
                    description: '重要性 0..1，省略时按来源与措辞自动估计。',
                },
                metadata: {
                    type: 'object',
                    description: '附加的可序列化元数据（例如来源、标签）。',
                },
            },
            required: ['content'],
            additionalProperties: false,
        },
        timeoutMs: 5_000,
        isConcurrencySafe: () => false,
        execute: (rawArgs, exec) => {
            const args = asRecord(rawArgs);
            const content = requireString(args, 'content', MAX_CONTENT_CHARS);
            const requestedImportance = optionalNumber(args, 'importance');
            if (requestedImportance !== undefined && (requestedImportance < 0 || requestedImportance > 1)) {
                throw new Error('参数 importance 必须在 0..1 之间');
            }
            const metadata = optionalRecord(args, 'metadata');
            const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : undefined;
            // 用户明确要求「记住」= 明确的长期意图：标记出来并抬高重要性，
            // 让 Episode 关闭后的整理器优先把它形成 decision/constraint 类 Memory。
            // 注意：仍然只写 Experience，绝不绕过证据直接造 Memory（spec §61）。
            const importance = requestedImportance ?? (hasExplicitMemoryIntent(content) ? 0.85 : undefined);
            const mergedMetadata = {
                ...(metadata ?? {}),
                rememberedBy: 'agent',
                explicitMemoryIntent: true,
            };
            const result = service.remember({ content, importance, metadata: mergedMetadata, sessionId });
            const { experience, episode, createdEpisode, deduplicated } = result;
            const lines = [
                deduplicated ? `该内容此前已记录（未重复写入）：${experience.id}` : `已记录为 Experience：${experience.id}`,
                `归属 Episode：${episode.title ?? '（未命名）'}（${episode.id}${createdEpisode ? '，新建' : ''}）`,
                `时间：${formatTime(experience.observedAt)}`,
                `重要性：${experience.importance.toFixed(2)}`,
                `内容：${flattenPreview(experience.content, 200)}`,
            ];
            if (episode.experienceIds.length > 1) {
                lines.push(`当前 Episode 已包含 ${episode.experienceIds.length} 条经历`);
            }
            return lines.join(String.fromCharCode(10));
        },
        output: textOutput(),
    };
}
/** 中文里表达「请长期记住」的措辞；命中就按明确长期意图处理。 */
const EXPLICIT_INTENT_PATTERN = /记住|记一下|别忘了|不要忘|以后都|从现在开始|长期|永久/;
function hasExplicitMemoryIntent(content) {
    return EXPLICIT_INTENT_PATTERN.test(content);
}
