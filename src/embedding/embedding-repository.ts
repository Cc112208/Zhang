/**
 * embedding-repository.ts —— 版本化向量存储（spec §24 / §25）。
 *
 * 表结构由迁移 006_embedding_versioning.sql 建好：
 *   embeddings(id, scope_id, owner_type, owner_id, provider, model, dimensions, content_hash, vector BLOB, created_at)
 *   UNIQUE(owner_type, owner_id, provider, model)
 *
 * 三个关键约定：
 *   1. **版本化**：读/写都带 provider + model，换模型不会读到旧向量，也不会污染旧行；
 *   2. **scope 隔离**：所有列表查询都强制 scope_id，语义召回绝不跨项目；
 *   3. **content_hash**：文本没变就不重算（job 层用 hash 比对，避免无意义网络请求）。
 *
 * 向量 ↔ BLOB：
 *   - 写入用 Float32Array 的原始字节视图（不是逐元素拷贝）；
 *   - 读取必须先复制到新的 ArrayBuffer 再建 Float32Array：node:sqlite 返回的
 *     Uint8Array 不保证 4 字节对齐，而且它的底层 Buffer 可能被复用，直接 new 会得到
 *     未对齐视图或读到被后续查询覆盖的数据。
 */

import { createHash } from 'node:crypto'
import type { EmbeddingMetadata, JobOwnerType } from '../types.js'
import type { MemoryDatabase } from '../storage/database.js'
import { TABLES } from '../storage/schema.js'

/** 被向量化的对象：原始 Experience、Episode，以及 Stage 3/4 的 Semantic Memory 与 Pattern。 */
const OWNER_TYPES: readonly JobOwnerType[] = ['experience', 'episode', 'memory', 'pattern']

export interface EmbeddingRepositoryDeps {
  db: MemoryDatabase
  /** provider 名（例：openai-compatible）。 */
  provider: string
  /** 模型名（例：text-embedding-3-small）。 */
  model: string
  /** 测试注入时钟，缺省 Date.now。 */
  now?: () => number
}

export interface UpsertEmbeddingInput {
  scopeId: string
  ownerType: JobOwnerType
  ownerId: string
  vector: Float32Array
  /** 被向量化文本的 sha256（hex），用于「文本没变就跳过」。 */
  contentHash: string
}

export interface StoredEmbeddingVector {
  ownerId: string
  vector: Float32Array
}

export interface StoredEmbeddingVectorWithType extends StoredEmbeddingVector {
  ownerType: JobOwnerType
}

/** 表行类型（只放用到的列，避免和迁移里的顺序耦合）。 */
interface EmbeddingRow {
  owner_id: string
  owner_type: string
  vector: Uint8Array
}

interface EmbeddingMetadataRow {
  provider: string
  model: string
  dimensions: number
  content_hash: string
  created_at: number
}

export class EmbeddingRepository {
  readonly #db: MemoryDatabase
  readonly #provider: string
  readonly #model: string
  readonly #now: () => number

  constructor(deps: EmbeddingRepositoryDeps) {
    this.#db = deps.db
    this.#provider = deps.provider
    this.#model = deps.model
    this.#now = deps.now ?? Date.now
  }

  /** 当前仓库绑定的 provider（inspect/status 用，避免调用方另存一份）。 */
  get provider(): string {
    return this.#provider
  }

  /** 当前仓库绑定的 model。 */
  get model(): string {
    return this.#model
  }

  /**
   * 写入/覆盖一个向量。
   *
   * 用 UNIQUE(owner_type, owner_id, provider, model) 做冲突目标：同一个对象重新 embedding
   * 时覆盖 vector/dimensions/content_hash/created_at，不新增行（id 保持首次写入值）。
   */
  upsert(input: UpsertEmbeddingInput): void {
    const { scopeId, ownerType, ownerId, vector, contentHash } = input
    if (vector.length === 0) {
      // 这里不静默跳过：空向量说明 provider/调用方有 bug，写进表只会制造「看起来有语义」的脏数据。
      throw new Error(`embedding 向量为空，拒绝写入（${ownerType}:${ownerId}）`)
    }
    const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
    this.#db.run(
      `INSERT INTO ${TABLES.embeddings}
         (id, scope_id, owner_type, owner_id, provider, model, dimensions, content_hash, vector, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_type, owner_id, provider, model) DO UPDATE SET
         scope_id = excluded.scope_id,
         dimensions = excluded.dimensions,
         content_hash = excluded.content_hash,
         vector = excluded.vector,
         created_at = excluded.created_at`,
      embeddingId(ownerType, ownerId, this.#provider, this.#model),
      scopeId,
      ownerType,
      ownerId,
      this.#provider,
      this.#model,
      vector.length,
      contentHash,
      bytes,
      this.#now(),
    )
  }

  /** 读取一个向量；不存在返回 null（embedding 是可选能力，null 不是错误）。 */
  get(ownerType: JobOwnerType, ownerId: string): { vector: Float32Array; contentHash: string } | null {
    const row = this.#db.get<{ vector: Uint8Array; content_hash: string }>(
      `SELECT vector, content_hash FROM ${TABLES.embeddings}
       WHERE owner_type = ? AND owner_id = ? AND provider = ? AND model = ?`,
      ownerType,
      ownerId,
      this.#provider,
      this.#model,
    )
    if (!row) return null
    return { vector: vectorFromBlob(row.vector), contentHash: row.content_hash }
  }

  /** 删除一个向量（对象被删除或 provider 失效时调用）。 */
  remove(ownerType: JobOwnerType, ownerId: string): void {
    this.#db.run(
      `DELETE FROM ${TABLES.embeddings}
       WHERE owner_type = ? AND owner_id = ? AND provider = ? AND model = ?`,
      ownerType,
      ownerId,
      this.#provider,
      this.#model,
    )
  }

  /** 某 scope 下某类对象的全部向量（按写入时间倒序）。limit 缺省表示不限。 */
  listByOwnerType(scopeId: string, ownerType: JobOwnerType, limit?: number): StoredEmbeddingVector[] {
    const capped = normalizeLimit(limit)
    if (capped === 0) return []
    const rows = this.#db.all<{ owner_id: string; vector: Uint8Array }>(
      `SELECT owner_id, vector FROM ${TABLES.embeddings}
       WHERE scope_id = ? AND owner_type = ? AND provider = ? AND model = ? AND dimensions > 0
       ORDER BY created_at DESC${capped === undefined ? '' : ' LIMIT ?'}`,
      ...(capped === undefined
        ? [scopeId, ownerType, this.#provider, this.#model]
        : [scopeId, ownerType, this.#provider, this.#model, capped]),
    )
    return rows.map((row) => ({ ownerId: row.owner_id, vector: vectorFromBlob(row.vector) }))
  }

  /**
   * 语义召回的候选来源：一次取多类对象的向量。
   * 顺序 = created_at DESC（新向量优先），limit 是扫描上限，防止大库把一次 recall 拖慢。
   */
  loadVectors(scopeId: string, ownerTypes: JobOwnerType[], limit?: number): StoredEmbeddingVectorWithType[] {
    const types = [...new Set(ownerTypes)].filter(isOwnerType)
    if (types.length === 0) return []
    const capped = normalizeLimit(limit)
    if (capped === 0) return []

    const placeholders = types.map(() => '?').join(', ')
    const params: (string | number)[] = [scopeId, ...types, this.#provider, this.#model]
    if (capped !== undefined) params.push(capped)
    const rows = this.#db.all<EmbeddingRow>(
      `SELECT owner_id, owner_type, vector FROM ${TABLES.embeddings}
       WHERE scope_id = ? AND owner_type IN (${placeholders})
         AND provider = ? AND model = ? AND dimensions > 0
       ORDER BY created_at DESC${capped === undefined ? '' : ' LIMIT ?'}`,
      ...params,
    )
    return rows.map((row) => ({
      ownerId: row.owner_id,
      ownerType: row.owner_type as JobOwnerType,
      vector: vectorFromBlob(row.vector),
    }))
  }

  /** 只返回元数据（inspect 用；绝不返回完整向量，避免把大数组喷给模型/用户）。 */
  metadata(ownerType: JobOwnerType, ownerId: string): EmbeddingMetadata | null {
    const row = this.#db.get<EmbeddingMetadataRow>(
      `SELECT provider, model, dimensions, content_hash, created_at FROM ${TABLES.embeddings}
       WHERE owner_type = ? AND owner_id = ? AND provider = ? AND model = ?`,
      ownerType,
      ownerId,
      this.#provider,
      this.#model,
    )
    if (!row) return null
    return {
      provider: row.provider,
      model: row.model,
      dimensions: row.dimensions,
      contentHash: row.content_hash,
      createdAt: row.created_at,
    }
  }

  /** 当前 scope 下属于本 provider/model 的向量条数（状态接口/健康检查用）。 */
  countByScope(scopeId: string): number {
    const row = this.#db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${TABLES.embeddings}
       WHERE scope_id = ? AND provider = ? AND model = ?`,
      scopeId,
      this.#provider,
      this.#model,
    )
    return Number(row?.n ?? 0)
  }
}

/** 被向量化文本的稳定指纹（sha256 hex）。job 层用它判断「文本没变就跳过重算」。 */
export function contentHashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// ------------------------------------------------------------------ 内部

/** 与迁移 006 的 id 生成规则保持一致：owner_type:owner_id:provider:model。 */
function embeddingId(ownerType: JobOwnerType, ownerId: string, provider: string, model: string): string {
  return `${ownerType}:${ownerId}:${provider}:${model}`
}

/**
 * limit 归一化：
 *   undefined → 不限；
 *   <= 0     → 0（调用方明确不要结果）；
 *   其余     → 向下取整。
 * 用 undefined 而不是 -1 表达「不限」，SQL 里才能干净地不加 LIMIT。
 */
function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return undefined
  const int = Math.floor(limit)
  return int > 0 ? int : 0
}

function isOwnerType(value: string): value is JobOwnerType {
  return (OWNER_TYPES as readonly string[]).includes(value)
}

/**
 * BLOB → Float32Array。
 * 先复制到全新 ArrayBuffer：node:sqlite 的 BLOB 是 Uint8Array（底层可能是被复用的 Buffer），
 * 直接 `new Float32Array(blob.buffer, blob.byteOffset, ...)` 既有对齐风险，也会在下次查询后变脏。
 */
function vectorFromBlob(blob: Uint8Array): Float32Array {
  if (!(blob instanceof Uint8Array) || blob.byteLength === 0) return new Float32Array(0)
  if (blob.byteLength % 4 !== 0) {
    throw new Error(`embeddings.vector 长度非法：${blob.byteLength} 字节不是 4 的倍数`)
  }
  const copy = new Uint8Array(blob.byteLength)
  copy.set(blob)
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4)
}
