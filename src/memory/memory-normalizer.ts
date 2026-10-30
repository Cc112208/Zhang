/**
 * memory-normalizer.ts —— Semantic Memory 的文本归一化（spec §51）。
 *
 * 只做确定性的轻量归一化，绝不调用 LLM：
 *   - 结果只用于 dedup / 相似度比较，不作为展示文本。
 *   - 用它做比较键，避免「同一条知识换个标点就重复入库」。
 */

import { randomUUID } from 'node:crypto'

const WHITESPACE = /\s+/g

/** 全角 ASCII 标点折叠成半角；中文标点保留（它们承载断句信息）。 */
const PUNCTUATION_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/[＂“”]/g, '"'],
  [/[＇‘’]/g, "'"],
  [/[（]/g, '('],
  [/[）]/g, ')'],
  [/[［]/g, '['],
  [/[］]/g, ']'],
  [/[｛]/g, '{'],
  [/[｝]/g, '}'],
  [/[！]/g, '！'],
  [/[？]/g, '？'],
]

/**
 * 归一化长期知识文本：去首尾空白、折叠空白、统一标点、ASCII 小写、
 * 去掉结尾装饰标点。结果只用于比较，绝不覆盖 Memory.content。
 */
export function normalizeMemoryContent(text: string): string {
  let out = text.replace(WHITESPACE, ' ').trim()
  for (const [pattern, replacement] of PUNCTUATION_MAP) out = out.replace(pattern, replacement)
  out = out.toLowerCase()
  out = out.replace(/[\s。．.!！?？,，;；:：、]+$/g, '')
  return out.trim()
}

/** 展示用：把多行文本压成单行（Memory content 必须是一句可陈述的知识）。 */
export function singleLine(text: string, maxChars = 400): string {
  const collapsed = text.replace(WHITESPACE, ' ').trim()
  if (collapsed.length <= maxChars) return collapsed
  return `${collapsed.slice(0, Math.max(1, maxChars - 1))}…`
}

/**
 * 新 Memory 的 id。
 * 用 UUID 而不是内容哈希：同一句话在不同时间可以合法地成为不同知识，
 * 去重交给 dedup 搜索 + evidence 唯一性，而不是 id 冲突。
 */
export function createMemoryId(): string {
  return `mem_${randomUUID()}`
}
