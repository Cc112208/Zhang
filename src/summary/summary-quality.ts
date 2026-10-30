/**
 * summary-quality.ts —— 摘要质量的可测试评估（Stage 4.6）。
 *
 * 为什么需要它：
 *   - Episode 摘要和标题会被 Recall / Scene / 3D 前端直接展示，但它们是**派生字段**，
 *     历史上曾出现过「摘要其实是一段源码清单」这种污染（Stage 4 真机数据里就有 2 例）。
 *   - 这里不引入新数据库列：质量是「读时计算」的，同一份 Episode + Experiences 无论算多少次结果一致；
 *     需要重算时由 service 把 `episode_summary` 任务重新入队（Stage 4 已允许 completed 任务重入队）。
 *
 * 判定口径：
 *   - machineShare：原始经历里「机器产出行」的字符占比（路径/代码/日志/JSON/命令行）。
 *   - narrativeChars：过滤掉机器行、宿主注入行之后剩下的人写内容长度。
 *   - hasIntent：原始经历里是否出现决定/目标/偏好/约束这类有价值语义。
 *   - 摘要本身是否含路径、代码行、结构化文本，是否过短，是否与意图脱节。
 */

import { extractKeywords } from '../recall/tokenizer.js'
import type { Experience } from '../types.js'
import {
  cleanText,
  looksLikePathHeavy,
  looksLikeStructuredText,
  looksLikeToolOutput,
  machineShareOf,
  stripMachineLines,
  stripRuntimeLines,
} from '../util/text.js'

export type SummaryGrade = 'good' | 'fair' | 'poor'

export type SummaryQualityFlag =
  | 'empty_summary'
  | 'machine_dominated'
  | 'input_machine_heavy'
  | 'path_heavy'
  | 'code_heavy'
  | 'too_short'
  | 'no_human_content'
  | 'intent_missing'
  | 'title_low_information'

export interface SummaryQuality {
  grade: SummaryGrade
  /** 0..1，越高越可信（只是启发式，不对外声称「与事实一致」）。 */
  score: number
  flags: SummaryQualityFlag[]
  /** 人写内容字符数。 */
  narrativeChars: number
  /** 机器产出字符占比 0..1。 */
  machineShare: number
  /** 摘要字符数。 */
  summaryChars: number
  /** 原始经历里是否有决定/目标/偏好等语义。 */
  hasIntent: boolean
  /** 摘要里出现的关键词（用于对比「摘要是否讲了主题」）。 */
  topics: string[]
}

/** 低信息标题：抽取器在没有任何可用候选时使用。 */
export const LOW_INFORMATION_TITLE = '低信息量会话'

const INTENT_PATTERN =
  /决定|结论|目标|计划|打算|以后|从此|优先|必须|不要|禁止|记住|偏好|倾向|约定|规则|原则/u

/** 把一组 Experience 还原成「人写文本」：逐行去掉机器行和宿主注入行。 */
export function humanTextOf(experiences: readonly Experience[]): string {
  const parts: string[] = []
  for (const experience of experiences) {
    if (typeof experience?.content !== 'string') continue
    const stripped = stripMachineLines(stripRuntimeLines(experience.content))
    if (stripped.length > 0) parts.push(stripped)
  }
  return parts.join(String.fromCharCode(10))
}

/** 原始输入的信号统计（测试与重算决策都用这个口径）。 */
export interface SummaryInputStats {
  narrativeChars: number
  machineShare: number
  hasIntent: boolean
}

export function summaryInputStats(experiences: readonly Experience[]): SummaryInputStats {
  const contents = experiences
    .map((experience) => (typeof experience?.content === 'string' ? experience.content : ''))
    .filter((text) => text.length > 0)
  const totalChars = contents.reduce((sum, text) => sum + cleanText(text).length, 0)
  let weightedMachine = 0
  for (const text of contents) {
    weightedMachine += machineShareOf(text) * cleanText(text).length
  }
  const machineShare = totalChars === 0 ? 0 : Number((weightedMachine / totalChars).toFixed(4))
  const human = humanTextOf(experiences)
  return {
    narrativeChars: human.length,
    machineShare,
    hasIntent: INTENT_PATTERN.test(human),
  }
}

export interface SummaryQualityInput {
  title?: string | undefined
  summary?: string | undefined
  experiences: readonly Experience[]
}

/**
 * 评估一份摘要的质量。纯函数、确定性：不读数据库、不看时间。
 */
export function assessSummaryQuality(input: SummaryQualityInput): SummaryQuality {
  const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  const stats = summaryInputStats(input.experiences)
  // 摘要本身的机器行占比：这才是「摘要被机器输出主导」的证据。
  const summaryMachineShare = summary.length > 0 ? machineShareOf(summary) : 0
  const flags: SummaryQualityFlag[] = []

  const summaryMachineLine = summary
    .split(String.fromCharCode(10))
    .some((line) => line.trim().length > 0 && looksLikeToolOutput(line))
  const summaryPathHeavy = looksLikePathHeavy(summary)
  const summaryStructured = looksLikeStructuredText(summary)
  const codeish = summaryMachineLine || summaryStructured

  if (summary.length === 0) flags.push('empty_summary')
  else if (summary.length < 20) flags.push('too_short')
  if (codeish) flags.push('code_heavy')
  if (summaryPathHeavy) flags.push('path_heavy')
  if (summaryMachineShare >= 0.5) flags.push('machine_dominated')
  if (stats.machineShare >= 0.5) flags.push('input_machine_heavy')
  if (stats.narrativeChars < 20) flags.push('no_human_content')
  if (stats.hasIntent && summary.length > 0 && !INTENT_PATTERN.test(summary)) flags.push('intent_missing')
  if (title.length === 0 || title === LOW_INFORMATION_TITLE || title === '一段经历') {
    flags.push('title_low_information')
  }

  // 打分：从「有内容」开始，按问题扣分，再按人写内容的规模小幅加分。
  let score = 1
  if (summary.length === 0) score -= 0.55
  else if (summary.length < 20) score -= 0.2
  if (codeish) score -= 0.35
  if (summaryPathHeavy) score -= 0.2
  if (summaryMachineShare >= 0.5) score -= 0.2
  else if (stats.machineShare >= 0.3) score -= 0.08
  if (stats.narrativeChars < 20) score -= 0.3
  else if (stats.narrativeChars >= 120) score += 0.05
  if (flags.includes('intent_missing')) score -= 0.1
  if (flags.includes('title_low_information')) score -= 0.08
  if (stats.hasIntent) score += 0.05
  score = Math.max(0, Math.min(1, Number(score.toFixed(4))))

  let grade: SummaryGrade = 'good'
  if (score < 0.45 || flags.includes('empty_summary') || flags.includes('no_human_content')) {
    grade = 'poor'
  } else if (score < 0.72 || codeish || flags.includes('machine_dominated')) {
    grade = 'fair'
  }

  return {
    grade,
    score,
    flags,
    narrativeChars: stats.narrativeChars,
    machineShare: stats.machineShare,
    summaryChars: summary.length,
    hasIntent: stats.hasIntent,
    topics: extractKeywords(humanTextOf(input.experiences), 6),
  }
}
