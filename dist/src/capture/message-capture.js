/**
 * message-capture.ts —— 把宿主 session 事件翻译成 CaptureInput。
 *
 * 这一层是纯转换：不写数据库、不判 Episode，只决定「这条事件值不值得成为 Experience」。
 * 采集开关（capture.userMessages 等）在这里生效，保证关掉的类型根本进不了存储层。
 *
 * 幂等：id 由 session + seq 派生，宿主重启后重放同一事件不会重复写入。
 */
import { cleanText, looksLikeStructuredText } from '../util/text.js';
/** 单条经历的内容上限（字符）。超长工具输出截断保存，原文仍然不可改写。 */
const MAX_CONTENT_CHARS = 8000;
export class MessageCapture {
    config;
    constructor(deps) {
        this.config = deps.config;
    }
    /**
     * 转换一条 session 事件。
     * 返回空数组 = 该事件不产生 Experience（未开启、无文本、或是工具调用参数等噪音）。
     */
    fromSessionEvent(session, event) {
        if (!this.config.capture.enabled)
            return [];
        if (!event || typeof event.type !== 'string')
            return [];
        switch (event.type) {
            case 'user/message':
                return this.fromUserMessage(session, event);
            case 'assistant/message':
                return this.fromAssistantMessage(session, event);
            case 'tool/result':
                return this.fromToolResult(session, event);
            default:
                // turn/step/request 等结构性事件不产生经历；tool/call 只有参数没有结果，也不记。
                return [];
        }
    }
    fromUserMessage(session, event) {
        if (!this.config.capture.userMessages)
            return [];
        const message = asRecord(event.data);
        const content = this.extractText(message?.content);
        return this.build(session, event, {
            content,
            sourceType: 'chat',
            role: 'user',
            metadata: { eventType: event.type },
        });
    }
    fromAssistantMessage(session, event) {
        if (!this.config.capture.assistantMessages)
            return [];
        const data = asRecord(event.data);
        const message = asRecord(data?.message) ?? data;
        const content = this.extractText(message?.content);
        const metadata = { eventType: event.type };
        if (typeof data?.turn === 'number')
            metadata.turn = data.turn;
        if (typeof data?.step === 'number')
            metadata.step = data.step;
        if (data?.interrupted === true)
            metadata.interrupted = true;
        return this.build(session, event, {
            content,
            sourceType: 'chat',
            role: 'assistant',
            metadata,
        });
    }
    fromToolResult(session, event) {
        if (!this.config.capture.toolResults)
            return [];
        const data = asRecord(event.data);
        const message = asRecord(data?.message) ?? data;
        const content = this.extractText(message?.content);
        const metadata = { eventType: event.type };
        if (typeof message?.toolCallId === 'string')
            metadata.toolCallId = message.toolCallId;
        if (message?.isError === true || asRecord(data?.error))
            metadata.isError = true;
        if (typeof data?.turn === 'number')
            metadata.turn = data.turn;
        if (typeof data?.step === 'number')
            metadata.step = data.step;
        return this.build(session, event, {
            content,
            sourceType: 'tool',
            role: 'tool',
            metadata,
        });
    }
    build(session, event, parts) {
        const cleaned = cleanText(parts.content);
        // 太短的片段不构成「观察」：工具成功回执之类通常只有 ok / done。
        if (cleaned.length < 2)
            return [];
        // 工具输出可能非常大（读文件、装插件日志）：截断后再落库，避免单条经历撑爆数据库。
        const content = cleaned.length > MAX_CONTENT_CHARS ? `${cleaned.slice(0, MAX_CONTENT_CHARS)}…` : cleaned;
        const seq = event.seq !== undefined ? String(event.seq) : '';
        const metadata = { ...parts.metadata };
        if (seq.length > 0)
            metadata.seq = seq;
        if (session.id)
            metadata.sessionId = session.id;
        const input = {
            // session + seq 稳定派生，重放/重启都不会写出重复经历。
            id: `xp_evt_${session.id}_${seq.length > 0 ? seq : hashish(content)}`,
            sourceType: parts.sourceType,
            role: parts.role,
            content,
            metadata,
            sessionId: session.id,
        };
        // 结构化回执（JSON/HTML 片段）保留为证据，但不该被当成重要记忆。
        if (parts.sourceType === 'tool' && looksLikeStructuredText(content))
            input.importance = 0.2;
        if (typeof event.time === 'number' && Number.isFinite(event.time))
            input.observedAt = event.time;
        if (parts.sourceType === 'chat' && seq.length > 0)
            input.sourceId = `seq:${seq}`;
        return [input];
    }
    /** 从 ContentBlock[] / string / 嵌套对象里取纯文本；工具调用参数块直接丢掉。 */
    extractText(content) {
        if (typeof content === 'string')
            return content;
        if (Array.isArray(content)) {
            const parts = [];
            for (const block of content) {
                const text = this.extractText(block);
                if (text.length > 0)
                    parts.push(text);
            }
            return parts.join('\n');
        }
        if (!content || typeof content !== 'object')
            return '';
        const record = content;
        const type = typeof record.type === 'string' ? record.type : undefined;
        if (type === 'tool-call' || type === 'tool_call' || type === 'tool_use' || type === 'thinking' || type === 'reasoning') {
            return '';
        }
        if (typeof record.text === 'string')
            return record.text;
        if (record.content !== undefined)
            return this.extractText(record.content);
        if (typeof record.output === 'string')
            return record.output;
        return '';
    }
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function hashish(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i += 1)
        hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return hash.toString(36);
}
