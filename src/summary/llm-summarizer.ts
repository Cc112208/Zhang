/**
 * llm-summarizer.ts —— 可选的 LLM 摘要器（spec §13 / §14）。
 *
 * 设计约束（都是「插件不能拖垮宿主」的一部分）：
 *   - 不引入任何厂商 SDK：只有 fetch + OpenAI 兼容的 /chat/completions。
 *   - 绝不抛错：网络错误、非 2xx、超时、模型输出不是 JSON、字段类型不对，
 *     一律回退到 ExtractiveSummarizer 的确定性结果。摘要失败只是 Episode 少一个派生字段，
 *     不应该让 capture / job 链路失败。
 *   - fetchImpl 可注入：单元测试不需要真的起服务端，生产默认 globalThis.fetch。
 *   - apiKey 只进请求头，绝不进日志/标题/label。
 */

import type { Episode, EpisodeSummarizer, EpisodeSummaryResult, Experience } from '../types.js'
import { cleanText, uniqueStrings } from '../util/text.js'

/** 发给模型的原文上限：太长会让本地小模型超上下文，也太贵。 */
const MAX_PROMPT_CHARS = 6000
/** 摘要硬上限，与抽取式一致。 */
const MAX_SUMMARY_CHARS = 400
const DEFAULT_TIMEOUT_MS = 15_000

/** 要求模型只输出固定 JSON：解析路径唯一，失败就走回退。 */
const SYSTEM_PROMPT = [
  '你是记忆系统的摘要器。把给定的一段经历压缩成结构化摘要。',
  '只输出 JSON，不要输出解释、Markdown 或代码块，格式为：',
  '{"title":"不超过28字的标题","summary":"不超过400字的摘要","participants":["人名"],"locations":["地点"],"topics":["主题"],"confidence":0.0}',
  '要求：只使用原文中出现的事实，不推测、不补充；participants/locations/topics 最多各 6 个；confidence 是 0 到 1 的数字。',
].join('\n')

export interface LlmEpisodeSummarizerOptions {
  /** OpenAI 兼容服务的基地址，例如 http://127.0.0.1:1234/v1（不带 /chat/completions）。 */
  endpoint: string
  /** 可为空：本地端点通常不校验 Key。 */
  apiKey: string
  model: string
  timeoutMs?: number
  /** 注入点：测试用假 fetch，生产省略即用 globalThis.fetch。 */
  fetchImpl?: typeof fetch
  /** 任何失败都回退到它（通常是 ExtractiveSummarizer）。 */
  fallback: EpisodeSummarizer
}

export class LlmEpisodeSummarizer implements EpisodeSummarizer {
  readonly name = 'llm'

  private readonly endpoint: string
  private readonly apiKey: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly fallback: EpisodeSummarizer

  constructor(options: LlmEpisodeSummarizerOptions) {
    // 容忍用户把 endpoint 写成 ".../v1/"（尾部斜杠会让 URL 变成 //chat/completions）。
    this.endpoint = options.endpoint.trim().replace(/\/+$/u, '')
    this.apiKey = options.apiKey.trim()
    this.model = options.model.trim()
    this.timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Math.round(options.timeoutMs)
        : DEFAULT_TIMEOUT_MS
    // 包一层而不是直接存 globalThis.fetch：避免作为对象方法调用时丢失 this（浏览器环境严格）。
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
    this.fallback = options.fallback
  }

  async summarize(episode: Episode, experiences: readonly Experience[]): Promise<EpisodeSummaryResult> {
    try {
      return await this.requestSummary(episode, experiences)
    } catch {
      // 关键约定：LLM 失败不抛错，直接给出确定性结果（fallback 自身也兜一层，防止它写坏）。
      try {
        return await this.fallback.summarize(episode, [...experiences])
      } catch {
        return {
          title: fallbackTitle(episode),
          summary: '',
          participants: [],
          locations: [],
          topics: [],
          confidence: 0.3,
        }
      }
    }
  }

  private async requestSummary(episode: Episode, experiences: readonly Experience[]): Promise<EpisodeSummaryResult> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    }
    // 空 Key 不发 Authorization：本地 OpenAI 兼容端点常见「无鉴权」部署。
    if (this.apiKey.length > 0) headers.authorization = `Bearer ${this.apiKey}`

    const response = await this.fetchImpl(`${this.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(episode, experiences) },
        ],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    if (!response.ok) throw new Error(`摘要端点返回 HTTP ${response.status}`)

    const payload: unknown = await response.json()
    const content = extractMessageContent(payload)
    if (content === undefined) throw new Error('摘要响应缺少 choices[0].message.content')
    return parseSummary(content)
  }
}

/** user 消息：Episode 标题 + 逐行原文明细，原文总长截断到 6000 字。 */
function buildUserPrompt(episode: Episode, experiences: readonly Experience[]): string {
  const lines: string[] = []
  for (const experience of experiences) {
    if (typeof experience?.content !== 'string') continue
    const content = cleanText(experience.content)
    if (content.length === 0) continue
    lines.push(`- [${experience.sourceType}] ${content}`)
  }
  const body = lines.join('\n').slice(0, MAX_PROMPT_CHARS)
  const title = typeof episode?.title === 'string' ? episode.title.trim() : ''
  return `Episode 标题：${title.length > 0 ? title : '(无)'}\n经历原文：\n${body}`
}

/** 从 OpenAI 兼容响应里取 content；结构不符合预期返回 undefined（交给上层回退）。 */
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

/**
 * 解析模型输出。允许三种常见形态：纯 JSON、```json 代码块、前后带解释文字。
 * 任何解析或校验失败都抛错 —— 由 summarize() 统一回退。
 */
function parseSummary(content: string): EpisodeSummaryResult {
  const raw = unwrapJson(content)
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) throw new Error('模型输出不是 JSON 对象')

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
  if (summary.length === 0) throw new Error('模型输出缺少 summary')

  let title: string | undefined
  if (parsed.title !== undefined) {
    if (typeof parsed.title !== 'string') throw new Error('模型输出的 title 类型不对')
    const trimmed = parsed.title.trim()
    if (trimmed.length > 0) title = trimmed
  }

  const participants = optionalStringArray(parsed.participants, 'participants', 6)
  const locations = optionalStringArray(parsed.locations, 'locations', 6)
  const topics = optionalStringArray(parsed.topics, 'topics', 8)

  let confidence: number | undefined
  if (parsed.confidence !== undefined) {
    if (typeof parsed.confidence !== 'number' || !Number.isFinite(parsed.confidence)) {
      throw new Error('模型输出的 confidence 类型不对')
    }
    confidence = Math.min(1, Math.max(0, parsed.confidence))
  }

  return {
    title,
    summary: truncateSummary(summary),
    participants,
    locations,
    topics,
    confidence,
  }
}

/** 去掉 ```json 代码块与前后解释文字，只留最外层的 {...}。 */
function unwrapJson(content: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(content)
  const body = (fenced?.[1] ?? content).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型输出里没有 JSON 对象')
  return body.slice(start, end + 1)
}

function optionalStringArray(value: unknown, field: string, max: number): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`模型输出的 ${field} 类型不对`)
  const strings: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`模型输出的 ${field} 元素类型不对`)
    strings.push(item)
  }
  return uniqueStrings(strings, max)
}

/** 截断到 400 字以内（含省略号），保证下游展示不会超长。 */
function truncateSummary(summary: string): string {
  if (summary.length <= MAX_SUMMARY_CHARS) return summary
  return `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…`
}

function fallbackTitle(episode: Episode | undefined): string {
  const title = typeof episode?.title === 'string' ? episode.title.trim() : ''
  return title.length > 0 ? title : '一段经历'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
