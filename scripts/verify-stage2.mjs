/**
 * scripts/verify-stage2.mjs —— Stage 2 验收取证脚本（spec §63 A–D + §64 性能数据）。
 *
 * 直接跑编译产物（dist/src），不 mock 存储、不 mock 服务：
 *   node scripts/verify-stage2.mjs
 *
 * 输出：每个场景的关键证据（scope / episode / job / recall / scene）+ 性能数字。
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { MemorySeaService } = await import('../dist/src/service.js')
const { MemoryDatabase } = await import('../dist/src/storage/database.js')
const { EmbeddingRepository, contentHashOf } = await import('../dist/src/embedding/embedding-repository.js')
const { SqliteSemanticRecall } = await import('../dist/src/recall/semantic-recall.js')

const MINUTE = 60_000
const output = []
function say(line = '') {
  output.push(line)
  console.log(line)
}
function section(title) {
  say('')
  say(`=== ${title} ===`)
}

/** 可控时钟：capture 的 observedAt 全部由它决定，避免依赖真实时间。 */
function createClock(start = Date.UTC(2026, 9, 29, 9, 0, 0)) {
  let now = start
  return {
    now: () => now,
    advance: (ms) => {
      now += ms
    },
  }
}

const silentLogger = { info() {}, warn() {}, error() {} }

function buildService(dbPath, clock) {
  return new MemorySeaService({
    now: clock.now,
    logger: silentLogger,
    config: {
      enabled: true,
      databasePath: dbPath,
      // 后台定时器关掉，改成显式 drainJobs()/runMaintenance() 推进，结果可复现。
      jobs: { enabled: false, intervalMs: 5000, maxPerTick: 8, staleMs: 60_000, maxAttempts: 3 },
      embedding: { enabled: false },
    },
  })
}

const directory = mkdtempSync(join(tmpdir(), 'memory-sea-verify-'))
const dbPath = join(directory, 'verify.db')

try {
  // ------------------------------------------------------------------ A. Scope 隔离
  section('A. Scope 隔离（spec §47 / §63-A）')
  {
    const clock = createClock()
    const service = buildService(dbPath, clock)
    const scopeA = { rootPath: 'C:/work/project-a' }
    const scopeB = { rootPath: 'C:/work/project-b' }

    const a = service.capture(
      { content: 'V0.2 先用 SQLite。', sourceType: 'chat', role: 'user', sessionId: 's-a' },
      scopeA,
    )
    const b = service.capture(
      { content: '服务使用 PostgreSQL。', sourceType: 'chat', role: 'user', sessionId: 's-b' },
      scopeB,
    )

    const hitsA = await service.recall({ query: 'SQLite 数据库' }, scopeA)
    const hitsB = await service.recall({ query: 'SQLite 数据库' }, scopeB)
    const leaked = hitsA.filter((hit) => hit.content.includes('PostgreSQL'))

    say(`scopeA=${a.scopeId} scopeB=${b.scopeId} distinct=${a.scopeId !== b.scopeId}`)
    say(`A 命中 ${hitsA.length} 条：${hitsA.map((hit) => `${hit.type}:${hit.score}`).join(', ')}`)
    say(`B 命中 ${hitsB.length} 条：${hitsB.map((hit) => `${hit.type}:${hit.score}`).join(', ')}`)
    say(`A 里是否出现 B 的内容：${leaked.length > 0 ? '出现（失败）' : '未出现（通过）'}`)
    say(`A 第一条为什么召回：${JSON.stringify(hitsA[0]?.reasons ?? [])}`)
    say(`knownScopes=${JSON.stringify(service.knownScopes().map((scope) => scope.id))}`)
    service.closeSync()
  }

  // ------------------------------------------------------------------ B. Episode 生命周期
  section('B. Episode 生命周期（spec §49 / §63-B）')
  const lifecycleDb = join(directory, 'lifecycle.db')
  let openEpisodeId = ''
  {
    const clock = createClock()
    const service = buildService(lifecycleDb, clock)
    const scope = { rootPath: 'C:/work/lifecycle' }

    const first = service.capture({ content: '今天研究 Memory Sea。', sourceType: 'chat', role: 'user', sessionId: 's-life' }, scope)
    clock.advance(2 * MINUTE)
    service.capture({ content: '决定 V0.2 先用 SQLite。', sourceType: 'chat', role: 'user', sessionId: 's-life' }, scope)
    clock.advance(2 * MINUTE)
    service.capture({ content: 'Neo4j 后面再上。', sourceType: 'chat', role: 'user', sessionId: 's-life' }, scope)

    openEpisodeId = first.episode.id
    const open = service.getEpisode(openEpisodeId)
    say(`open episode=${openEpisodeId} status=${open?.status} experiences=${open?.experienceIds.length}`)
    say(`lastExperienceAt=${open?.lastExperienceAt}（应为最后一条经历时间）`)

    clock.advance(30 * MINUTE)
    const maintenance = service.runMaintenance()
    const closed = service.getEpisode(openEpisodeId)
    say(`runMaintenance closedEpisodes=${maintenance.closedEpisodes} enqueued=${maintenance.enqueued}`)
    say(`after sweep status=${closed?.status} closedReason=${closed?.closedReason} closedAt=${typeof closed?.closedAt}`)
    say(`endedAt 保留最后经历时间=${closed?.endedAt === closed?.lastExperienceAt}`)

    const handled = await service.drainJobs()
    const summarized = service.getEpisode(openEpisodeId)
    say(`drainJobs 处理 ${handled} 个任务 → summaryStatus=${summarized?.summaryStatus}`)
    say(`title=${JSON.stringify(summarized?.title)}`)
    say(`summary=${JSON.stringify((summarized?.summary ?? '').slice(0, 80))}`)
    const status = service.status(scope)
    say(`status.jobs=${JSON.stringify(status.jobs)} openEpisodes=${status.openEpisodes} closedEpisodes=${status.closedEpisodes}`)
    service.closeSync()
  }

  // ------------------------------------------------------------------ C. Semantic Recall + fallback
  section('C. Semantic Recall 与 lexical fallback（spec §53 / §63-C）')
  {
    // 注：真实的 openai-compatible provider 需要外部 API；这里用**注入的确定性 embedder**
    // 证明「语义通道确实接进了 recall 链路」，而不是证明某个模型的中文语义质量。
    const conceptDimensions = 8
    const conceptEmbedder = {
      name: 'verify-concepts',
      model: 'verify-concepts',
      dimensions: conceptDimensions,
      async isAvailable() {
        return true
      },
      async embed(text) {
        const vector = new Float32Array(conceptDimensions)
        const concept = (index, words) => {
          if (words.some((word) => text.includes(word))) vector[index] += 1
        }
        concept(0, ['Neo4j', '图数据库', '图', 'graph'])
        concept(1, ['SQLite', 'sqlite', '关系型', '表'])
        concept(2, ['PostgreSQL', 'postgres'])
        concept(3, ['数据库', '存储'])
        concept(4, ['为什么', '决定', '原因'])
        let norm = 0
        for (const value of vector) norm += value * value
        norm = Math.sqrt(norm) || 1
        for (let i = 0; i < vector.length; i += 1) vector[i] /= norm
        return vector
      },
    }

    const db = MemoryDatabase.open(':memory:')
    const scopeId = 'project_verify_semantic'
    db.run(
      `INSERT INTO experiences (id, source_type, content, created_at, observed_at, importance, metadata_json, embedding_status, scope_type, scope_id)
       VALUES (?, 'chat', ?, ?, ?, 0.6, '{}', 'ready', 'project', ?)`,
      'xp_sem_1',
      'Neo4j 暂时不上。',
      Date.UTC(2026, 9, 29, 9, 0, 0),
      Date.UTC(2026, 9, 29, 9, 0, 0),
      scopeId,
    )
    const repository = new EmbeddingRepository({ db, provider: 'verify-concepts', model: 'verify-concepts' })
    repository.upsert({
      scopeId,
      ownerType: 'experience',
      ownerId: 'xp_sem_1',
      vector: await conceptEmbedder.embed('Neo4j 暂时不上。'),
      contentHash: contentHashOf('Neo4j 暂时不上。'),
    })
    const semantic = new SqliteSemanticRecall({ embeddings: repository, embedder: conceptEmbedder })
    const semanticHits = await semantic.search(scopeId, '为什么没直接用图数据库？', 5)
    say(`semantic.available=${semantic.available} hits=${JSON.stringify(semanticHits)}`)

    // embedding 不可用（宿主默认）时：同一句话靠 lexical 仍能命中；纯语义改写的 query 只能靠语义通道。
    const clock = createClock()
    const service = buildService(join(directory, 'fallback.db'), clock)
    const scope = { rootPath: 'C:/work/fallback' }
    service.capture({ content: 'Neo4j 暂时不上。', sourceType: 'chat', role: 'user', sessionId: 's-c' }, scope)
    const lexicalHits = await service.recall({ query: 'Neo4j' }, scope)
    const paraphraseHits = await service.recall({ query: '为什么没直接用图数据库？' }, scope)
    say(`embedding disabled → 关键词 "Neo4j" 命中 ${lexicalHits.length} 条（lexical fallback 生效）`)
    say(`embedding disabled → 纯语义改写 "为什么没直接用图数据库？" 命中 ${paraphraseHits.length} 条（预期 0，说明语义通道缺失）`)
    const detailed = await service.recallDetailed({ query: 'Neo4j' }, scope)
    say(`weights=${JSON.stringify(detailed.weights)}`)
    service.closeSync()
    db.close()
  }

  // ------------------------------------------------------------------ D. 重启恢复
  section('D. 重启恢复（spec §50 / §51 / §63-D）')
  {
    const recoveryDb = join(directory, 'recovery.db')
    const clockA = createClock()
    let episodeId = ''
    {
      const service = buildService(recoveryDb, clockA)
      const scope = { rootPath: 'C:/work/recovery' }
      const captured = service.capture(
        { content: '崩溃恢复测试：先写一条经历。', sourceType: 'chat', role: 'user', sessionId: 's-d' },
        scope,
      )
      episodeId = captured.episode.id
      clockA.advance(30 * MINUTE)
      service.runMaintenance() // Episode 关闭 + summary job 入队
      const before = service.status(scope)
      say(`退出前 jobs=${JSON.stringify(before.jobs)} episodeStatus=${service.getEpisode(episodeId)?.status}`)
      service.closeSync() // 模拟宿主进程直接退出：不等后台跑完
    }
    {
      const service = buildService(recoveryDb, clockA)
      const scope = { rootPath: 'C:/work/recovery' }
      const recovered = service.status(scope)
      say(`重启后（启动恢复已执行）jobs=${JSON.stringify(recovered.jobs)}`)
      const handled = await service.drainJobs()
      const after = service.status(scope)
      say(`drainJobs 处理 ${handled} 个 → jobs=${JSON.stringify(after.jobs)}`)
      const episode = service.getEpisode(episodeId)
      say(`episode status=${episode?.status} summaryStatus=${episode?.summaryStatus} summary=${JSON.stringify((episode?.summary ?? '').slice(0, 40))}`)
      const scene = service.getScene(scope)
      say(`scene points=${scene.points.length} edges=${scene.edges.length} stats=${JSON.stringify(scene.stats)}`)
      service.closeSync()
    }
  }

  // ------------------------------------------------------------------ 性能数据
  section('性能数据（spec §64-8）')
  {
    const perfDb = join(directory, 'perf.db')
    const clock = createClock()
    const service = buildService(perfDb, clock)
    const scope = { rootPath: 'C:/work/perf' }

    const captureCount = 500
    const captureStart = process.hrtime.bigint()
    for (let i = 0; i < captureCount; i += 1) {
      service.capture(
        {
          content: `性能样本 ${i}：关于 Memory Sea 的 SQLite 与 Episode 设计记录。`,
          sourceType: 'chat',
          role: 'user',
          sessionId: `s-perf-${i % 5}`,
        },
        scope,
      )
      clock.advance(1000)
    }
    const captureMs = Number(process.hrtime.bigint() - captureStart) / 1e6

    const recallCount = 50
    const recallStart = process.hrtime.bigint()
    let lastHits = 0
    for (let i = 0; i < recallCount; i += 1) {
      const hits = await service.recall({ query: 'SQLite Episode 设计' }, scope)
      lastHits = hits.length
    }
    const recallMs = Number(process.hrtime.bigint() - recallStart) / 1e6

    const maintenanceStart = process.hrtime.bigint()
    const maintenance = service.runMaintenance()
    const maintenanceMs = Number(process.hrtime.bigint() - maintenanceStart) / 1e6

    const drainStart = process.hrtime.bigint()
    const drained = await service.drainJobs()
    const drainMs = Number(process.hrtime.bigint() - drainStart) / 1e6

    const dbBytes = statSync(perfDb).size
    const status = service.status(scope)
    say(`capture × ${captureCount}: ${captureMs.toFixed(1)} ms（平均 ${(captureMs / captureCount).toFixed(2)} ms/条）`)
    say(`recall × ${recallCount}: ${recallMs.toFixed(1)} ms（平均 ${(recallMs / recallCount).toFixed(2)} ms/次，最后一次命中 ${lastHits} 条）`)
    say(`runMaintenance: ${maintenanceMs.toFixed(1)} ms（closed=${maintenance.closedEpisodes} enqueued=${maintenance.enqueued}）`)
    say(`drainJobs: ${drainMs.toFixed(1)} ms（处理 ${drained} 个任务）`)
    say(`experiences=${status.experiences} episodes=${status.episodes} db=${(dbBytes / 1024 / 1024).toFixed(2)} MB`)
    service.closeSync()
  }

  say('')
  say('VERIFY STAGE 2 DONE')
} finally {
  try {
    rmSync(directory, { recursive: true, force: true })
  } catch {
    // 文件仍被占用时留给系统临时目录清理
  }
}
