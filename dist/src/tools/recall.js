/**
 * tools/recall.ts —— memory_recall（spec §16）。
 *
 * 返回简洁、可解释的结果：内容 / 时间 / 类型 / score / 为什么被召回。
 * 没有 embedding 时照样工作（权重自动重新归一化，见 fusion.resolveWeights）。
 */
import { asRecord, flattenPreview, formatTime, optionalNumber, requireString, textOutput, } from './tool-definition.js';
const MAX_QUERY_CHARS = 500;
const CONTENT_PREVIEW_CHARS = 180;
export function createRecallTool(service) {
    return {
        name: 'memory_recall',
        description: '按关键词 + 时间 + 重要性 + 置信度检索过去的经历、Episode 与语义记忆（Memory），返回可解释的召回结果（包含为什么被联想到）。Memory 是「这些经历共同说明了什么」，Experience 是原始证据。没有向量模型也能工作。',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: '检索词或自然语言问题，例如「为什么 Memory Sea 先用 SQLite」',
                },
                limit: {
                    type: 'number',
                    description: '返回条数，默认 8，最大 50。',
                },
                before: {
                    type: 'number',
                    description: '只要早于这个时间戳（ms）的记忆。',
                },
                after: {
                    type: 'number',
                    description: '只要晚于这个时间戳（ms）的记忆。',
                },
                includeSuperseded: {
                    type: 'boolean',
                    description: '是否包含已被取代的旧知识（默认 false；回答「以前为什么这样决定」时设为 true）。',
                },
            },
            required: ['query'],
            additionalProperties: false,
        },
        timeoutMs: 10_000,
        isConcurrencySafe: () => true,
        execute: async (rawArgs, exec) => {
            const args = asRecord(rawArgs);
            const query = requireString(args, 'query', MAX_QUERY_CHARS);
            const limit = optionalNumber(args, 'limit');
            const before = optionalNumber(args, 'before');
            const after = optionalNumber(args, 'after');
            const includeSuperseded = args.includeSuperseded === true;
            if (limit !== undefined && (limit < 1 || limit > 50)) {
                throw new Error('参数 limit 必须在 1..50 之间');
            }
            if (before !== undefined && after !== undefined && before <= after) {
                throw new Error('参数 before 必须大于 after');
            }
            const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : undefined;
            // 默认展开一层证据链：Memory → 支持它的 Episode（上限 3，避免一次倒出整库原文）。
            const result = await service.recallDetailed({
                query,
                limit,
                before,
                after,
                sessionId,
                expandEpisodes: true,
                includeSuperseded,
            });
            if (result.hits.length === 0) {
                return `没有找到与「${flattenPreview(query, 60)}」相关的记忆。`;
            }
            const weightNote = result.weights.renormalized
                ? '（embedding 不可用，语义权重已重新分配到其他通道）'
                : '';
            const degradeNote = result.degraded.length > 0 ? `（已降级通道：${result.degraded.join('、')}）` : '';
            const lines = [`找到 ${result.hits.length} 条相关记忆${weightNote}${degradeNote}：`];
            result.hits.forEach((hit, index) => {
                const typeLabel = hit.type === 'pattern' ? 'Pattern' : hit.type === 'memory' ? 'Memory' : hit.type === 'episode' ? 'Episode' : 'Experience';
                lines.push('');
                lines.push(`${index + 1}. [${typeLabel}] score=${hit.score.toFixed(2)} ${flattenPreview(hit.content, CONTENT_PREVIEW_CHARS)}`);
                lines.push(`   时间：${formatTime(hit.createdAt)}`);
                lines.push(`   为什么：${describeReasons(hit.reasons)}`);
                if (hit.expanded && hit.expanded.length > 0) {
                    const label = hit.type === 'pattern' ? '支持知识' : hit.type === 'memory' ? '证据 Episode' : '证据 Experience';
                    lines.push(`   ${label}：`);
                    for (const child of hit.expanded) {
                        lines.push(`     - ${flattenPreview(child.content, 100)}（${formatTime(child.createdAt)}）`);
                    }
                }
            });
            return lines.join(String.fromCharCode(10));
        },
        output: textOutput(),
    };
}
function describeReasons(reasons) {
    if (reasons.length === 0)
        return '（无）';
    return reasons
        .map((reason) => {
        const label = REASON_LABELS[reason.type] ?? reason.type;
        const detail = reason.detail?.trim();
        return detail ? `${label}（${detail}）` : label;
    })
        .join('；');
}
const REASON_LABELS = {
    keyword: '关键词',
    semantic: '语义',
    temporal: '时间',
    importance: '重要性',
    session: '同会话',
    confidence: '置信度',
    reinforcement: '强化',
    support: '支持度',
    stability: '稳定度',
};
