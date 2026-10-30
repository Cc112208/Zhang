/**
 * tokenizer.ts —— 中文 / 英文混排的确定性切词。
 *
 * 为什么需要它：SQLite FTS5 自带的 unicode61 tokenizer 不切中文（整段中文会变成一个 token），
 * 于是「为什么 Memory Sea 先用 SQLite」这类查询永远匹配不到。V0.2 的解法是
 * **在 JS 侧把中文切成 bigram 后再写入 FTS**，查询侧走同一套切分，两边对齐即可。
 *
 * 这是纯函数模块：不碰数据库、不碰配置，单元测试直接调用。
 */
import { splitSentences, cleanText } from '../util/text.js';
/** 只去纯语气助词。刻意不把「为」「什」「么」这类构词字当停用词，否则「为什么」会被拆坏。 */
const STOP_CHARS = new Set(['的', '了', '着', '啊', '呀', '呢', '吧', '吗', '嘛', '哦', '嗯', '哈', '呗', '啦']);
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/u;
const ASCII_WORD = /[A-Za-z][A-Za-z0-9_+#.-]*/g;
const NUMBER = /\d+(?:\.\d+)?/g;
/** 切出中文段与 ASCII/数字词块。中文段连续，ASCII 词块按空白与标点分隔。 */
export function segments(text) {
    const normalized = normalize(text);
    const cjk = [];
    const ascii = [];
    for (const match of normalized.matchAll(new RegExp(CJK_RUN, 'gu'))) {
        const run = stripStopChars(match[0]);
        if (run.length > 0)
            cjk.push(run);
    }
    for (const match of normalized.matchAll(ASCII_WORD)) {
        const word = match[0].toLowerCase();
        if (word.length >= 2)
            ascii.push(word);
    }
    for (const match of normalized.matchAll(NUMBER)) {
        ascii.push(match[0]);
    }
    return { cjk, ascii };
}
/** 主切词入口：中文 bigram + ASCII 词 + 数字。保留重复（BM25 需要词频）。 */
export function tokenize(text) {
    const { cjk, ascii } = segments(text);
    const tokens = [];
    for (const run of cjk) {
        if (run.length === 1) {
            tokens.push(run);
            continue;
        }
        for (let i = 0; i + 1 < run.length; i += 1) {
            tokens.push(run.slice(i, i + 2));
        }
    }
    tokens.push(...ascii);
    return tokens;
}
/** 写入 FTS 的文本：token 用空格连接。空文本返回空串（调用方据此跳过索引）。 */
export function toFtsText(text, maxChars = 8000) {
    const joined = tokenize(text).join(' ');
    return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}
/**
 * 查询转 FTS5 MATCH 表达式：每个 token 用双引号包住并 OR 起来。
 * 不用 AND —— 长查询里一个未命中的 bigram 就会把结果清零；排序交给 BM25 与融合层。
 * 返回 null 表示「没有可检索 token」，调用方应直接返回空结果而不是报错。
 */
export function toFtsQuery(query, maxTerms = 24) {
    const seen = new Set();
    const terms = [];
    for (const token of tokenize(query)) {
        if (seen.has(token))
            continue;
        seen.add(token);
        terms.push(token);
        if (terms.length >= maxTerms)
            break;
    }
    if (terms.length === 0)
        return null;
    return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}
/** LIKE fallback 用的词：中文用原文片段 + ASCII 词，避免 bigram 噪音。 */
export function likeTerms(query, max = 8) {
    const normalized = normalize(query);
    const terms = [];
    const seen = new Set();
    for (const chunk of normalized.split(/[^\u3400-\u4dbf\u4e00-\u9fffA-Za-z0-9_+#.-]+/u)) {
        const trimmed = chunk.trim();
        if (trimmed.length >= 2 && !seen.has(trimmed)) {
            seen.add(trimmed);
            terms.push(trimmed);
        }
    }
    for (const token of tokenize(query)) {
        if (terms.length >= max)
            break;
        if (token.length >= 2 && !seen.has(token)) {
            seen.add(token);
            terms.push(token);
        }
    }
    return terms.slice(0, max);
}
/**
 * 关键词 / topic 抽取（确定性，无 LLM）。
 * 规则：中文段整段优先（≤8 字），长段按 2 字滑窗；ASCII 词同样计入；按出现次数排序。
 * 这是 Episode 的 topics 与 legacy 场景标签的来源，未来 Dream 阶段可替换。
 */
export function extractKeywords(text, max = 6) {
    const counts = new Map();
    let order = 0;
    const bump = (key) => {
        if (key.length < 2)
            return;
        const existing = counts.get(key);
        if (existing)
            existing.count += 1;
        else
            counts.set(key, { count: 1, order: order++ });
    };
    const { cjk, ascii } = segments(text);
    for (const run of cjk) {
        if (run.length <= 8) {
            bump(run);
            continue;
        }
        for (let i = 0; i + 2 <= run.length; i += 2)
            bump(run.slice(i, i + 2));
    }
    for (const word of ascii) {
        if (word.length >= 3)
            bump(word);
    }
    return [...counts.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[1].order - b[1].order)
        .map(([key]) => key)
        .slice(0, max);
}
/** 关键词相似度（bigram Jaccard），给 Episode 归并与 scene 连线复用。 */
export function bigramSimilarity(a, b, maxLen = 400) {
    const setA = bigramSet(a, maxLen);
    const setB = bigramSet(b, maxLen);
    if (setA.size === 0 || setB.size === 0)
        return 0;
    let shared = 0;
    for (const token of setA)
        if (setB.has(token))
            shared += 1;
    return shared / (setA.size + setB.size - shared);
}
function bigramSet(text, maxLen) {
    const source = text.length > maxLen ? text.slice(0, maxLen) : text;
    const set = new Set();
    for (const run of segments(source).cjk) {
        if (run.length === 1) {
            set.add(run);
            continue;
        }
        for (let i = 0; i + 1 < run.length; i += 1)
            set.add(run.slice(i, i + 2));
    }
    for (const word of segments(source).ascii)
        set.add(word);
    return set;
}
/** 全角转半角、统一大小写、压缩空白。FTS 与 LIKE 都用它做入口归一化。 */
export function normalize(text) {
    return cleanText(text.normalize('NFKC')).toLowerCase();
}
function stripStopChars(run) {
    let out = '';
    for (const char of run) {
        if (!STOP_CHARS.has(char))
            out += char;
    }
    return out;
}
/** 供标题生成用：取第一句的干净前缀。 */
export function firstSentence(text, maxChars = 28) {
    const sentences = splitSentences(cleanText(text));
    const first = sentences[0] ?? cleanText(text);
    return first.length > maxChars ? `${first.slice(0, maxChars)}…` : first;
}
