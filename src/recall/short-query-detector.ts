/**
 * short-query-detector.ts —— 弱查询检测（Stage 4.5）。
 *
 * 只做确定性判断，不调用 LLM（spec §5 / §6）。
 * 关键原则：**弱查询不等于可以猜意图**。这里只回答「这句话本身带多少检索信息」，
 * 绝不生成「用户可能想聊复试」这种伪造语义；上下文候选由 ContextualRecall 负责。
 */

import type { QuerySignal } from '../types.js'

/** 问候 / 寒暄：本身几乎没有信息量，但通常伴随「重新见到某人」的上下文。 */
const GREETING_PATTERNS: readonly RegExp[] = [
  /^(你好|您好|哈喽|嗨|hi|hello|hey|yo)[呀啊哈~!！。.]*$/iu,
  /^(主播好|主播在吗|主播在不在|早上好|中午好|下午好|晚上好|晚安)[呀啊哈~!！。.]*$/u,
  /^(我来了|我又来了|来啦|来了|到了)[呀啊哈~!！。.]*$/u,
  /^(在吗|在不在|有人在吗|有人在吗)[呀啊哈~!！。.?？]*$/u,
]

/** 确认 / 应答：没有新信息，只是回应上一句。 */
const CONFIRMATION_PATTERNS: readonly RegExp[] = [
  /^(嗯+|恩+|哦+|噢+|啊+|对|对的|对的呢|是|是的|是啊|好|好的|好呀|好吧|行|可以|收到|懂了|明白了)[呀啊哈吧呢~!！。.]*$/u,
  /^(ok|okay|yes|no|yeah|yep|nope)[!！。.]*$/iu,
]

/** 代词 / 指代：必须靠上下文才能知道指什么。 */
const PRONOUN_PATTERNS: readonly RegExp[] = [
  /^(他|她|它|他们|她们|它们|这个|那个|这|那|这些话|那些)[呀啊哈吧呢么~!！。.?？]*$/u,
]

/** 续接语：明显是接着上一段说，但本身没有实体词。 */
const CONTINUATION_PATTERNS: readonly RegExp[] = [
  /(然后呢|后来呢|结果呢|接着说|继续说|还有呢|再然后)/u,
  /(怎么样了|怎么样|如何了|还记得吗|还记得|记得吗|还记得不|忘记了吗)/u,
  /^(那|那么|所以|因此|不过|但是|可是)/u,
]

/** 纯符号 / 纯表情：没有可检索的词。 */
const NOISE_PATTERN = /^[\p{P}\p{S}\s]+$/u

export interface ShortQueryOptions {
  /** 超过该长度就不再当作「短查询」（默认 6 个字符）。 */
  weakQueryMaxLength?: number
}

export interface ShortQueryResult {
  signal: QuerySignal
  /** 归一化后的字符长度（去空白）。 */
  length: number
  /** 命中的模式名，便于调试与 benchmark 记录。 */
  matched?: 'greeting' | 'confirmation' | 'pronoun' | 'continuation' | 'noise' | 'short'
}

const DEFAULT_WEAK_QUERY_MAX_LENGTH = 6

/**
 * 判定 query 的信号强度。
 *
 * - `empty`：空串 / 纯空白 / 纯符号 —— 不召回任何东西（上下文召回也不启动）。
 * - `weak`：短、寒暄、确认、代词、续接语 —— 只有这类查询才允许上下文召回。
 * - `normal`：带具体信息词的长查询 —— 仍以 lexical / semantic / memory 为主。
 */
export function detectQuerySignal(query: unknown, options: ShortQueryOptions = {}): ShortQueryResult {
  if (typeof query !== 'string') return { signal: 'empty', length: 0 }
  const text = query.trim()
  if (text.length === 0) return { signal: 'empty', length: 0 }

  const length = text.replace(/\s+/gu, '').length
  if (NOISE_PATTERN.test(text)) return { signal: 'empty', length, matched: 'noise' }
  if (matches(GREETING_PATTERNS, text)) return { signal: 'weak', length, matched: 'greeting' }
  if (matches(CONFIRMATION_PATTERNS, text)) return { signal: 'weak', length, matched: 'confirmation' }
  if (matches(PRONOUN_PATTERNS, text)) return { signal: 'weak', length, matched: 'pronoun' }
  if (matches(CONTINUATION_PATTERNS, text)) return { signal: 'weak', length, matched: 'continuation' }

  const maxLength = Math.max(1, options.weakQueryMaxLength ?? DEFAULT_WEAK_QUERY_MAX_LENGTH)
  if (length <= maxLength) return { signal: 'weak', length, matched: 'short' }
  return { signal: 'normal', length }
}

/** 便利判断：只有 weak 才允许上下文候选参与融合（spec §12）。 */
export function allowsContextualRecall(signal: QuerySignal): boolean {
  return signal === 'weak'
}

function matches(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text))
}
