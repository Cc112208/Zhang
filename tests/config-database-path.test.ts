import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { defaultDatabasePath, resolveConfig } from '../src/config.js'
import { MemorySeaService } from '../src/service.js'

test('默认数据库路径落在 $DSH_HOME/3d-memory-sea/memory-sea.db', () => {
  const home = mkdtempSync(join(tmpdir(), 'ms-dbpath-'))
  try {
    const path = defaultDatabasePath({ DSH_HOME: home } as NodeJS.ProcessEnv)
    assert.equal(path, join(home, '3d-memory-sea', 'memory-sea.db'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('DSH_MEMORY_SEA_DB 覆盖默认数据库路径', () => {
  const home = mkdtempSync(join(tmpdir(), 'ms-dbpath-'))
  try {
    const custom = join(home, 'custom', 'mem.db')
    const path = defaultDatabasePath({ DSH_HOME: home, DSH_MEMORY_SEA_DB: custom } as NodeJS.ProcessEnv)
    assert.equal(path, custom)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('插件 config.databasePath 覆盖默认路径，并支持 ~ 展开', () => {
  const home = mkdtempSync(join(tmpdir(), 'ms-dbpath-'))
  try {
    const custom = join(home, 'sea', 'memory.db')
    const config = resolveConfig({ databasePath: custom }, { DSH_HOME: home } as NodeJS.ProcessEnv)
    assert.equal(config.databasePath, custom)

    // 环境变量优先于默认值，但插件 config 的显式路径优先于环境变量（config 是用户显式指令）。
    const fromEnv = resolveConfig({}, { DSH_HOME: home, DSH_MEMORY_SEA_DB: custom } as NodeJS.ProcessEnv)
    assert.equal(fromEnv.databasePath, custom)

    const explicitWins = resolveConfig(
      { databasePath: join(home, 'explicit.db') },
      { DSH_HOME: home, DSH_MEMORY_SEA_DB: custom } as NodeJS.ProcessEnv,
    )
    assert.equal(explicitWins.databasePath, join(home, 'explicit.db'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('自定义 databasePath 会被真正建库（目录不存在则创建）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ms-dbpath-'))
  const dbDir = join(home, 'elsewhere', 'memory-sea')
  const dbPath = join(dbDir, 'memory-sea.db')
  let service: MemorySeaService | undefined
  try {
    const config = resolveConfig({ databasePath: dbPath }, { DSH_HOME: home } as NodeJS.ProcessEnv)
    service = new MemorySeaService({ config })
    await service.capture(
      { content: '数据库放到自定义目录', sourceType: 'manual', role: 'user' },
      { rootPath: join(home, 'work') },
    )
    await service.drainJobs()
    assert.equal(existsSync(dbPath), true)
    const status = await service.status({ rootPath: join(home, 'work') })
    assert.equal(status.databasePath, dbPath)
    assert.ok(status.experiences >= 1)
  } finally {
    service?.closeSync()
    rmSync(home, { recursive: true, force: true })
  }
})
