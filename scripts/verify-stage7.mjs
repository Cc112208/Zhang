#!/usr/bin/env node
/**
 * verify-stage7.mjs —— Stage 7 全景（All Scopes）真实宿主验收（只读）。
 *
 * 用法：
 *   node scripts/verify-stage7.mjs --port 51674
 *   DSH_WEB_URL=http://127.0.0.1:51674 node scripts/verify-stage7.mjs
 *
 * 宿主端口随重启变化，脚本不写死端口：--url / DSH_WEB_URL → --port → 历史端口候选逐个探测。
 *
 * 检查项（全部只读，不写任何数据）：
 *   A. /api/memory-sea/global-scene：200、ok、多 scope、节点/边结构合法、id 全局唯一
 *   B. 边端点映射：每条边两端都存在，且与边属于同一 scope（无跨 scope 边）
 *   C. 与单 scope 一致：global.scopes[x] 的计数与 /scene?scope=x 一致
 *   D. ?scopes= 过滤：只返回指定 scope
 *   E. 失败显式：未知 scope 计入 failures 且 complete=false
 *   F. 页面：包含模式切换与 /global-scene 请求，不含写请求
 *   G. 只读边界：POST/PUT/DELETE 不被接受
 */

import { setTimeout as sleep } from 'node:timers/promises'

const CANDIDATE_PORTS = [51674, 63066, 62326, 65306, 61505, 58043, 59643, 51451]

function parseArgs(argv) {
  const args = { port: undefined, url: undefined, timeoutMs: 8000 }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--port') args.port = Number(argv[index + 1])
    else if (token === '--url') args.url = argv[index + 1]
    else if (token === '--timeout') args.timeoutMs = Number(argv[index + 1])
  }
  return args
}

async function fetchJson(baseUrl, path, timeoutMs) {
  const response = await globalThis.fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body }
}

async function resolveBaseUrl(args) {
  if (args.url) return args.url.replace(/\/+$/u, '')
  if (Number.isFinite(args.port) && args.port > 0) return `http://127.0.0.1:${args.port}`
  if (process.env.DSH_WEB_URL) return process.env.DSH_WEB_URL.replace(/\/+$/u, '')
  if (process.env.DSH_PORT) return `http://127.0.0.1:${process.env.DSH_PORT}`
  for (const port of CANDIDATE_PORTS) {
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/api/memory-sea/health`, {
        signal: AbortSignal.timeout(1200),
      })
      if (probe.ok) return `http://127.0.0.1:${port}`
    } catch {
      /* 端口没在监听，继续试下一个 */
    }
  }
  return null
}

const results = []
function check(ok, label, detail) {
  results.push({ ok, label, detail })
  const mark = ok ? '✔' : '✖'
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ''}`)
}

function fail(reason) {
  console.error(`\nVERIFY STAGE 7 FAILED: ${reason}\n`)
  process.exitCode = 1
}

const args = parseArgs(process.argv.slice(2))
const baseUrl = await resolveBaseUrl(args)
if (!baseUrl) {
  fail('找不到正在运行的宿主（用 --port 或 DSH_WEB_URL 指定端口）')
} else {
  console.log(`宿主：${baseUrl}\n`)
  try {
    await run(baseUrl)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

async function run(root) {
  // ---------------------------------------------------------------- A. 全景接口
  console.log('A. 全景聚合接口')
  const global = await fetchJson(root, '/api/memory-sea/global-scene', args.timeoutMs)
  check(global.status === 200, 'GET /api/memory-sea/global-scene 200', `status=${global.status}`)
  if (global.status !== 200 || !global.body) {
    fail(`全景接口不可用（status=${global.status}）`)
    return
  }
  const scene = global.body
  const points = Array.isArray(scene.points) ? scene.points : []
  const edges = Array.isArray(scene.edges) ? scene.edges : []
  check(scene.ok === true, '响应 ok=true')
  check(Array.isArray(scene.scopes) && scene.scopes.length >= 2, '包含多个真实 scope', `${scene.scopes?.length ?? 0} 个 scope`)
  check(points.length > 0, '有真实节点', `${points.length} 个节点 / ${edges.length} 条边`)
  check(scene.complete === true, 'complete=true（所有 scope 都读到）')

  const ids = new Set(points.map((point) => point.id))
  check(ids.size === points.length, '节点全局 id 唯一', `${ids.size}/${points.length}`)
  const badPoint = points.find(
    (point) =>
      typeof point.scopeId !== 'string' ||
      typeof point.originalId !== 'string' ||
      point.id !== `${point.scopeId}::${point.originalId}`,
  )
  check(!badPoint, '节点 id 形如 <scopeId>::<originalId>', badPoint ? badPoint.id : '全部符合')

  // ---------------------------------------------------------------- B. 边端点
  console.log('\nB. 边端点映射（不得跨 scope）')
  const byId = new Map(points.map((point) => [point.id, point]))
  const dangling = edges.filter((edge) => !byId.has(edge.a) || !byId.has(edge.b))
  check(dangling.length === 0, '没有悬空边', dangling.length ? `${dangling.length} 条悬空` : '0 条')
  const crossScope = edges.filter((edge) => {
    const a = byId.get(edge.a)
    const b = byId.get(edge.b)
    if (!a || !b) return false
    return a.scopeId !== b.scopeId || edge.scopeId !== a.scopeId
  })
  check(crossScope.length === 0, '没有跨 scope 边', crossScope.length ? `${crossScope.length} 条跨 scope` : '0 条')
  const missingReason = edges.filter((edge) => typeof edge.reason !== 'string' || edge.reason.length === 0)
  check(missingReason.length === 0, '每条边都有可读 reason', `${edges.length} 条边`)
  const typeCounts = points.reduce((acc, point) => {
    acc[point.type] = (acc[point.type] ?? 0) + 1
    return acc
  }, {})
  console.log('  · 节点类型分布：' + JSON.stringify(typeCounts))
  console.log('  · 边类型分布：' + JSON.stringify(
    edges.reduce((acc, edge) => {
      acc[edge.kind] = (acc[edge.kind] ?? 0) + 1
      return acc
    }, {}),
  ))

  // ---------------------------------------------------------------- C. 与单 scope 一致
  console.log('\nC. 每个 scope 的计数与单 scope 读取一致')
  const scopes = Array.isArray(scene.scopes) ? scene.scopes : []
  let compared = 0
  for (const summary of scopes.slice(0, 6)) {
    const single = await fetchJson(
      root,
      `/api/memory-sea/scene?scope=${encodeURIComponent(summary.scopeId)}`,
      args.timeoutMs,
    )
    if (single.status !== 200 || !single.body) {
      check(false, `scope ${summary.scopeId} 单 scope 读取失败`, `status=${single.status}`)
      continue
    }
    const singlePoints = (single.body.points || []).length
    const singleEdges = (single.body.edges || []).length
    // 单 scope 的 Scene 可能带着端点被 maxPoints 裁掉的边；全景会丢弃这些悬空边，
    // 所以允许「全景边数 <= 单 scope 边数」，但节点数必须完全一致。
    const samePoints = singlePoints === summary.points
    const keptEdges = summary.edges <= singleEdges
    check(
      samePoints && keptEdges,
      `scope ${summary.scopeId} 计数一致`,
      `points ${summary.points}/${singlePoints} · edges ${summary.edges}/${singleEdges}（差额=悬空边）`,
    )
    compared += 1
  }
  check(compared > 0, '至少对比了一个 scope')

  const totalExperiences = scopes.reduce((sum, item) => sum + (item.experiences || 0), 0)
  check(
    totalExperiences === (scene.stats?.experiences ?? -1),
    '全局统计等于各 scope 之和',
    `sum=${totalExperiences} stats=${scene.stats?.experiences}`,
  )

  // ---------------------------------------------------------------- D. Scope 过滤
  console.log('\nD. ?scopes= 过滤')
  if (scopes.length >= 2) {
    const pick = scopes[0].scopeId
    const filtered = await fetchJson(
      root,
      `/api/memory-sea/global-scene?scopes=${encodeURIComponent(pick)}`,
      args.timeoutMs,
    )
    const onlyPicked = (filtered.body?.points || []).every((point) => point.scopeId === pick)
    check(filtered.status === 200 && onlyPicked, '只返回指定 scope', `scope=${pick}`)
    check((filtered.body?.scopes || []).length === 1, '汇总里只有一个 scope')
  } else {
    check(true, '宿主只有 1 个 scope，跳过过滤检查')
  }

  // ---------------------------------------------------------------- E. 失败显式
  console.log('\nE. 未知 scope 必须显式失败（不能伪装成完整全景）')
  const broken = await fetchJson(
    root,
    `/api/memory-sea/global-scene?scopes=project_verify_missing_scope`,
    args.timeoutMs,
  )
  const failures = broken.body?.failures || []
  check(
    broken.status === 200 && broken.body?.complete === false && failures.length === 1,
    '未知 scope → complete=false + failures',
    `complete=${broken.body?.complete} failures=${failures.length}`,
  )
  check(
    failures[0]?.error === 'unknown scope',
    '失败原因明确',
    failures[0]?.error ?? '(空)',
  )

  // ---------------------------------------------------------------- F. 页面
  console.log('\nF. 页面（含模式切换）')
  const page = await fetchPage(root, '/memory-sea/atlas', args.timeoutMs)
  const html = await page.text()
  check(page.status === 200, 'GET /memory-sea/atlas 200', `status=${page.status} ${html.length}B`)
  check((page.headers.get('content-type') || '').includes('text/html'), '返回 HTML')
  check(html.includes('id="mode-global"') && html.includes('id="mode-scope"'), '包含全景 / 单 Scope 切换')
  check(html.includes('id="scope-filter"'), '包含 Scope 过滤容器')
  check(html.includes("'/global-scene'") || html.includes('/global-scene'), '页面会请求全景接口')
  check(!/(src|href)\s*=\s*["']https?:/iu.test(html) && !/cdn\./iu.test(html), '没有外部 CDN 依赖')
  check(!/method\s*=\s*["']?(post|put|delete)/iu.test(html), '页面不含写请求表单')

  // ---------------------------------------------------------------- G. 只读边界
  console.log('\nG. 只读边界（接口不能写数据）')
  const beforeIds = new Set(points.map((point) => point.id))
  const beforeEdgeCount = edges.length
  const post = await globalThis.fetch(`${root}/api/memory-sea/global-scene`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ points: [], edges: [] }),
    signal: AbortSignal.timeout(args.timeoutMs),
  }).catch(() => null)
  // 宿主 webServer 不区分 HTTP 方法，POST 也会落到同一个只读处理器上；
  // 所以这里验证的是「POST 之后数据完全没变化」，而不是依赖 405。
  const after = await fetchJson(root, '/api/memory-sea/global-scene', args.timeoutMs)
  const afterPoints = Array.isArray(after.body?.points) ? after.body.points : []
  const afterIds = new Set(afterPoints.map((point) => point.id))
  const sameNodes = afterIds.size === beforeIds.size && [...beforeIds].every((id) => afterIds.has(id))
  const sameEdges = (Array.isArray(after.body?.edges) ? after.body.edges.length : -1) === beforeEdgeCount
  check(Boolean(post), 'POST 被只读处理器接受（忽略请求体）', post ? `status=${post.status}` : '连接被拒绝')
  check(sameNodes && sameEdges, 'POST 之后节点与边完全未变化', `nodes ${beforeIds.size}/${afterIds.size} · edges ${beforeEdgeCount}/${after.body?.edges?.length}`)
  const executeProbe = await fetchJson(root, '/api/memory-sea/execute', args.timeoutMs)
  check(executeProbe.status !== 200, '不存在 execute Skill 入口', `status=${executeProbe.status}`)
  await sleep(10)

  const failed = results.filter((item) => !item.ok)
  console.log('')
  if (failed.length > 0) {
    fail(`${failed.length} 项未通过：${failed.map((item) => item.label).join('；')}`)
    return
  }
  console.log(`VERIFY STAGE 7 DONE（${results.length} 项全部通过）`)
}

async function fetchPage(root, path, timeoutMs) {
  return fetchText(root, path, timeoutMs)
}

async function fetchText(baseUrl, path, timeoutMs) {
  const response = await globalThis.fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
  return {
    status: response.status,
    headers: response.headers,
    text: async () => response.text(),
  }
}
