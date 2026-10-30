/**
 * tool-definition.ts —— Host `ctx.tools.register()` 所需结构的最小类型与工具函数。
 *
 * 这里刻意不 import Host 的类型（插件不依赖宿主包），只声明结构兼容的形状。
 * 校验原则：Host 的 JSON Schema 不支持 minLength/minimum 等约束，所以参数校验全部写在 execute 里。
 */

export interface ToolParameterSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolContentBlock {
  type: 'text'
  text: string
}

export interface ToolOutputDefinition {
  schema: Record<string, unknown>
  render(args: unknown, value: unknown): ToolContentBlock[]
}

export interface ToolExecutionLike {
  signal?: AbortSignal
  agent?: { id?: string }
}

export interface ToolDefinitionSpec {
  name: string
  description: string
  parameters: ToolParameterSchema
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  execute(args: unknown, exec: ToolExecutionLike): Promise<unknown> | unknown
  output: ToolOutputDefinition
}

/** 所有工具都返回纯文本：对模型友好，也避免 JSON 结构在展示层反复变形。 */
export function textOutput(): ToolOutputDefinition {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value ?? '') }],
  }
}

export function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
}

export function requireString(args: Record<string, unknown>, key: string, maxChars: number): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`参数 ${key} 不能为空`)
  }
  const trimmed = value.trim()
  if (trimmed.length > maxChars) {
    throw new Error(`参数 ${key} 太长（上限 ${maxChars} 字符，实际 ${trimmed.length}）`)
  }
  return trimmed
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`参数 ${key} 必须是数字`)
  }
  return value
}

export function optionalRecord(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`参数 ${key} 必须是对象`)
  }
  return value as Record<string, unknown>
}

export function formatTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '时间未知'
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 把正文压成单行预览，供工具输出使用。 */
export function flattenPreview(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`
}
