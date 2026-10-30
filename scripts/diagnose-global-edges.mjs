#!/usr/bin/env node
/**
 * diagnose-global-edges.mjs —— 全景关系线消失问题的诊断脚本（只读）。
 *
 * 逐层核对：单 scope Scene 的边 → 全景聚合后的边 → 端点映射 → 前端可见性。
 * 用法：node scripts/diagnose-global-edges.mjs [--port 55915] [--url http://...]
 */

const CANDIDATE_PORTS = [55915, 51674, 63066, 62326, 65306, 61505, 58043, 59643, 51451]

function parseArgs(argv) {
  const args = { port: undefined, url: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port') args.port = Number(argv[i + 1])
    else if (argv[i] === '--url') args.url = argv[i + 1]
  }
  return args
}

async function resolveBaseUrl(args) {
  if (args.url) return args.url.replace(/\/+$/u, '')
  if (Number.isFinite(args.port) && args.port > 0) return `http://127.0.0.1:${args.port}`
  if (process.env.DSH_WEB_URL) return process.env.DSH_WEB_URL.replace(/\/+$/u, '')
  for (const port of CANDIDATE_PORTS) {
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/memory-sea/health`, {
        signal: AbortSignal.timeout(1200),
      })
      if (response.ok) return `http://127.0.0.1:${port}`
    } catch {
      /* 换下一个候选端口 */
    }
  }
  return null
}

async function getJson(baseUrl, path) {
  const response = await globalThis.fetch(baseUrl + path, { signal: AbortSignal.timeout(8000) })
  return { status: response.status, body: await response.json().catch(() => null) }
}

function countKinds(edges) {
  const kinds = {}
  for (const edge of edges) kinds[edge.kind] = (kinds[edge.kind] ?? 0) + 1
  return kinds
}

const args = parseArgs(process.argv.slice(2))
const baseUrl = await resolveBaseUrl(args)
if (!baseUrl) {
  console.error('找不到宿主。用 --port 或 --url 指定。')
  process.exit(1)
}
console.log(`宿主：${baseUrl}\n`)

const scopesResult = await getJson(baseUrl, '/api/memory-sea/scopes')
const scopes = Array.isArray(scopesResult.body?.scopes) ? scopesResult.body.scopes : []
console.log(`A. 单 scope Scene 真实数据（${scopes.length} 个 scope）`)
let singlePoints = 0
let singleEdges = 0
const singleKinds = {}
const perScope = []
for (const scope of scopes) {
  const scene = await getJson(baseUrl, `/api/memory-sea/scene?scope=${encodeURIComponent(scope.id)}`)
  const points = Array.isArray(scene.body?.points) ? scene.body.points : []
  const edges = Array.isArray(scene.body?.edges) ? scene.body.edges : []
  singlePoints += points.length
  singleEdges += edges.length
  for (const [kind, count] of Object.entries(countKinds(edges))) {
    singleKinds[kind] = (singleKinds[kind] ?? 0) + count
  }
  perScope.push({ scopeId: scope.id, points: points.length, edges: edges.length, kinds: countKinds(edges) })
}
for (const item of perScope) {
  const kinds = Object.entries(item.kinds).map(([kind, count]) => `${kind}:${count}`).join(' ')
  console.log(`  · ${item.scopeId}  points=${item.points}  edges=${item.edges}  [${kinds}]`)
}
console.log(`  合计 points=${singlePoints}  edges=${singleEdges}`)
console.log(`  各 kind 合计 ${JSON.stringify(singleKinds)}\n`)

const globalResult = await getJson(baseUrl, '/api/memory-sea/global-scene')
const global = globalResult.body ?? {}
const gPoints = Array.isArray(global.points) ? global.points : []
const gEdges = Array.isArray(global.edges) ? global.edges : []
console.log('B. 全景聚合结果')
console.log(`  status=${globalResult.status}  ok=${global.ok}  complete=${global.complete}`)
console.log(`  points=${gPoints.length}  edges=${gEdges.length}`)
console.log(`  stats=${JSON.stringify(global.stats)}`)
console.log(`  各 kind ${JSON.stringify(countKinds(gEdges))}\n`)

const byId = new Map(gPoints.map((point) => [point.id, point]))
let missingA = 0
let missingB = 0
let crossScope = 0
let noReason = 0
const missingSamples = []
for (const edge of gEdges) {
  const a = byId.get(edge.a)
  const b = byId.get(edge.b)
  if (!a) missingA += 1
  if (!b) missingB += 1
  if (a && b && a.scopeId !== b.scopeId) crossScope += 1
  if (typeof edge.reason !== 'string' || edge.reason.length === 0) noReason += 1
  if ((!a || !b) && missingSamples.length < 3) missingSamples.push(edge)
}
console.log('C. 端点映射校验')
console.log(`  端点 a 缺失：${missingA}`)
console.log(`  端点 b 缺失：${missingB}`)
console.log(`  跨 scope 边：${crossScope}`)
console.log(`  缺少 reason 的边：${noReason}`)
console.log(`  匹配到两端的边：${gEdges.length - Math.max(missingA, missingB)} / ${gEdges.length}\n`)

const relationEdges = gEdges.filter((edge) => edge.kind !== 'contains')
console.log('D. 聚合去重（只允许合并重复的真实边）')
console.log(`  单 scope 边合计 ${singleEdges} → 全景 ${gEdges.length}，合并重复边 ${singleEdges - gEdges.length} 条`)
console.log(`  各 kind 差额 ${JSON.stringify(Object.fromEntries(Object.keys(singleKinds).map((kind) => [kind, (singleKinds[kind] ?? 0) - (countKinds(gEdges)[kind] ?? 0)])))}
`)

console.log('E. 关系统计口径')
console.log(`  contains 归属边：${gEdges.length - relationEdges.length}`)
console.log(`  真实语义/证据关系边：${relationEdges.length}`)
console.log(`  各关系 kind ${JSON.stringify(countKinds(relationEdges))}`)
console.log(`  stats.relations=${global.stats?.relations}  应等于真实关系边数\n`)

const dedupeConsistent = gEdges.length <= singleEdges
const statsConsistent = global.stats?.relations === relationEdges.length
const statsLooksLegacy = Number(global.stats?.relations) === (countKinds(gEdges).continues ?? 0)
if (!statsConsistent && statsLooksLegacy) {
  console.log('  提示：宿主仍是旧构建（stats.relations 只统计连续性关系）；重启后应为真实关系边数 ' + relationEdges.length)
}
const ok = missingA === 0 && missingB === 0 && crossScope === 0 && noReason === 0 && gEdges.length > 0 && dedupeConsistent && (statsConsistent || statsLooksLegacy)
console.log(ok ? 'DIAGNOSE GLOBAL EDGES OK' : 'DIAGNOSE GLOBAL EDGES FAILED')
if (missingSamples.length) console.log('缺失端点样例：', JSON.stringify(missingSamples, null, 2))
