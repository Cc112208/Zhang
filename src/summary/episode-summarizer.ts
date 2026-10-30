/**
 * episode-summarizer.ts —— 摘要器的选择入口（spec §13 / §14）。
 *
 * 为什么需要这层工厂：
 *   - service 只应该拿到一个 `EpisodeSummarizer`，不应该知道「当前有没有配 LLM」；
 *   - 选择结果还要能对外展示（label）与判断是否降级（configured），供 status / 日志用；
 *   - 「默认可用」是硬要求：没配任何东西时必须返回确定性的 ExtractiveSummarizer，
 *     不能返回 undefined 或一个永远失败的 provider。
 *
 * 安全约定：apiKey 只出现在返回的 summarizer 内部（请求头），
 * 绝不进入 label、kind 或任何日志字符串。
 */

import type { EpisodeSummarizer } from '../types.js'
import { ExtractiveSummarizer } from './extractive-summarizer.js'
import { LlmEpisodeSummarizer } from './llm-summarizer.js'

export interface EpisodeSummarizerSettings {
  enabled: boolean
  /** 'llm' 才尝试远端；其它值/缺省一律用抽取式。 */
  provider?: string
  endpoint?: string
  apiKey?: string
  model?: string
  timeoutMs?: number
}

export interface EpisodeSummarizerSelection {
  summarizer: EpisodeSummarizer
  /** 对外展示用（不得包含 apiKey）。 */
  label: string
  kind: 'extractive' | 'llm'
  /**
   * 当前选择是否具备可用配置：
   *   - 抽取式恒为 true（零配置可用）；
   *   - summary.enabled=false 时为 false（service 据此把 summaryStatus 标成 disabled）；
   *   - 配了 provider='llm' 但缺 endpoint/model 时为 false（已降级到抽取式）。
   */
  configured: boolean
}

/**
 * 按配置 + 环境变量选择摘要器。
 *
 * env 覆盖顺序：显式配置优先，其次 `DSH_MEMORY_SEA_SUMMARY_ENDPOINT / API_KEY / MODEL`。
 * apiKey 允许为空：本地 OpenAI 兼容端点（Ollama / llama.cpp / LM Studio）通常不校验 Key。
 */
export function createEpisodeSummarizer(
  settings: EpisodeSummarizerSettings,
  env: NodeJS.ProcessEnv = process.env,
): EpisodeSummarizerSelection {
  const extractive = new ExtractiveSummarizer()

  const provider = typeof settings.provider === 'string' ? settings.provider.trim().toLowerCase() : ''
  const endpoint = nonEmpty(settings.endpoint) ?? nonEmpty(env.DSH_MEMORY_SEA_SUMMARY_ENDPOINT)
  const apiKey = nonEmpty(settings.apiKey) ?? nonEmpty(env.DSH_MEMORY_SEA_SUMMARY_API_KEY) ?? ''
  const model = nonEmpty(settings.model) ?? nonEmpty(env.DSH_MEMORY_SEA_SUMMARY_MODEL)

  // 摘要整体关闭：仍然返回一个可调用的 summarizer（调用方不该处理 undefined），
  // 但 configured=false 让上层把 Episode.summaryStatus 写成 disabled。
  if (!settings.enabled) {
    return {
      summarizer: extractive,
      label: 'extractive (summary disabled)',
      kind: 'extractive',
      configured: false,
    }
  }

  const wantsLlm = provider === 'llm'
  if (wantsLlm && endpoint !== undefined && model !== undefined) {
    return {
      summarizer: new LlmEpisodeSummarizer({
        endpoint,
        apiKey,
        model,
        ...(settings.timeoutMs !== undefined ? { timeoutMs: settings.timeoutMs } : {}),
        fallback: extractive,
      }),
      // label 只拼 model：即便模型名可疑也不含 apiKey。
      label: `llm:${model}`,
      kind: 'llm',
      configured: true,
    }
  }

  // 默认路径，以及「配了 llm 但缺 endpoint/model」的显式降级路径。
  return {
    summarizer: extractive,
    label: wantsLlm ? 'extractive (llm not configured)' : 'extractive',
    kind: 'extractive',
    configured: !wantsLlm,
  }
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
