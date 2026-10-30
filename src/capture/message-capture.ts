/**
 * message-capture.ts —— 把宿主 session 事件翻译成 CaptureInput。
 *
 * 这一层是纯转换：不写数据库、不判 Episode，只决定「这条事件值不值得成为 Experience」。
 * 采集开关（capture.userMessages 等）在这里生效，保证关掉的类型根本进不了存储层。
 *
 * 幂等：id 由 session + seq 派生，宿主重启后重放同一事件不会重复写入。
 */

import type { MemorySeaConfig } from '../config.js'
import type { CaptureInput, ExperienceRole, ExperienceSourceType } from '../types.js'
import { cleanText, looksLikeStructuredText } from '../util/text.js'

/** 单条经历的内容上限（字符）。超长工具输出截断保存，原文仍然不可改写。 */
const MAX_CONTENT_CHARS = 8000

export interface CaptureSessionLike {
  id: string
}

/** 与宿主 SessionEvent 兼容的最小形状（只取需要的字段，避免耦合内部类型）。 */
export interface SessionEventLike {
  type: string
  seq?: number | string
  time?: number
  data?: unknown
}

export class MessageCapture {
  private readonly config: MemorySeaConfig

  constructor(deps: { config: MemorySeaConfig }) {
    this.config = deps.config
  }

  /**
   * 转换一条 session 事件。
   * 返回空数组 = 该事件不产生 Experience（未开启、无文本、或是工具调用参数等噪音）。
   */
  fromSessionEvent(session: CaptureSessionLike, event: SessionEventLike): CaptureInput[] {
    if (!this.config.capture.enabled) return []
    if (!event || typeof event.type !== 'string') return []

    switch (event.type) {
      case 'user/message':
        return this.fromUserMessage(session, event)
      case 'assistant/message':
        return this.fromAssistantMessage(session, event)
      case 'tool/result':
        return this.fromToolResult(session, event)
      default:
        // turn/step/request 等结构性事件不产生经历；tool/call 只有参数没有结果，也不记。
        return []
    }
  }

  private fromUserMessage(session: CaptureSessionLike, event: SessionEventLike): CaptureInput[] {
    if (!this.config.capture.userMessages) return []
    const message = asRecord(event.data)
    const content = this.extractText(message?.content)
    return this.build(session, event, {
      content,
      sourceType: 'chat',
      role: 'user',
      metadata: { eventType: event.type },
    })
  }

  private fromAssistantMessage(session: CaptureSessionLike, event: SessionEventLike): CaptureInput[] {
    if (!this.config.capture.assistantMessages) return []
    const data = asRecord(event.data)
    const message = asRecord(data?.message) ?? data
    const content = this.extractText(message?.content)
    const metadata: Record<string, unknown> = { eventType: event.type }
    if (typeof data?.turn === 'number') metadata.turn = data.turn
    if (typeof data?.step === 'number') metadata.step = data.step
    if (data?.interrupted === true) metadata.interrupted = true
    return this.build(session, event, {
      content,
      sourceType: 'chat',
      role: 'assistant',
      metadata,
    })
  }

  private fromToolResult(session: CaptureSessionLike, event: SessionEventLike): CaptureInput[] {
    if (!this.config.capture.toolResults) return []
    const data = asRecord(event.data)
    const message = asRecord(data?.message) ?? data
    const content = this.extractText(message?.content)
    const metadata: Record<string, unknown> = { eventType: event.type }
    if (typeof message?.toolCallId === 'string') metadata.toolCallId = message.toolCallId
    if (message?.isError === true || asRecord(data?.error)) metadata.isError = true
    if (typeof data?.turn === 'number') metadata.turn = data.turn
    if (typeof data?.step === 'number') metadata.step = data.step
    return this.build(session, event, {
      content,
      sourceType: 'tool',
      role: 'tool',
      metadata,
    })
  }

  private build(
    session: CaptureSessionLike,
    event: SessionEventLike,
    parts: {
      content: string
      sourceType: ExperienceSourceType
      role: ExperienceRole
      metadata: Record<string, unknown>
    },
  ): CaptureInput[] {
    const cleaned = cleanText(parts.content)
    // 太短的片段不构成「观察」：工具成功回执之类通常只有 ok / done。
    if (cleaned.length < 2) return []
    // 工具输出可能非常大（读文件、装插件日志）：截断后再落库，避免单条经历撑爆数据库。
    const content =
      cleaned.length > MAX_CONTENT_CHARS ? `${cleaned.slice(0, MAX_CONTENT_CHARS)}…` : cleaned

    const seq = event.seq !== undefined ? String(event.seq) : ''
    const metadata = { ...parts.metadata }
    if (seq.length > 0) metadata.seq = seq
    if (session.id) metadata.sessionId = session.id

    const input: CaptureInput = {
      // session + seq 稳定派生，重放/重启都不会写出重复经历。
      id: `xp_evt_${session.id}_${seq.length > 0 ? seq : hashish(content)}`,
      sourceType: parts.sourceType,
      role: parts.role,
      content,
      metadata,
      sessionId: session.id,
    }
    // 结构化回执（JSON/HTML 片段）保留为证据，但不该被当成重要记忆。
    if (parts.sourceType === 'tool' && looksLikeStructuredText(content)) input.importance = 0.2
    if (typeof event.time === 'number' && Number.isFinite(event.time)) input.observedAt = event.time
    if (parts.sourceType === 'chat' && seq.length > 0) input.sourceId = `seq:${seq}`
    return [input]
  }

  /** 从 ContentBlock[] / string / 嵌套对象里取纯文本；工具调用参数块直接丢掉。 */
  extractText(content: unknown): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const parts: string[] = []
      for (const block of content) {
        const text = this.extractText(block)
        if (text.length > 0) parts.push(text)
      }
      return parts.join('\n')
    }
    if (!content || typeof content !== 'object') return ''

    const record = content as Record<string, unknown>
    const type = typeof record.type === 'string' ? record.type : undefined
    if (type === 'tool-call' || type === 'tool_call' || type === 'tool_use' || type === 'thinking' || type === 'reasoning') {
      return ''
    }
    if (typeof record.text === 'string') return record.text
    if (record.content !== undefined) return this.extractText(record.content)
    if (typeof record.output === 'string') return record.output
    return ''
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function hashish(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  return hash.toString(36)
}
