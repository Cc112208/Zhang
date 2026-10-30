/**
 * scene-page-data.ts —— 3D 页面与校验脚本共用的纯函数（Stage 6）。
 *
 * 这里只做「把后端 Scene 读成前端需要的形状并做完整性检查」，
 * 不产生任何数据、不修改记忆模型，也不发请求（便于单测与离线校验）。
 */

import type { MemorySeaScene, SceneEdge, ScenePoint, RecallType } from '../types.js'

export interface ScenePayload {
  scopeId: string
  points: ScenePoint[]
  edges: SceneEdge[]
  stats: MemorySeaScene['stats']
}

export interface SceneValidation {
  ok: boolean
  problems: string[]
  counts: Record<RecallType, number>
  edgeKinds: Record<string, number>
}

const POINT_TYPES: readonly RecallType[] = ['experience', 'episode', 'memory', 'pattern']

/** 页面只需要这三个字段；其余统计由 stats 提供（避免前端重复计算口径）。 */
export function toScenePayload(scene: MemorySeaScene): ScenePayload {
  return {
    scopeId: scene.scopeId ?? '',
    points: scene.points,
    edges: scene.edges,
    stats: scene.stats,
  }
}

/**
 * Scene 完整性检查：
 *   1. 每条边的两端都必须存在于 points（否则前端会画出悬空线）；
 *   2. 每条边都必须有可读 reason（规格：关系必须可解释，不允许随机连线）；
 *   3. 坐标必须是有限数（NaN 会让整个投影矩阵失效）。
 */
export function validateScene(scene: Pick<MemorySeaScene, 'points' | 'edges'>): SceneValidation {
  const problems: string[] = []
  const ids = new Set<string>()
  const counts = { experience: 0, episode: 0, memory: 0, pattern: 0 } as Record<RecallType, number>
  const edgeKinds: Record<string, number> = {}

  for (const point of scene.points) {
    if (ids.has(point.id)) problems.push(`重复节点 id：${point.id}`)
    ids.add(point.id)
    if (POINT_TYPES.includes(point.type)) counts[point.type] += 1
    else problems.push(`未知节点类型：${String(point.type)}（${point.id}）`)
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
      problems.push(`节点坐标非有限数：${point.id}`)
    }
    if (typeof point.label !== 'string' || point.label.length === 0) {
      problems.push(`节点缺少 label：${point.id}`)
    }
  }

  for (const edge of scene.edges) {
    if (!ids.has(edge.a)) problems.push(`边引用了不存在的节点：a=${edge.a}`)
    if (!ids.has(edge.b)) problems.push(`边引用了不存在的节点：b=${edge.b}`)
    if (typeof edge.reason !== 'string' || edge.reason.trim().length === 0) {
      problems.push(`边缺少可读 reason：${edge.a}→${edge.b}（${edge.kind}）`)
    }
    edgeKinds[edge.kind] = (edgeKinds[edge.kind] ?? 0) + 1
  }

  return { ok: problems.length === 0, problems, counts, edgeKinds }
}

/** 节点类型的展示名（面板与图例共用一份文案）。 */
export function nodeTypeLabel(type: RecallType): string {
  switch (type) {
    case 'experience':
      return '经历'
    case 'episode':
      return '连续经历'
    case 'memory':
      return '长期记忆'
    case 'pattern':
      return '模式'
    default:
      return String(type)
  }
}

/** 边类型的展示名与颜色（颜色在客户端与测试里共用）。 */
export function edgeStyle(kind: string): { label: string; color: string; dashed: boolean; width: number } {
  switch (kind) {
    case 'contains':
      return { label: '归属', color: 'rgba(143,161,184,0.15)', dashed: false, width: 0.8 }
    case 'derived_from':
      return { label: '提炼自', color: 'rgba(153,191,222,0.42)', dashed: false, width: 1.1 }
    case 'supports':
      return { label: '支持', color: 'rgba(157,198,184,0.40)', dashed: false, width: 1.1 }
    case 'supported_by':
      return { label: '被支持', color: 'rgba(157,198,184,0.34)', dashed: false, width: 1 }
    case 'contradicted_by':
      return { label: '被反驳', color: 'rgba(190,132,132,0.44)', dashed: true, width: 1 }
    case 'continues':
      return { label: '延续', color: 'rgba(195,173,130,0.38)', dashed: true, width: 1 }
    case 'followup':
      return { label: '后续', color: 'rgba(195,173,130,0.32)', dashed: true, width: 0.9 }
    case 'same_thread':
      return { label: '同一线索', color: 'rgba(164,161,190,0.30)', dashed: true, width: 0.9 }
    case 'same_topic':
      return { label: '同一话题', color: 'rgba(151,171,199,0.28)', dashed: true, width: 0.9 }
    default:
      return { label: kind, color: 'rgba(143,161,184,0.24)', dashed: false, width: 0.9 }
  }
}
