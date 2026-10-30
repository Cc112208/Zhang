/**
 * 端到端冒烟：不需要安装插件，直接跑 Service 全链路（场景 A–D）+ 用假 ctx 跑一遍插件入口
 * （ctx.provide / 三个工具 / 三条只读路由 / session-event 自动捕获）。
 * 运行：npm run smoke
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = join(tmpdir(), `memory-sea-smoke-${Date.now()}`)
mkdirSync(root, { recursive: true })
const dbPath = join(root, 'memory-sea.db')
process.env.DSH_MEMORY_SEA_DB = dbPath

const { MemorySeaService } = await import('../dist/src/service.js')
const plugin = await import('../dist/src/index.js')

const clockBase = Date.UTC(2026, 0, 1, 1, 0, 0)
let clock = clockBase
const service = new MemorySeaService({ config: { enabled: true, databasePath: dbPath }, now: () => clock, logger: { warn() {}, error() {} } })

// ---- 场景 A：连续三句话 → 3 Experiences + 1 Episode
const a1 = service.capture({ sourceType: 'chat', role: 'user', sessionId: 's-smoke', content: '今天研究 Memory Sea。' })
clock += 60_000
const a2 = service.capture({ sourceType: 'chat', role: 'user', sessionId: 's-smoke', content: '决定 V0.2 先用 SQLite。' })
clock += 60_000
const a3 = service.capture({ sourceType: 'chat', role: 'user', sessionId: 's-smoke', content: 'Neo4j 后面再上。' })
const st = service.status()
console.log('A) experiences=%d episodes=%d open=%d fts=%s sameEpisode=%s',
  st.experiences, st.episodes, st.openEpisodes, st.fts, a1.episode.id === a3.episode.id)

// ---- 场景 B：可解释召回
const hits = await service.recall({ query: '为什么 Memory Sea 先用 SQLite？' })
console.log('B) hits=%d', hits.length)
for (const hit of hits.slice(0, 3)) {
  console.log('   [%s] %s %s', hit.type, hit.score.toFixed(3), hit.content.slice(0, 40).replace(/\n/g, ' '))
  console.log('     reasons: %s', hit.reasons.map((r) => `${r.type}${r.detail ? `(${r.detail})` : ''}`).join(' | '))
}

// ---- 场景 C：证据链
const inspection = service.inspect(a2.episode.id)
console.log('C) episode=%s experiences=%d status=%s', inspection.episode.id, inspection.experiences.length, inspection.episode.status)
const back = service.inspect(a2.experience.id)
console.log('   experience→episode=%s 同集经历=%d', back.episode?.id, back.experiences.length)

// ---- 场景 D：Scene + legacy
const scene = service.getScene()
const legacy = service.getLegacyScene()
const again = service.getScene()
console.log('D) points=%d edges=%d stats=%j stable=%s',
  scene.points.length, scene.edges.length, scene.stats,
  JSON.stringify(scene.points.map((p) => p.x)) === JSON.stringify(again.points.map((p) => p.x)))
console.log('   legacy points=%d kinds=%j edgeKinds=%j', legacy.points.length,
  [...new Set(legacy.points.map((p) => p.kind))], [...new Set(legacy.edges.map((e) => e.kind))])

// ---- 插件入口：假 ctx 验证注册行为
const tools = []
const routes = []
const provided = new Map()
const listeners = new Map()
const fakeCtx = {
  logger: { info() {}, warn() {}, error() {} },
  provide(name, value) { provided.set(name, value) },
  tools: { register(def) { tools.push(def); return () => {} } },
  on(event, handler) { listeners.set(event, handler); return () => {} },
  get(name) {
    if (name !== 'webServer') return undefined
    return { register(route) { routes.push(route); return () => {} } }
  },
  effect(fn) { return fn() },
}
const dispose = plugin.apply(fakeCtx, { databasePath: dbPath + '.plugin' })
console.log('E) provided=%j tools=%j routes=%j listener=%s',
  [...provided.keys()], tools.map((t) => t.name), routes.map((r) => r.path), listeners.has('session/event'))

// 工具真跑一次（走插件自己的 service）
const remember = tools.find((t) => t.name === 'memory_remember')
const recall = tools.find((t) => t.name === 'memory_recall')
const inspect = tools.find((t) => t.name === 'memory_inspect')
const rememberOut = await remember.execute({ content: '用户说：以后都先用 SQLite。', importance: 0.9 }, { agent: { id: 's-plugin' } })
console.log('F) remember →\n%s', rememberOut)
const recallOut = await recall.execute({ query: 'SQLite' }, {})
console.log('G) recall →\n%s', recallOut.split('\n').slice(0, 6).join('\n'))
try {
  await inspect.execute({ id: 'nope' }, {})
  console.log('H) inspect(不存在) → 未抛错（不符合预期）')
} catch (error) {
  console.log('H) inspect(不存在) → 抛出可处理错误: %s', error.message)
}

// 路由处理器真跑一次
const statusRoute = routes.find((r) => r.path === '/api/memory-sea/status')
const payload = await new Promise((resolve) => {
  const chunks = []
  const res = { statusCode: 0, setHeader() {}, end(chunk) { resolve(typeof chunk === 'string' ? chunk : String(chunk ?? '')) } }
  statusRoute.handler({ method: 'GET', url: '/api/memory-sea/status', headers: {} }, res)
})
console.log('I) GET /api/memory-sea/status → %s', payload.slice(0, 200))

// 事件自动捕获：模拟一条 user/message
const before = provided.get('memorySea').status().experiences
listeners.get('session/event')?.({ id: 's-event' }, { type: 'user/message', seq: 1, time: clock, data: { content: [{ type: 'text', text: '这条应该被自动记录。' }] } })
listeners.get('session/event')?.({ id: 's-event' }, { type: 'assistant/message', seq: 2, time: clock, data: { message: { content: '已记录。' } } })
const after = provided.get('memorySea').status().experiences
console.log('J) auto-capture %d → %d', before, after)

// ---- Stage 2：scope 隔离 + 生命周期收割 + 后台摘要任务
clock += 10 * 60_000
const other = service.capture({ sourceType: 'chat', role: 'user', sessionId: 's-other', content: '另一个项目里决定先用 Neo4j。' }, { rootPath: 'C:/work/other-project' })
const scopeA = service.status()
const scopeB = service.status({ rootPath: 'C:/work/other-project' })
console.log('K) scope 隔离：当前 scope experiences=%d，另一项目 experiences=%d（%s）',
  scopeA.experiences, scopeB.experiences, other.scopeId.slice(0, 16))

clock += 40 * 60_000
const maintenance = service.runMaintenance()
console.log('L) 收割：closedEpisodes=%d enqueued=%d', maintenance.closedEpisodes, maintenance.enqueued)
let processed = 0
for (let round = 0; round < 30; round += 1) {
  processed += await service.drainJobs()
  if (service.status().jobs.pending === 0) break
}
const closedEpisodes = service.knownScopes().flatMap((scope) => {
  const scene = service.getScene({ scopeId: scope.id })
  return scene.points.filter((point) => point.type === 'episode')
})
const summarized = closedEpisodes.length > 0 ? service.getEpisode(closedEpisodes[0].id) : null
console.log('M) 后台任务：processed=%d，Episode 摘要状态=%s，标题=%s',
  processed, summarized?.summaryStatus ?? 'n/a', summarized?.title ?? 'n/a')
if (summarized?.summary) console.log('   摘要：%s', summarized.summary.slice(0, 120))
console.log('N) jobs:', JSON.stringify(service.status().jobs))

await dispose?.()
await service.close()
rmSync(root, { recursive: true, force: true })
console.log('SMOKE OK')
