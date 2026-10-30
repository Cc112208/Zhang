/**
 * database.ts —— SQLite 连接、迁移与事务。
 *
 * 技术选择（Decision）：用 Node 24 内置 `node:sqlite`（DatabaseSync），
 *   - 零运行时依赖（V0.2 不想为了一版记忆系统引入 native 模块编译链）；
 *   - 同步 API 更适合 capture 这种「必须尽可能快」的写入路径；
 *   - 单机单进程够用，未来要并发再换 better-sqlite3 / worker 线程。
 *
 * FTS5 是可选能力：迁移失败只降级（ftsAvailable=false），不阻断启动。
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StorageError, errorMessage } from '../errors.js'
import { deriveProjectScopeId } from '../scope/path-normalizer.js'
import { OPTIONAL_MIGRATIONS, TABLES } from './schema.js'

export type SqlValue = string | number | bigint | null | Uint8Array

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url))

export class MemoryDatabase {
  readonly path: string
  private readonly handle: DatabaseSync
  private depth = 0
  private fts = false
  private memoryFts = false
  private patternFts = false
  private closed = false

  private constructor(path: string, handle: DatabaseSync) {
    this.path = path
    this.handle = handle
  }

  /** 打开（并在需要时创建）数据库，执行未应用的迁移。 */
  static open(path: string): MemoryDatabase {
    const isMemory = path === ':memory:'
    if (!isMemory) {
      const absolute = resolve(path)
      mkdirSync(dirname(absolute), { recursive: true })
    }

    let handle: DatabaseSync
    try {
      handle = new DatabaseSync(path)
    } catch (error) {
      throw new StorageError(`无法打开 SQLite 数据库 ${path}: ${errorMessage(error)}`, { cause: error })
    }

    const db = new MemoryDatabase(path, handle)
    try {
      if (!isMemory) {
        // WAL 让读不阻塞写；busy_timeout 兜住偶发并发。
        handle.exec('PRAGMA journal_mode = WAL;')
        handle.exec('PRAGMA synchronous = NORMAL;')
      }
      handle.exec('PRAGMA foreign_keys = ON;')
      handle.exec('PRAGMA busy_timeout = 5000;')
      db.migrate()
      db.fts = db.detectFts()
      db.memoryFts = db.detectMemoryFts()
      db.patternFts = db.detectPatternFts()
      db.backfillScopeIds()
    } catch (error) {
      db.close()
      throw error instanceof StorageError
        ? error
        : new StorageError(`初始化数据库失败: ${errorMessage(error)}`, { cause: error })
    }
    return db
  }

  get ftsAvailable(): boolean {
    return this.fts
  }

  /** Stage 3：Memory FTS 是否可用（失败只降级 LIKE，不阻断启动）。 */
  get memoryFtsAvailable(): boolean {
    return this.memoryFts
  }

  /** Stage 4：patterns_fts 是否可用（不可用时 Pattern 检索降级 LIKE）。 */
  get patternFtsAvailable(): boolean {
    return this.patternFts
  }

  get isClosed(): boolean {
    return this.closed
  }

  // ---------------------------------------------------------------- 查询封装

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    this.assertOpen()
    const stmt = this.handle.prepare(sql) as StatementSync
    return stmt.all(...(params as never[])) as unknown as T[]
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    this.assertOpen()
    const stmt = this.handle.prepare(sql) as StatementSync
    return stmt.get(...(params as never[])) as unknown as T | undefined
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    this.assertOpen()
    const stmt = this.handle.prepare(sql) as StatementSync
    const result = stmt.run(...(params as never[]))
    return {
      changes: Number(result.changes ?? 0),
      lastInsertRowid: Number(result.lastInsertRowid ?? 0),
    }
  }

  exec(sql: string): void {
    this.assertOpen()
    this.handle.exec(sql)
  }

  // ---------------------------------------------------------------- 事务

  /**
   * 同步事务。支持嵌套（内层用 SAVEPOINT，保证 EpisodeBuilder 可以自行组合事务）。
   * 只允许同步回调 —— 跨 await 持有事务是隐患，故类型上就限制住。
   */
  transaction<T>(fn: () => T): T {
    this.assertOpen()
    const depth = this.depth
    const savepoint = `memory_sea_sp_${depth}`
    try {
      this.handle.exec(depth === 0 ? 'BEGIN IMMEDIATE;' : `SAVEPOINT ${savepoint};`)
    } catch (error) {
      throw new StorageError(`开启事务失败: ${errorMessage(error)}`, { cause: error })
    }
    this.depth = depth + 1
    try {
      const result = fn()
      this.depth = depth
      this.handle.exec(depth === 0 ? 'COMMIT;' : `RELEASE ${savepoint};`)
      return result
    } catch (error) {
      this.depth = depth
      try {
        this.handle.exec(depth === 0 ? 'ROLLBACK;' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint};`)
      } catch {
        // 回滚失败说明连接已坏，交给上层重建；不掩盖原始错误。
      }
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.handle.close()
    } catch {
      // 关不掉不致命
    }
  }

  // ---------------------------------------------------------------- 内部

  private assertOpen(): void {
    if (this.closed) throw new StorageError('数据库连接已关闭')
  }

  private detectMemoryFts(): boolean {
    try {
      const row = this.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        TABLES.memoryFts,
      )
      return Boolean(row?.name)
    } catch {
      return false
    }
  }

  private detectPatternFts(): boolean {
    try {
      const row = this.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        TABLES.patternFts,
      )
      return Boolean(row?.name)
    } catch {
      return false
    }
  }

  private detectFts(): boolean {
    try {
      const row = this.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        TABLES.experienceFts,
      )
      return Boolean(row?.name)
    } catch {
      return false
    }
  }

  /**
   * Stage 2 迁移：把 Stage 1 的 `p_<hash>` / `project_legacy` 作用域按 scope_root 重算成
   * 新的稳定 id（`project_<hash16>`，规范化路径 + sha256）。
   *
   * 为什么必须在启动时做：旧数据里只有 scope_root 是可逆的，scope_id 是旧算法产物；
   * 如果放任它们留在 project_legacy，等于把历史经验从项目召回里排除掉 —— 那是数据丢失。
   * 无法推导（scope_root 为空）的行保持 project_legacy：宁可少召回，也不猜。
   *
   * 幂等：只在 scope_id='project_legacy' 且 scope_root 非空时更新。
   */
  private backfillScopeIds(): void {
    try {
      const columns = this.all<{ name: string }>('PRAGMA table_info(experiences)').map((row) => row.name)
      if (!columns.includes('scope_root')) return

      // Stage 1 的 scope_id 是 p_xxxx 形态，阶段 2 是 project_<hash>；
      // 任何「不是规范 project id 也不是 global」的历史行都按 legacy 处理，用旧 scope_root 重算。
      const legacyFilter = "(scope_id IS NULL OR ((scope_id = 'project_legacy' OR scope_id NOT LIKE 'project_%') AND scope_id <> 'global'))"
      const roots = this.all<{ scope_root: string }>(
        `SELECT DISTINCT scope_root FROM experiences WHERE ${legacyFilter} AND scope_root IS NOT NULL`,
      )
      const episodeRoots = this.all<{ scope_root: string }>(
        `SELECT DISTINCT scope_root FROM episodes WHERE ${legacyFilter} AND scope_root IS NOT NULL`,
      )
      const uniqueRoots = new Set<string>()
      for (const row of roots) uniqueRoots.add(row.scope_root)
      for (const row of episodeRoots) uniqueRoots.add(row.scope_root)
      if (uniqueRoots.size === 0) return

      this.transaction(() => {
        for (const root of uniqueRoots) {
          const scopeId = deriveProjectScopeId(root)
          this.run(
            `UPDATE experiences SET scope_id = ? WHERE ${legacyFilter} AND scope_root = ?`,
            scopeId,
            root,
          )
          this.run(
            `UPDATE episodes SET scope_id = ? WHERE ${legacyFilter} AND scope_root = ?`,
            scopeId,
            root,
          )
        }
      })
    } catch (error) {
      // 回填失败不阻断启动：旧数据仍可用（只是落在 legacy scope），下次启动会重试。
      console.warn(`[memory-sea] 作用域回填失败: ${errorMessage(error)}`)
    }
  }

  private migrate(): void {
    this.handle.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLES.migrations} (
         version    TEXT PRIMARY KEY,
         applied_at INTEGER NOT NULL
       );`,
    )

    const applied = new Set(
      this.all<{ version: string }>(`SELECT version FROM ${TABLES.migrations}`).map((row) => row.version),
    )

    if (!existsSync(MIGRATIONS_DIR)) {
      throw new StorageError(`找不到迁移目录: ${MIGRATIONS_DIR}`)
    }

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort()

    for (const file of files) {
      if (applied.has(file)) continue
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
      const optional = OPTIONAL_MIGRATIONS.has(file)
      try {
        this.transaction(() => {
          this.handle.exec(sql)
          this.handle
            .prepare(`INSERT INTO ${TABLES.migrations} (version, applied_at) VALUES (?, ?)`)
            .run(file, Date.now())
        })
      } catch (error) {
        if (optional) {
          // 例如 SQLite 未编译 fts5：降级到 LIKE fallback，不在启动时炸掉宿主。
          console.warn(`[memory-sea] 可选迁移 ${file} 失败，已降级: ${errorMessage(error)}`)
          continue
        }
        throw new StorageError(`迁移 ${file} 失败: ${errorMessage(error)}`, { cause: error })
      }
    }
  }
}
