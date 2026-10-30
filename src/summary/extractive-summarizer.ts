/**
 * extractive-summarizer.ts —— Episode 摘要的确定性基线（spec §13）。
 *
 * 为什么先做抽取式：
 *   - V0.2 的默认配置必须「装上就能跑」，不能依赖任何远端模型（零网络、零额外依赖）。
 *   - 摘要是 Episode 的派生字段，必须可复现：同一批 Experience 无论跑多少次结果完全一致，
 *     这样 Episode 的标题/摘要才不会在每次重建时抖动。
 *   - 抽取式天然满足「不覆盖 Experience」：它只从原文里挑句子，不改写事实。
 *
 * 职责边界：Episode + Experiences → { title, summary, participants, locations, topics, confidence }。
 * 这里不碰 SQL、不碰文件系统、不做任何 I/O，方便单元测试与在 job worker 里安全重试。
 */

import { narrativeExperiences, TITLE_SOURCE_PRIORITY } from '../capture/episode-builder.js'
import { bigramSimilarity, extractKeywords, firstSentence } from '../recall/tokenizer.js'
import type { Episode, EpisodeSummarizer, EpisodeSummaryResult, Experience } from '../types.js'
import {
  extractLocations,
  extractParticipants,
  looksLikeMachineLine,
  looksLikePathHeavy,
  looksLikeStructuredText,
  looksLikeToolOutput,
  splitSentences,
  stripMachineLines,
  stripRuntimeLines,
  trimTitle,
  uniqueStrings,
} from '../util/text.js'


/** 摘要硬上限：Scene tooltip / recall 结果里都按这个长度展示。 */
const MAX_SUMMARY_CHARS = 400
/** 最多 4 句，再多就变成复述而不是摘要。 */
const MAX_SUMMARY_SENTENCES = 4
/** 太短的句子（「好的」「收到」）没有信息量，拼进摘要只是噪音。 */
const MIN_SENTENCE_CHARS = 6
/** 用 bigram 相似度判定相邻句重复；>0.8 基本就是同一句话换了标点。 */
const DUPLICATE_SIMILARITY = 0.8
/** 关键词表大小：覆盖度打分只关心整段经历里最典型的这些词。 */
const KEYWORD_LIMIT = 12
/** 全部经历都不适合当标题时的最后兜底。 */
const FALLBACK_TITLE = '一段经历'

export class ExtractiveSummarizer implements EpisodeSummarizer {
  readonly name = 'extractive'

  /**
   * 注意：摘要失败绝不能把 Episode 处理链路带崩（Episode 仍然是有效数据），
   * 所以这里兜住所有异常并返回一个合法的最小结果。
   */
  async summarize(episode: Episode, experiences: readonly Experience[]): Promise<EpisodeSummaryResult> {
    try {
      return this.build(episode, experiences)
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

  private build(episode: Episode, experiences: readonly Experience[]): EpisodeSummaryResult {
    // 摘要只写「人写的经历」：grep 结果、代码片段、JSON 回执进摘要会变成
    // `53|export type ...` 这类噪音，读者看不出这段经历是什么。
    const all = experiences.filter(isUsableExperience)
    const narrative = narrativeExperiences(all)
    const usable = narrative.length > 0 ? narrative : all

    const title = this.deriveTitle(episode, usable)
    const sentences = collectSentences(usable)
    const keywords = extractKeywords(
      usable.map((experience) => experience.content).join('\n'),
      KEYWORD_LIMIT,
    )
    const selected = selectSentences(sentences, keywords)
    const summary = composeSummary(selected)

    // 聚合口径与 EpisodeBuilder.refreshDerived 保持一致：先逐条抽取再按出现顺序去重。
    const participants = uniqueStrings(
      usable.flatMap((experience) => extractParticipants(experience.content, 4)),
      6,
    )
    const locations = uniqueStrings(
      usable.flatMap((experience) => extractLocations(experience.content, 4)),
      6,
    )
    const topics = uniqueStrings(
      usable.flatMap((experience) => extractKeywords(experience.content, 3)),
      8,
    )

    return {
      title,
      summary,
      participants,
      locations,
      topics,
      confidence: computeConfidence(selected.length, topics.length),
    }
  }

  /**
   * 标题派生：复用 EpisodeBuilder 的来源优先级（chat > diary > manual > file/web > tool），
   * 但不直接调 pickTitle —— pickTitle 取的是「清洗后的整段文本」，多行消息会带进第二行；
   * 摘要层要的是第一句（且固定 28 字），两者口径不同。
   */
  private deriveTitle(episode: Episode, experiences: readonly Experience[]): string {
    const candidate = bestTitleExperience(experiences)
    if (candidate) {
      const title = trimTitle(firstSentence(stripRuntimeLines(candidate.content), 28), 28)
      if (title.length >= 2) return title
    }
    // 标题优先级最高的那条也拿不到标题（例如整段都是 JSON 回执）时，尊重已有的 Episode 标题。
    return fallbackTitle(episode)
  }
}

/** 运行期类型防御：Experience 来自数据库/调用方，content 未必真的是字符串。 */
function isUsableExperience(experience: Experience | undefined): experience is Experience {
  return typeof experience?.content === 'string'
}

/**
 * 挑「最适合当标题」的一条经历：来源优先级最高的优先，同优先级保留最早出现的那条
 * （保证标题稳定，不会随时间/顺序漂移）。结构化回执与纯宿主运行上下文不算标题来源。
 */
function bestTitleExperience(experiences: readonly Experience[]): Experience | undefined {
  let best: { score: number; experience: Experience } | undefined
  for (const experience of experiences) {
    if (looksLikeStructuredText(experience.content)) continue
    if (looksLikeToolOutput(experience.content)) continue
    if (looksLikePathHeavy(experience.content)) continue
    // 去掉宿主注入行后什么都不剩，说明这条经历本身不是人写的内容。
    if (stripMachineLines(stripRuntimeLines(experience.content)).length < 2) continue
    const score = TITLE_SOURCE_PRIORITY[experience.sourceType] ?? 0
    if (!best || score > best.score) best = { score, experience }
  }
  return best?.experience
}

/**
 * 抽取候选句：按 Experience 的原始顺序展开，跳过低信息量内容。
 * 只保留「自然语言且有信息量」的句子，所以结构化回执、宿主运行时注入行、寒暄短句都被过滤。
 */
function collectSentences(experiences: readonly Experience[]): string[] {
  const kept: string[] = []
  for (const experience of experiences) {
    if (looksLikeStructuredText(experience.content)) continue
    // 先整段去宿主注入行（它们可能占多行），再按句切分，避免残留半句。
    const cleaned = stripMachineLines(stripRuntimeLines(experience.content))
    if (cleaned.length === 0) continue
    for (const part of splitSentences(cleaned)) {
      const sentence = part.trim()
      if (sentence.length < MIN_SENTENCE_CHARS) continue
      if (looksLikeStructuredText(sentence)) continue
      // 代码/日志/路径清单不进摘要：读者要看的是「这段经历发生了什么」。
      if (looksLikeToolOutput(sentence)) continue
      if (looksLikePathHeavy(sentence)) continue
      if (looksLikeMachineLine(sentence)) continue
      // 符号占比过高（代码/序列化片段）的「句子」即使没被行级规则命中也不进摘要。
      if (looksLikeMachineDump(sentence)) continue
      // 相邻重复句去重：同一件事被记录两次（例如 chat 与 manual 各写一遍）只留一句。
      const previous = kept[kept.length - 1]
      if (previous !== undefined && bigramSimilarity(previous, sentence) > DUPLICATE_SIMILARITY) continue
      kept.push(sentence)
    }
  }
  return kept
}

/**
 * 选句：先按「关键词覆盖度 + 长度适中」打分取前 N，再按原始时间顺序还原。
 * 先排序后还原顺序，是为了让摘要读起来像时间线，而不是按分数从高到低跳着讲。
 */
function selectSentences(sentences: readonly string[], keywords: readonly string[]): string[] {
  if (sentences.length === 0) return []
  const ranked = sentences
    .map((text, order) => ({ text, order, score: scoreSentence(text, keywords) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
  // 2–4 句：候选不足 2 句时有多少用多少（空内容会走上面的空数组分支）。
  const take = Math.min(MAX_SUMMARY_SENTENCES, ranked.length)
  return ranked
    .slice(0, take)
    .sort((a, b) => a.order - b.order)
    .map((item) => item.text)
}

/**
 * 句子打分。关键词覆盖度占大头（这段经历反复提到的词 = 主题），
 * 长度只做「适中」约束：短句信息少，超长句会挤掉其余句子。
 */
function scoreSentence(text: string, keywords: readonly string[]): number {
  let hits = 0
  for (const keyword of keywords) {
    if (text.includes(keyword)) hits += 1
  }
  const coverage = keywords.length === 0 ? 0 : hits / keywords.length
  const lengthScore =
    text.length < 12 ? text.length / 12 : text.length <= 80 ? 1 : Math.max(0.2, 80 / text.length)
  // 决定/目标/偏好/约束是摘要真正要保住的东西（spec §3.3 优先级 1）。
  const intent = INTENT_PATTERN.test(text) ? 0.9 : 0
  const firstPerson = /我(?:们)?|咱[们]?/u.test(text) ? 0.2 : 0
  return coverage * 2 + lengthScore + intent + firstPerson
}

/** 拼接摘要：≤400 字；超长时按句截断并补省略号（不把句子从中间劈开）。 */
function composeSummary(sentences: readonly string[]): string {
  if (sentences.length === 0) return ''
  const normalized = sentences.map(ensureSentenceEnding)
  const parts: string[] = []
  let length = 0
  let dropped = false
  for (const sentence of normalized) {
    // 预留 1 个字符给截断省略号，保证输出严格 ≤400。
    if (length + sentence.length > MAX_SUMMARY_CHARS - 1) {
      dropped = true
      break
    }
    parts.push(sentence)
    length += sentence.length
  }
  if (parts.length === 0) {
    // 单句就超长：只能硬截，否则摘要会是空的。
    return `${normalized[0].slice(0, MAX_SUMMARY_CHARS - 1)}…`
  }
  const summary = parts.join('')
  if (dropped && summary.length < MAX_SUMMARY_CHARS) return `${summary}…`
  return summary
}

/** 代码/序列化片段的密度判定：符号占比高，或出现连续的箭头/花括号/分号。 */
function looksLikeMachineDump(text: string): boolean {
  if (text.length < 12) return false
  const symbols = (text.match(/[{}()\[\];=<>|\\/`]/g) ?? []).length
  if (symbols / text.length > 0.2) return true
  if (/=>|\{\s*"|function\s*\(|console\.log|\bconst\s+\w+\s*=/u.test(text)) return true
  return false
}

/** 有语义的句子特征：决定/目标/偏好/约束/计划。 */
const INTENT_PATTERN =
  /决定|结论|目标|计划|打算|以后|从此|优先|必须|不要|禁止|记住|偏好|倾向|约定|规则|原则/u

/** 句末补标点，避免短句直接拼接后读成一句话。 */
function ensureSentenceEnding(sentence: string): string {
  return /[。！？!?；;…]["'」』）)]?$/u.test(sentence) ? sentence : `${sentence}。`
}

/**
 * confidence 表示「这次摘要有多可信」：
 *   0.3 基线（至少是一条合法结果）+ 入选句数（0.1/句，最多 3 句）+ topics 覆盖（0.1/档，最多 2 档）。
 * 上限 0.8：抽取式不调模型，永远不声称高置信。
 */
function computeConfidence(sentenceCount: number, topicCount: number): number {
  const base = 0.3 + 0.1 * Math.min(3, sentenceCount) + 0.1 * Math.min(2, topicCount / 3)
  const clamped = Math.min(0.8, Math.max(0.3, base))
  return Math.round(clamped * 100) / 100
}

function fallbackTitle(episode: Episode | undefined): string {
  const title = typeof episode?.title === 'string' ? episode.title.trim() : ''
  return title.length > 0 ? title : FALLBACK_TITLE
}
