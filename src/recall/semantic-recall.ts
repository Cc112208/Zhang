/**
 * semantic-recall.ts —— 语义召回的独立实现（spec §25）。
 *
 * 关键约束：
 *   - cosine / 向量表 / 向量库都只出现在本模块（和 embedding 模块）；
 *     RecallEngine 完全不知道向量怎么存，只拿到 SemanticHit[]。
 *   - scopeId 是硬过滤条件：绝不跨项目做相似度检索。
 *   - embed 失败直接抛错，由 RecallEngine 捕获后降级 semantic 通道 ——
 *     这里不吞异常、也不返回空数组冒充「没有相似结果」。
 *
 * 两个实现：
 *   - NullSemanticRecall：没有 embedding 能力时的零成本实现；
 *   - SqliteSemanticRecall：SQLite BLOB + 暴力 cosine。V0.2 的量级（单项目、几万条）
 *     足够快；未来换 Qdrant / pgvector / sqlite-vec 只需换掉本类。
 */

import { cosineSimilarity } from '../embedding/embedding-provider.js'
import type { EmbeddingRepository } from '../embedding/embedding-repository.js'
import type { EmbeddingProvider, JobOwnerType, RecallType, SemanticHit, SemanticRecallProvider } from '../types.js'

/** 没有语义能力时的空实现：不做 IO，直接空结果。 */
export class NullSemanticRecall implements SemanticRecallProvider {
  readonly available = false

  async search(_scopeId: string, _query: string, _limit: number): Promise<SemanticHit[]> {
    return []
  }
}

export interface SqliteSemanticRecallDeps {
  embeddings: EmbeddingRepository
  /** null = 没有可用 embedding；available 会返回 false。 */
  embedder: EmbeddingProvider | null
  /** 单次扫描的向量上限，防止大库把一次 recall 拖成慢查询。默认 20000。 */
  maxVectors?: number
  /** 只用于「维度不一致被跳过」这类可解释的告警，缺省静默。 */
  logger?: { warn?(message: string): void }
}

/** 候选对象类型：Experience / Episode / Semantic Memory / Pattern 都参与语义召回（spec §37/§48）。 */
const CANDIDATE_TYPES: readonly JobOwnerType[] = ['experience', 'episode', 'memory', 'pattern']

const DEFAULT_MAX_VECTORS = 20_000

/** 只有这四类可以被召回；Skill 候选/尝试没有召回语义，绝不能混进语义通道。 */
function recallTypeOf(ownerType: JobOwnerType): RecallType | null {
  switch (ownerType) {
    case 'experience':
    case 'episode':
    case 'memory':
    case 'pattern':
      return ownerType
    default:
      return null
  }
}

export class SqliteSemanticRecall implements SemanticRecallProvider {
  readonly #embeddings: EmbeddingRepository
  readonly #embedder: EmbeddingProvider | null
  readonly #maxVectors: number
  readonly #logger: { warn?(message: string): void } | undefined

  constructor(deps: SqliteSemanticRecallDeps) {
    this.#embeddings = deps.embeddings
    this.#embedder = deps.embedder
    this.#maxVectors = normalizeMaxVectors(deps.maxVectors)
    this.#logger = deps.logger
  }

  /**
   * 动态判断：provider 的维度在第一次成功调用后才确定（0 = 未知），
   * 所以这里用 getter，而不是构造期的快照。
   */
  get available(): boolean {
    return this.#embedder !== null && this.#embedder.dimensions > 0
  }

  /**
   * 语义检索：embed(query) → 取本 scope 候选 → cosine → 降序截断。
   *
   * 只保留 score > 0 的候选：正交/负相关（score<=0）不构成「语义相近」的证据，
   * 混进 fusion 只会稀释其他通道的分数。
   */
  async search(scopeId: string, query: string, limit: number): Promise<SemanticHit[]> {
    const embedder = this.#embedder
    if (!embedder || embedder.dimensions <= 0) return []

    const trimmed = typeof query === 'string' ? query.trim() : ''
    if (trimmed.length === 0) return []
    const maxResults = normalizeLimit(limit)
    if (maxResults === 0) return []

    // 故意不 try/catch：网络/维度错误必须冒泡，让 RecallEngine 记降级并继续。
    const queryVector = await embedder.embed(trimmed)
    if (queryVector.length === 0) {
      // provider 声称可用却返回空向量：视为本通道无结果，但让调用方知道配置有问题。
      this.#logger?.warn?.('[memory-sea] semantic recall: embedding provider 返回了空向量，已跳过语义通道')
      return []
    }

    const candidates = this.#embeddings.loadVectors(scopeId, [...CANDIDATE_TYPES], this.#maxVectors)
    const hits: SemanticHit[] = []
    let skipped = 0
    for (const candidate of candidates) {
      if (candidate.vector.length !== queryVector.length) {
        skipped += 1
        continue
      }
      const type = recallTypeOf(candidate.ownerType)
      if (!type) continue
      const score = cosineSimilarity(queryVector, candidate.vector)
      if (!Number.isFinite(score) || score <= 0) continue
      hits.push({ id: candidate.ownerId, type, score: Math.min(1, score) })
    }
    if (skipped > 0) {
      this.#logger?.warn?.(
        `[memory-sea] semantic recall: ${skipped} 条向量维度与查询不一致已跳过（可能是换了模型未重算）`,
      )
    }

    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, maxResults)
  }
}

// ------------------------------------------------------------------ 内部

function normalizeMaxVectors(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_VECTORS
  const int = Math.floor(value)
  return int > 0 ? int : DEFAULT_MAX_VECTORS
}

function normalizeLimit(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const int = Math.floor(value)
  return int > 0 ? int : 0
}
