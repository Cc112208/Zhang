/**
 * pattern-normalizer.ts —— Pattern 文本的机械归一化（spec §52 / §25）。
 *
 * 只做 trim / 折叠空白 / 统一标点 / ASCII 小写：
 *   - 绝不通过 LLM 改写来做唯一键；
 *   - normalized_content 只用于去重与相似度，不用于展示。
 *
 * Pattern 是**描述性知识**，不是人格标签：归一化后同样保留"项目 / 领域"限定词。
 */
import { randomUUID } from 'node:crypto';
const PUNCTUATION_MAP = {
    '，': ',',
    '。': '.',
    '；': ';',
    '：': ':',
    '！': '!',
    '？': '?',
    '、': ',',
    '“': '"',
    '”': '"',
    '‘': "'",
    '’': "'",
    '（': '(',
    '）': ')',
    '【': '[',
    '】': ']',
    '《': '<',
    '》': '>',
    '—': '-',
    '～': '~',
    '\u3000': ' ',
};
export function normalizePatternContent(text) {
    let out = text.replace(/\s+/g, ' ').trim();
    for (const [from, to] of Object.entries(PUNCTUATION_MAP)) {
        out = out.split(from).join(to);
    }
    out = out.toLowerCase();
    return out.replace(/[.,;:!?\s]+$/u, '');
}
/** 单行化 + 截断（Pattern content 一般是一到两句话）。 */
export function singleLine(text, maxChars = 400) {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= maxChars)
        return collapsed;
    return `${collapsed.slice(0, maxChars - 1)}…`;
}
/**
 * Pattern id 用随机 UUID，而不是内容哈希：
 *   同一句话在不同时间可以合法地成为不同的模式（旧模式 superseded 后新模式再出现）。
 */
export function createPatternId() {
    return `pat_${randomUUID()}`;
}
