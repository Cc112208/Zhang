/**
 * pattern-analyzer.ts —— 模式分析器的选择入口（spec §14 / §29 / §30）。
 *
 * 与 createMemoryConsolidator 同构：
 *   - service 只拿到一个 PatternAnalyzer，不关心模型配置；
 *   - 选择结果带 label / kind / configured，供 status 与日志使用；
 *   - 「无 LLM 仍然能工作」是硬要求：默认永远是 RuleBasedPatternAnalyzer；
 *   - provider='llm' 但缺 endpoint / model 时降级规则式并标 configured:false（不算失败）。
 *
 * apiKey 只出现在分析器内部（请求头），不进入 label/kind/日志。
 */

import type { PatternAnalyzer } from '../types.js'
import { RuleBasedPatternAnalyzer, type RuleBasedPatternAnalyzerOptions } from './rule-based-pattern-analyzer.js'
import { LlmPatternAnalyzer } from './llm-pattern-analyzer.js'

export interface PatternAnalyzerSettings {
  enabled: boolean
  /** 'llm' 才尝试远端；'rule' 或缺省一律规则式。 */
  provider: 'rule' | 'llm'
  minSupport: number
  activationThreshold: number
  minConfidence?: number
  endpoint?: string
  apiKey?: string
  model?: string
  timeoutMs?: number
}

export interface PatternAnalyzerSelection {
  analyzer: PatternAnalyzer
  label: string
  kind: 'rule' | 'llm'
  /** false 时 service 把模式分析标成 disabled / not configured，不算失败。 */
  configured: boolean
}

export function createPatternAnalyzer(
  settings: PatternAnalyzerSettings,
  env: NodeJS.ProcessEnv = process.env,
): PatternAnalyzerSelection {
  const ruleOptions: RuleBasedPatternAnalyzerOptions = {
    minSupport: settings.minSupport,
    activationThreshold: settings.activationThreshold,
    minConfidence: settings.minConfidence ?? 0.55,
    maxOperations: 2,
  }
  const ruleBased = new RuleBasedPatternAnalyzer(ruleOptions)

  if (!settings.enabled) {
    return {
      analyzer: ruleBased,
      label: 'rule (pattern disabled)',
      kind: 'rule',
      configured: false,
    }
  }

  const provider = typeof settings.provider === 'string' ? settings.provider.trim().toLowerCase() : ''
  const endpoint = nonEmpty(settings.endpoint) ?? nonEmpty(env.DSH_MEMORY_SEA_PATTERN_ENDPOINT)
  const apiKey = nonEmpty(settings.apiKey) ?? nonEmpty(env.DSH_MEMORY_SEA_PATTERN_API_KEY) ?? ''
  const model = nonEmpty(settings.model) ?? nonEmpty(env.DSH_MEMORY_SEA_PATTERN_MODEL)

  if (provider === 'llm' && endpoint !== undefined && model !== undefined) {
    return {
      analyzer: new LlmPatternAnalyzer({
        endpoint,
        apiKey,
        model,
        ...(settings.timeoutMs !== undefined ? { timeoutMs: settings.timeoutMs } : {}),
        fallback: ruleBased,
      }),
      label: `llm:${model}`,
      kind: 'llm',
      configured: true,
    }
  }

  return {
    analyzer: ruleBased,
    label: provider === 'llm' ? 'rule (llm not configured)' : 'rule',
    kind: 'rule',
    configured: provider === 'llm' ? false : true,
  }
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
