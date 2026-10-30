/**
 * llm-consolidator.ts —— 可选的 LLM 整理器（spec §30）。
 *
 * 与 LlmEpisodeSummarizer 相同的工程约束：
 *   - 不引入厂商 SDK，只用 fetch + OpenAI 兼容 /chat/completions。
 *   - 输出必须是严格结构化的操作数组；解析失败一律回退到 RuleBasedConsolidator。
 *   - apiKey 只进请求头，绝不进日志或 label。
 *   - LLM 只能「提议」操作，最终写入由 consolidation-applier 在同一事务里校验并执行。
 */

import type {
  ConsolidationContext,
  ConsolidationOperation,
  ConsolidationResult,
  MemoryConsolidator,
  MemoryKind,
} from '../types.js'
import { MEMORY_KINDS } from '../types.js'
import { redactSensitiveText } from '../util/redaction.js'

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_PROMPT_CHARS = 8000
const NEWLINE = String.fromCharCode(10)

/** 只讲规则，不给例子内容 —— 让模型基于 Evidence 而不是基于模板编造。 */
const SYSTEM_PROMPT = [
  '你是长期记忆整理器。输入是一次已关闭的经历（Episode）与少量相关经历和既有知识。',
  '任务：判断这次经历是否产生了值得长期保留的知识，并输出结构化操作。',
  '只输出 JSON，不要解释、不要 Markdown，格式为：',
  '{"operations":[{"type":"create","kind":"decision","content":"一句话知识","confidence":0.0,"importance":0.0,"evidenceEpisodeIds":["ep-..."]}]}',
  '操作类型：create / reinforce / update / supersede / contradict / noop。',
  '硬性要求：',
  '1. 只能使用输入里出现的事实，不推断人格、不生成敏感属性、不把猜测写成事实。',
  '2. 尽量复用既有知识：能 reinforce 就不要 create 重复知识。',
  '3. 只有明确的时间变化才 supersede；无法判断新旧有效性时用 contradict。',
  '4. 没有长期价值（一次工具操作、普通闲聊、临时状态）时输出 {"operations":[{"type":"noop"}]}。',
  '5. evidenceEpisodeIds 必须来自输入的 Episode id 列表，不能为空。',
  '6. 最多输出 3 个操作。',
].join(NEWLINE)

export interface LlmMemoryConsolidatorOptions {
  endpoint: string
  apiKey: string
  model: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** 任何失败都回退到它（通常是 RuleBasedConsolidator）。 */
  fallback: MemoryConsolidator
}

export class LlmMemoryConsolidator implements MemoryConsolidator {
  readonly name = 'llm'
  readonly configured = true

  private readonly endpoint: string
  private readonly apiKey: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly fallback: MemoryConsolidator

  constructor(options: LlmMemoryConsolidatorOptions) {
    this.endpoint = options.endpoint.trim().replace(/[/]+$/u, '')
    this.apiKey = options.apiKey.trim()
    this.model = options.model.trim()
    this.timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Math.round(options.timeoutMs)
        : DEFAULT_TIMEOUT_MS
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
    this.fallback = options.fallback
  }

  async consolidate(context: ConsolidationContext): Promise<ConsolidationResult> {
    try {
      return await this.request(context)
    } catch {
      // 约定：LLM 不可用/输出不可解析时，永远回退到规则整理器，绝不抛错。
      try {
        return await this.fallback.consolidate(context)
      } catch {
        return { operations: [{ type: 'noop', reason: 'llm 与规则整理器都不可用' }] }
      }
    }
  }

  private async request(context: ConsolidationContext): Promise<ConsolidationResult> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    }
    if (this.apiKey.length > 0) headers.authorization = `Bearer ${this.apiKey}`

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
    })
    if (!response.ok) throw new Error(`整理端点返回 HTTP ${response.status}`)

    const payload: unknown = await response.json()
    const content = extractMessageContent(payload)
    if (content === undefined) throw new Error('整理响应缺少 choices[0].message.content')
    return parseOperations(content, context)
  }
}

/** 只把必要的证据放进上下文（而不是整个数据库），并限制总长度。 */
export function buildPrompt(context: ConsolidationContext): string {
  const lines: string[] = []
  lines.push(`scope: ${context.scopeId}`)
  lines.push(`episode: ${context.episode.id} | title=${redactSensitiveText(context.episode.title ?? '(无)')}`)
  lines.push(`summary: ${redactSensitiveText(context.episode.summary ?? '(无)')}`)
  if (context.episode.topics.length > 0) lines.push(`topics: ${context.episode.topics.join(', ')}`)
  lines.push('relatedEpisodes:')
  for (const related of context.relatedEpisodes) {
    lines.push(`- ${related.id} | ${redactSensitiveText(related.title ?? '(无)')} | ${redactSensitiveText(truncate(related.summary ?? '', 200))}`)
  }
  lines.push('existingMemories:')
  for (const memory of context.relatedMemories) {
    lines.push(
      `- ${memory.id} | kind=${memory.kind} | confidence=${memory.confidence} | content=${redactSensitiveText(truncate(memory.content, 200))}`,
    )
  }
  return lines.join(NEWLINE).slice(0, MAX_PROMPT_CHARS)
}

function extractMessageContent(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const first = choices[0]
  if (!isRecord(first)) return undefined
  const message = first.message
  if (!isRecord(message)) return undefined
  const content = message.content
  return typeof content === 'string' ? content : undefined
}

/** 解析操作数组；单个非法操作被丢弃，全部非法则抛错（触发回退）。 */
export function parseOperations(content: string, context: ConsolidationContext): ConsolidationResult {
  const raw = unwrapJson(content)
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) throw new Error('模型输出不是 JSON 对象')
  const list = parsed.operations
  if (!Array.isArray(list)) throw new Error('模型输出缺少 operations 数组')

  const operations: ConsolidationOperation[] = []
  for (const item of list) {
    const operation = parseOperation(item, context)
    if (operation) operations.push(operation)
    if (operations.length >= 3) break
  }
  if (operations.length === 0) throw new Error('模型输出没有任何可用操作')
  return { operations }
}

function parseOperation(item: unknown, context: ConsolidationContext): ConsolidationOperation | null {
  if (!isRecord(item)) return null
  const type = typeof item.type === 'string' ? item.type : ''
  const fallbackEvidence = [context.episode.id]

  if (type === 'noop') {
    return { type: 'noop', ...(typeof item.reason === 'string' ? { reason: item.reason } : {}) }
  }

  if (type === 'create') {
    const content = readContent(item)
    if (!content) return null
    return {
      type: 'create',
      kind: readKind(item.kind),
      content,
      confidence: readUnit(item.confidence, 0.65),
      importance: readUnit(item.importance, 0.5),
      evidenceEpisodeIds: readEvidence(item, context, fallbackEvidence),
    }
  }

  if (type === 'reinforce') {
    const memoryId = readMemoryId(item, context)
    if (!memoryId) return null
    return {
      type: 'reinforce',
      memoryId,
      evidenceEpisodeIds: readEvidence(item, context, fallbackEvidence),
      ...(typeof item.confidenceDelta === 'number' ? { confidenceDelta: readUnit(item.confidenceDelta, 0.15) } : {}),
    }
  }

  if (type === 'update') {
    const memoryId = readMemoryId(item, context)
    if (!memoryId) return null
    const content = readContent(item)
    return {
      type: 'update',
      memoryId,
      ...(content ? { content } : {}),
      ...(item.kind !== undefined ? { kind: readKind(item.kind) } : {}),
      ...(item.confidence !== undefined ? { confidence: readUnit(item.confidence, 0.6) } : {}),
      ...(item.importance !== undefined ? { importance: readUnit(item.importance, 0.5) } : {}),
      evidenceEpisodeIds: readEvidence(item, context, []),
    }
  }

  if (type === 'supersede') {
    const memoryId = readMemoryId(item, context)
    const content = readContent(item)
    if (!memoryId || !content) return null
    return {
      type: 'supersede',
      memoryId,
      kind: readKind(item.kind),
      content,
      confidence: readUnit(item.confidence, 0.75),
      importance: readUnit(item.importance, 0.6),
      evidenceEpisodeIds: readEvidence(item, context, fallbackEvidence),
    }
  }

  if (type === 'contradict') {
    const memoryId = readMemoryId(item, context)
    if (!memoryId) return null
    return {
      type: 'contradict',
      memoryId,
      evidenceEpisodeIds: readEvidence(item, context, fallbackEvidence),
    }
  }

  return null
}

function readContent(item: Record<string, unknown>): string | undefined {
  const content = typeof item.content === 'string' ? item.content.trim() : ''
  if (content.length < 4) return undefined
  return content.slice(0, 400)
}

function readKind(value: unknown): MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value)
    ? (value as MemoryKind)
    : 'other'
}

function readUnit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

function readMemoryId(item: Record<string, unknown>, context: ConsolidationContext): string | undefined {
  const memoryId = typeof item.memoryId === 'string' ? item.memoryId.trim() : ''
  if (memoryId.length === 0) return undefined
  // 只允许操作上下文里出现过的知识：模型不能凭想象引用不存在的 id。
  const known = context.relatedMemories.some((memory) => memory.id === memoryId)
  return known ? memoryId : undefined
}

function readEvidence(
  item: Record<string, unknown>,
  context: ConsolidationContext,
  fallback: string[],
): string[] {
  const allowed = new Set<string>([context.episode.id, ...context.relatedEpisodes.map((episode) => episode.id)])
  const raw = item.evidenceEpisodeIds
  const ids: string[] = []
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (typeof value !== 'string') continue
      if (allowed.has(value) && !ids.includes(value)) ids.push(value)
    }
  }
  if (ids.length === 0) ids.push(...fallback.filter((id) => allowed.has(id)))
  return ids
}

function unwrapJson(content: string): string {
  const fenced = /```(?:json)?[ \t]*([\s\S]*?)```/u.exec(content)
  const body = (fenced?.[1] ?? content).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型输出里没有 JSON 对象')
  return body.slice(start, end + 1)
}

function truncate(value: string, maxChars: number): string {
  const text = value.replace(/\s+/gu, ' ').trim()
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
