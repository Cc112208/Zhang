/**
 * tests/helpers.ts —— 测试用的临时数据库与可控时钟。
 *
 * 不 mock 数据库：所有测试都跑真实的 SQLite + FTS5（:memory: 无法跨进程复用，这里用临时目录）。
 * 时间也不 mock Date.now 全局，而是把 `now` 注入 Service —— 生产代码因此必须全部走注入时钟。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemorySeaService } from '../src/service.js'
import type { MemorySeaConfig } from '../src/config.js'
import type { MemorySeaLogger } from '../src/service.js'

export interface TestClock {
  now: number
  advance(ms: number): void
  set(ms: number): void
}

export function createClock(start = Date.UTC(2026, 0, 1, 9, 0, 0)): TestClock {
  let current = start
  return {
    get now() {
      return current
    },
    advance(ms: number) {
      current += ms
    },
    set(ms: number) {
      current = ms
    },
  } as TestClock
}

export const silentLogger: MemorySeaLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

export interface TestServiceOptions {
  clock?: TestClock
  config?: Partial<MemorySeaConfig>
  dbPath?: string
  logger?: MemorySeaLogger
}

export interface TestService {
  service: MemorySeaService
  clock: TestClock
  dbPath: string
  directory: string
  cleanup(): void
}

export function createTemporaryDirectory(prefix = 'memory-sea-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function buildService(dbPath: string, clock: TestClock, config?: Partial<MemorySeaConfig>, logger?: MemorySeaLogger): MemorySeaService {
  return new MemorySeaService({
    config: { enabled: true, databasePath: dbPath, ...(config ?? {}) },
    now: () => clock.now,
    logger: logger ?? silentLogger,
  })
}

export function createTestService(options: TestServiceOptions = {}): TestService {
  const clock = options.clock ?? createClock()
  const directory = createTemporaryDirectory()
  const dbPath = options.dbPath ?? join(directory, 'memory-sea.db')
  const service = buildService(dbPath, clock, options.config, options.logger)
  return {
    service,
    clock,
    dbPath,
    directory,
    cleanup() {
      service.closeSync()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

/** 打开同一个数据库文件的第二个 Service（用于验证重启后的启动清理）。 */
export function reopenService(dbPath: string, clock: TestClock, config?: Partial<MemorySeaConfig>): MemorySeaService {
  return buildService(dbPath, clock, config)
}

export const MINUTE = 60 * 1000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
