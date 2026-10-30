/**
 * tools/inspect-memory.ts —— memory_inspect（spec §16）。
 *
 * Evidence Chain（Stage 3 版）：
 *   - 传 Experience id → 所属 Episode 与同 Episode 的其他原始经历；
 *   - 传 Episode id → Episode 及其全部原始 Experience；
 *   - 传 Memory id → 记忆本体 + Evidence Episode + 那些 Episode 的原始 Experience。
 *
 * 三种 id 都走同一个工具：Agent 不需要先判断类型，直接下钻到最原始的证据。
 */

import type { MemorySeaService } from '../service.js'
import {
  asRecord,
  flattenPreview,
  formatTime,
  requireString,
  textOutput,
  type ToolDefinitionSpec,
} from './tool-definition.js'
import type { Episode, Experience, MemoryInspection } from '../types.js'
import { assessSummaryQuality } from '../summary/summary-quality.js'

const MAX_ID_CHARS = 200
const CONTENT_PREVIEW_CHARS = 240

export function createInspectMemoryTool(service: MemorySeaService): ToolDefinitionSpec {
  return {
    name: 'memory_inspect',
    description:
      '检查一条记忆的证据链：传 Pattern id 返回支持/反驳它的长期知识与证据 Episode，传 Memory id 返回它由哪些 Episode 提炼而来（并可继续看到原始 Experience），传 Episode id 返回它的全部原始 Experience，传 Experience id 返回所属 Episode。用于核实任何结论的来源。',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Pattern id（pat_…）、Memory id（mem_…）、Episode id（ep_…）或 Experience id（xp_…）。',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    timeoutMs: 5_000,
    isConcurrencySafe: () => true,
    execute: (rawArgs) => {
      const args = asRecord(rawArgs)
      const id = requireString(args, 'id', MAX_ID_CHARS)
      const inspection = service.inspect(id)
      if (!inspection) {
        throw new Error(`没有找到 id 为 ${id} 的 Pattern、Memory、Episode 或 Experience`)
      }
      if (inspection.type === 'pattern') return formatPatternInspection(inspection)
      if (inspection.type === 'memory') return formatMemoryInspection(inspection)
      return inspection.type === 'episode'
        ? formatEpisodeInspection(inspection)
        : formatExperienceInspection(inspection)
    },
    output: textOutput(),
  }
}

function formatPatternInspection(inspection: MemoryInspection): string {
  const pattern = inspection.pattern
  if (!pattern) return `没有找到 id 为 ${inspection.id} 的 Pattern`
  const lines: string[] = [
    `Pattern：${pattern.content}`,
    `id：${pattern.id}｜类型：${pattern.kind}｜状态：${pattern.status}`,
    `置信度 ${pattern.confidence.toFixed(2)}｜重要性 ${pattern.importance.toFixed(2)}｜支持 ${pattern.supportCount}｜反证 ${pattern.contradictionCount}`,
    `首次出现：${formatTime(pattern.firstObservedAt)}｜最近出现：${formatTime(pattern.lastObservedAt)}`,
  ]
  if (pattern.lastReinforcedAt) lines.push(`最近强化：${formatTime(pattern.lastReinforcedAt)}`)
  if (pattern.lastReviewedAt) lines.push(`最近复核：${formatTime(pattern.lastReviewedAt)}`)
  if (pattern.subject) lines.push(`范围：${pattern.subject}`)
  if (pattern.supersededBy) lines.push(`已被取代：${pattern.supersededBy}（旧模式保留，用于回答「以前是什么模式」）`)

  const patternEvidence = inspection.patternEvidence ?? []
  const supportingMemories = inspection.memories ?? []
  lines.push('', `支持这条模式的知识（${supportingMemories.length} 条）：`)
  if (supportingMemories.length === 0) {
    lines.push('  （没有可展示的支持知识）')
  } else {
    supportingMemories.forEach((memory, index) => {
      lines.push(`  ${index + 1}. [${memory.kind}] ${memory.id} ${flattenPreview(memory.content, 160)}`)
    })
  }
  if (patternEvidence.length > 0) {
    const supports = patternEvidence.filter((item) => item.relation === 'supports').length
    const contradicts = patternEvidence.filter((item) => item.relation === 'contradicts').length
    lines.push(`证据关系：supports ${supports} 条、contradicts ${contradicts} 条`)
  }

  const episodes = inspection.episodes ?? []
  lines.push('', `证据 Episode（${episodes.length} 条）：`)
  if (episodes.length === 0) {
    lines.push('  （没有可展示的证据 Episode）')
  } else {
    episodes.forEach((episode, index) => {
      lines.push(`  ${index + 1}. ${formatEpisodeTitle(episode)}（${episode.id}，${formatTime(episode.startedAt)}）`)
    })
  }

  const experiences = inspection.experiences ?? []
  lines.push('', `原始 Experience（${experiences.length} 条）：`)
  experiences.forEach((experience, index) => {
    lines.push(`  ${index + 1}. [${experience.sourceType}] ${formatTime(experience.observedAt)} ${flattenPreview(experience.content, 160)}`)
  })
  lines.push('', '继续下钻：用 memory_inspect 传上面的 Memory id 可看到 Memory → Episode → Experience 的完整链。')
  appendEmbeddings(lines, inspection)
  return lines.join(String.fromCharCode(10))
}

function formatMemoryInspection(inspection: MemoryInspection): string {
  const memory = inspection.memory
  if (!memory) return `没有找到 id 为 ${inspection.id} 的 Memory`
  const lines: string[] = [
    `Memory：${memory.content}`,
    `id：${memory.id}｜类型：${memory.kind}｜状态：${memory.status}`,
    `置信度 ${memory.confidence.toFixed(2)}｜重要性 ${memory.importance.toFixed(2)}｜强化 ${memory.reinforcementCount} 次｜访问 ${memory.accessCount} 次`,
    `创建：${formatTime(memory.createdAt)}｜更新：${formatTime(memory.updatedAt)}`,
  ]
  if (memory.subject) lines.push(`主题：${memory.subject}`)
  if (memory.lastReinforcedAt) lines.push(`最近强化：${formatTime(memory.lastReinforcedAt)}`)
  if (memory.validFrom) {
    lines.push(`生效区间：${formatTime(memory.validFrom)} ~ ${memory.validUntil ? formatTime(memory.validUntil) : '现在'}`)
  }
  if (memory.supersededBy) lines.push(`已被取代：${memory.supersededBy}（旧结论保留，用于回答「当时为什么这样决定」）`)

  const evidence = inspection.evidence ?? []
  const episodes = inspection.episodes ?? []
  lines.push('', `证据 Episode（${episodes.length} 条）：`)
  if (episodes.length === 0) {
    lines.push('  （没有可展示的证据 Episode）')
  } else {
    episodes.forEach((episode, index) => {
      lines.push(
        `  ${index + 1}. ${formatEpisodeTitle(episode)}（${episode.id}，${formatTime(episode.startedAt)}）`,
      )
      if (episode.summary) lines.push(`     ${flattenPreview(episode.summary, 160)}`)
    })
  }
  if (evidence.length > 0) {
    lines.push(`证据关系：${evidence.map((item) => `${item.evidenceType}:${item.relation}`).join('、')}`)
  }

  const experiences = inspection.experiences ?? []
  lines.push('', `原始 Experience（${experiences.length} 条）：`)
  experiences.forEach((experience, index) => {
    lines.push(`  ${index + 1}. [${experience.sourceType}] ${formatTime(experience.observedAt)} ${flattenPreview(experience.content, 160)}`)
  })
  appendEmbeddings(lines, inspection)
  return lines.join(String.fromCharCode(10))
}

function formatExperienceInspection(inspection: MemoryInspection): string {
  const experience = inspection.experience
  if (!experience) return `没有找到 id 为 ${inspection.id} 的记忆`
  const lines: string[] = [
    `Experience：${experience.id}`,
    `来源：${experience.sourceType}${experience.role ? ` / ${experience.role}` : ''}`,
    `时间：${formatTime(experience.observedAt)}`,
    `重要性：${experience.importance.toFixed(2)}`,
    `内容：${flattenPreview(experience.content, CONTENT_PREVIEW_CHARS)}`,
  ]
  if (inspection.episode) {
    lines.push('', `所属 Episode：${formatEpisodeTitle(inspection.episode)}（${inspection.episode.id}）`)
    const siblings = inspection.experiences.filter((item) => item.id !== experience.id)
    if (siblings.length > 0) {
      lines.push(`同 Episode 的其他经历（${siblings.length} 条）：`)
      siblings.forEach((item, index) => {
        lines.push(`  ${index + 1}. ${formatTime(item.observedAt)} ${flattenPreview(item.content, 120)}`)
      })
    }
  } else {
    lines.push('', '该 Experience 尚未归属任何 Episode（可能是最早的记录或 Episode 已被清理）。')
  }
  appendEmbeddings(lines, inspection)
  return lines.join(String.fromCharCode(10))
}

function formatEpisodeInspection(inspection: MemoryInspection): string {
  const episode = inspection.episode
  if (!episode) return `没有找到 id 为 ${inspection.id} 的 Episode`
  const lines: string[] = [
    `Episode：${episode.title ?? '（未命名）'}`,
    `id：${episode.id}｜状态：${episode.status}`,
    `时间：${formatTime(episode.startedAt)} ~ ${episode.endedAt ? formatTime(episode.endedAt) : '进行中'}`,
    `重要性 ${episode.importance.toFixed(2)}｜显著性 ${episode.salience.toFixed(2)}｜置信度 ${episode.confidence.toFixed(2)}`,
  ]
  if (episode.topics.length > 0) lines.push(`主题：${episode.topics.join('、')}`)
  if (episode.participants.length > 0) lines.push(`参与者：${episode.participants.join('、')}`)
  if (episode.locations.length > 0) lines.push(`地点：${episode.locations.join('、')}`)
  if (episode.summary) lines.push(`摘要：${flattenPreview(episode.summary, 200)}`)

  // 连续性（Stage 4.5）：前后相连的 Episode 只是关系，不是证据 —— 这里单独一块展示。
  const continuity = inspection.continuity
  if (continuity && (continuity.previous.length > 0 || continuity.next.length > 0)) {
    lines.push('', '连续性（同一段经历的前后片段，不是证据）：')
    for (const item of continuity.previous) {
      lines.push(`  之前：${item.episodeId}｜${item.relation}｜置信度 ${item.confidence.toFixed(2)}${item.reason ? `｜${item.reason}` : ''}`)
    }
    for (const item of continuity.next) {
      lines.push(`  之后：${item.episodeId}｜${item.relation}｜置信度 ${item.confidence.toFixed(2)}${item.reason ? `｜${item.reason}` : ''}`)
    }
  }
  lines.push('', `原始 Experience（${inspection.experiences.length} 条）：`)
  inspection.experiences.forEach((experience, index) => {
    lines.push(`  ${index + 1}. [${experience.sourceType}${experience.role ? `/${experience.role}` : ''}] ${formatTime(experience.observedAt)}`)
    lines.push(`     ${flattenPreview(experience.content, CONTENT_PREVIEW_CHARS)}`)
  })
  if (inspection.orphanExperienceIds && inspection.orphanExperienceIds.length > 0) {
    lines.push('', `注意：有 ${inspection.orphanExperienceIds.length} 条经历关联到本 Episode 但自身 episode_id 不一致：${inspection.orphanExperienceIds.join(', ')}`)
  }
  appendEmbeddings(lines, inspection)
  return lines.join(String.fromCharCode(10))
}


function appendEmbeddings(lines: string[], inspection: MemoryInspection): void {
  const embeddings = inspection.embeddings ?? []
  if (embeddings.length === 0) return
  const labels = embeddings.map((item) => {
    const size = item.dimensions > 0 ? '(' + item.dimensions + 'd)' : ''
    return item.provider + '/' + item.model + size
  })
  lines.push('', '向量表示：' + labels.join('、'))
}

function formatEpisodeTitle(episode: Episode): string {
  return episode.title?.trim() || '（未命名 Episode）'
}

// 仅用于类型完整性检查，避免 Experience/Episode 字段被误改时静默漂移。
export type { Experience }
