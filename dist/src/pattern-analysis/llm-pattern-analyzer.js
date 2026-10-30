/**
 * llm-pattern-analyzer.ts —— 可选的 LLM Pattern 分析器（spec §14 / §30）。
 *
 * 与 LlmMemoryConsolidator 相同的工程约束：
 *   - 不引入厂商 SDK，只用 fetch + OpenAI 兼容 /chat/completions；
 *   - 输出必须是严格结构化的 PatternOperation[]，解析失败 / 校验为空一律回退规则式；
 *   - apiKey 只进请求头，绝不进日志或 label；
 *   - LLM 只能「提议」操作，最终写入由 pattern-applier 在同一事务里校验并执行；
 *   - 主方法绝不 throw：网络失败、超时、JSON 非法都走 fallback。
 *
 * 与整理器不同的地方：Pattern 的证据是 Semantic Memory（不是 Episode），
 * 且模型只能引用输入里出现过的 memoryId / patternId，不能凭空编造。
 */
import { PATTERN_KINDS } from '../types.js';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_PROMPT_CHARS = 8000;
const MAX_OPERATIONS = 2;
const NEWLINE = String.fromCharCode(10);
/**
 * 只讲规则、不给例子内容 —— 让模型基于输入证据判断，而不是照着模板编造。
 * 安全要求写在最前面：Pattern 是描述性知识，绝不能变成人格审判或敏感画像。
 */
const SYSTEM_PROMPT = [
    '你是长期记忆系统里的模式分析器。输入是当前 scope 的一条触发知识（triggerMemory）、若干相关 active 知识（relatedMemories）与已有模式（existingPatterns）。',
    '任务：判断这些知识是否反复体现了同一种行为 / 决策结构，并输出结构化操作。',
    '只输出 JSON，不要解释、不要 Markdown，格式为：',
    '{"operations":[{"type":"create","kind":"recurring_decision","content":"一句话模式描述","confidence":0.0,"importance":0.0,"supportingMemoryIds":["mem-..."]}]}',
    '操作类型：create / reinforce / weaken / supersede / noop。',
    '硬性要求：',
    '1. 只根据输入事实判断，不补充输入里没有的信息，不猜测。',
    '2. Pattern 必须由至少 2 条 Memory 支持；supportingMemoryIds / contradictingMemoryIds 只能使用输入里出现过的 id。',
    '3. 不要从单次事件推断人格；不要把项目 / 技术决策说成用户的人格特质。',
    '4. 不要生成或推断敏感属性（政治立场、宗教、健康、性取向、种族等）。',
    '5. 优先 reinforce 已有 Pattern（patternId 必须来自 existingPatterns），而不是 create 重复模式；只有明确长期趋势改变才 supersede。',
    '6. 证据不足、只是同一话题的重复陈述、或者没有长期价值时输出 {"operations":[{"type":"noop","reason":"..."}]}。',
    '7. 最多输出 2 个操作；kind 只能是 preference / strategy / habit / principle / recurring_decision / recurring_problem / recurring_solution / trend / other。',
].join(NEWLINE);
export class LlmPatternAnalyzer {
    name = 'llm';
    configured = true;
    endpoint;
    apiKey;
    model;
    timeoutMs;
    fetchImpl;
    fallback;
    constructor(options) {
        this.endpoint = options.endpoint.trim().replace(/[/]+$/u, '');
        this.apiKey = options.apiKey.trim();
        this.model = options.model.trim();
        this.timeoutMs =
            typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
                ? Math.round(options.timeoutMs)
                : DEFAULT_TIMEOUT_MS;
        this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
        this.fallback = options.fallback;
    }
    async analyze(context) {
        try {
            return await this.request(context);
        }
        catch {
            // 约定：LLM 不可用 / 输出不可解析时永远回退规则式，绝不把异常抛给 service。
            try {
                return await this.fallback.analyze(context);
            }
            catch {
                return { operations: [{ type: 'noop', reason: 'llm 与规则式分析器都不可用' }] };
            }
        }
    }
    async request(context) {
        const headers = {
            'content-type': 'application/json',
            accept: 'application/json',
        };
        // apiKey 只出现在请求头里：不进 label、不进日志、不进 prompt。
        if (this.apiKey.length > 0)
            headers.authorization = `Bearer ${this.apiKey}`;
        const response = await this.fetchImpl(`${this.endpoint}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: this.model,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: buildPrompt(context) },
                ],
            }),
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok)
            throw new Error(`模式分析端点返回 HTTP ${response.status}`);
        const payload = await response.json();
        const content = extractMessageContent(payload);
        if (content === undefined)
            throw new Error('模式分析响应缺少 choices[0].message.content');
        return parseOperations(content, context);
    }
}
/** 只把必要证据放进上下文（而不是整个数据库），并限制总长度 ≤ 8000 字符。 */
export function buildPrompt(context) {
    const payload = {
        scopeId: context.scopeId,
        triggerMemory: memoryPayload(context.triggerMemory, 400),
        relatedMemories: context.relatedMemories.map((memory) => memoryPayload(memory, 200)),
        existingPatterns: context.existingPatterns.map((pattern) => patternPayload(pattern)),
    };
    let text = JSON.stringify(payload);
    // 超长时先丢「最不重要」的相关知识（数组末尾），再丢已有模式，最后才截断 trigger。
    while (text.length > MAX_PROMPT_CHARS && payload.relatedMemories.length > 0) {
        payload.relatedMemories.pop();
        text = JSON.stringify(payload);
    }
    while (text.length > MAX_PROMPT_CHARS && payload.existingPatterns.length > 0) {
        payload.existingPatterns.pop();
        text = JSON.stringify(payload);
    }
    if (text.length > MAX_PROMPT_CHARS) {
        payload.triggerMemory = memoryPayload(context.triggerMemory, 120);
        text = JSON.stringify(payload);
    }
    return text.slice(0, MAX_PROMPT_CHARS);
}
function memoryPayload(memory, maxContent) {
    return {
        id: memory.id,
        kind: memory.kind,
        content: truncate(memory.content, maxContent),
        confidence: memory.confidence,
    };
}
function patternPayload(pattern) {
    return {
        id: pattern.id,
        kind: pattern.kind,
        content: truncate(pattern.content, 200),
        confidence: pattern.confidence,
        supportCount: pattern.supportCount,
        status: pattern.status,
    };
}
function extractMessageContent(payload) {
    if (!isRecord(payload))
        return undefined;
    const choices = payload.choices;
    if (!Array.isArray(choices) || choices.length === 0)
        return undefined;
    const first = choices[0];
    if (!isRecord(first))
        return undefined;
    const message = first.message;
    if (!isRecord(message))
        return undefined;
    const content = message.content;
    return typeof content === 'string' ? content : undefined;
}
/** 解析操作数组；单个非法操作被丢弃，全部非法则抛错（触发回退）。 */
export function parseOperations(content, context) {
    const raw = unwrapJson(content);
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed))
        throw new Error('模型输出不是 JSON 对象');
    const list = parsed.operations;
    if (!Array.isArray(list))
        throw new Error('模型输出缺少 operations 数组');
    const memoryIds = new Set([
        context.triggerMemory.id,
        ...context.relatedMemories.map((memory) => memory.id),
    ]);
    const patternIds = new Set(context.existingPatterns.map((pattern) => pattern.id));
    const operations = [];
    for (const item of list) {
        const operation = parseOperation(item, context, memoryIds, patternIds);
        if (operation)
            operations.push(operation);
        if (operations.length >= MAX_OPERATIONS)
            break;
    }
    if (operations.length === 0)
        throw new Error('模型输出没有任何可用操作');
    return { operations };
}
function parseOperation(item, context, memoryIds, patternIds) {
    if (!isRecord(item))
        return null;
    const type = typeof item.type === 'string' ? item.type : '';
    if (type === 'noop') {
        return {
            type: 'noop',
            reason: typeof item.reason === 'string' && item.reason.trim().length > 0 ? item.reason.trim() : '模型判断证据不足',
        };
    }
    if (type === 'create') {
        const content = readContent(item);
        // 证据必须来自输入：没有合法 supportingMemoryIds 的 create 一律丢弃。
        const supportingMemoryIds = readMemoryIds(item.supportingMemoryIds, memoryIds);
        if (!content || supportingMemoryIds.length === 0)
            return null;
        return {
            type: 'create',
            kind: readKind(item.kind),
            content,
            confidence: readUnit(item.confidence, 0.65),
            importance: readUnit(item.importance, 0.5),
            supportingMemoryIds,
            ...optionalText('subject', item.subject),
            ...optionalText('domain', item.domain),
        };
    }
    if (type === 'reinforce') {
        const patternId = readPatternId(item, patternIds);
        if (!patternId)
            return null;
        // 本次 trigger 天然是支持证据；模型没给合法 id 时用它兜底。
        const supportingMemoryIds = orDefault(readMemoryIds(item.supportingMemoryIds, memoryIds), context.triggerMemory.id);
        return {
            type: 'reinforce',
            patternId,
            supportingMemoryIds,
            ...(item.confidenceDelta !== undefined ? { confidenceDelta: readUnit(item.confidenceDelta, 0.1) } : {}),
        };
    }
    if (type === 'weaken') {
        const patternId = readPatternId(item, patternIds);
        if (!patternId)
            return null;
        const contradictingMemoryIds = orDefault(readMemoryIds(item.contradictingMemoryIds, memoryIds), context.triggerMemory.id);
        return {
            type: 'weaken',
            patternId,
            contradictingMemoryIds,
            ...(item.confidenceDelta !== undefined ? { confidenceDelta: readUnit(item.confidenceDelta, 0.1) } : {}),
        };
    }
    if (type === 'supersede') {
        const patternId = readPatternId(item, patternIds);
        const content = readContent(item);
        const supportingMemoryIds = readMemoryIds(item.supportingMemoryIds, memoryIds);
        if (!patternId || !content || supportingMemoryIds.length === 0)
            return null;
        return {
            type: 'supersede',
            patternId,
            kind: readKind(item.kind),
            content,
            confidence: readUnit(item.confidence, 0.75),
            importance: readUnit(item.importance, 0.6),
            supportingMemoryIds,
            ...optionalText('subject', item.subject),
            ...optionalText('domain', item.domain),
        };
    }
    return null;
}
function readContent(item) {
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (content.length < 4)
        return undefined;
    return content.slice(0, 400);
}
function readKind(value) {
    return typeof value === 'string' && PATTERN_KINDS.includes(value)
        ? value
        : 'other';
}
/** 只接受输入里出现过的 memory id（去重，保持模型给出的顺序）。 */
function readMemoryIds(value, allowed) {
    if (!Array.isArray(value))
        return [];
    const ids = [];
    for (const item of value) {
        if (typeof item !== 'string')
            continue;
        const id = item.trim();
        if (id.length === 0 || !allowed.has(id) || ids.includes(id))
            continue;
        ids.push(id);
    }
    return ids;
}
function readPatternId(item, allowed) {
    const patternId = typeof item.patternId === 'string' ? item.patternId.trim() : '';
    if (patternId.length === 0 || !allowed.has(patternId))
        return undefined;
    return patternId;
}
function readUnit(value, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.min(1, Math.max(0, value));
}
function optionalText(key, value) {
    if (typeof value !== 'string')
        return {};
    const trimmed = value.trim();
    return trimmed.length > 0 ? { [key]: trimmed.slice(0, 200) } : {};
}
function orDefault(ids, fallbackId) {
    return ids.length > 0 ? ids : [fallbackId];
}
function unwrapJson(content) {
    const fenced = /```(?:json)?[ \t]*([\s\S]*?)```/u.exec(content);
    const body = (fenced?.[1] ?? content).trim();
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start)
        throw new Error('模型输出里没有 JSON 对象');
    return body.slice(start, end + 1);
}
function truncate(value, maxChars) {
    const text = value.replace(/\s+/gu, ' ').trim();
    return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
