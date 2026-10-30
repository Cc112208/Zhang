#!/usr/bin/env node
/**
 * verify-stage6.mjs —— Stage 6 3D 页面的真实宿主验收（只读）。
 *
 * 用法：
 *   node scripts/verify-stage6.mjs --port 61505
 *   DSH_WEB_URL=http://127.0.0.1:61505 node scripts/verify-stage6.mjs
 *
 * 宿主端口会随重启变化，因此脚本不写死端口：
 *   1) --url / DSH_WEB_URL；2) --port；3) 历史上出现过的端口候选（逐个探测 /api/memory-sea/health）。
 *
 * 检查项（全部只读，不写任何数据）：
 *   A. 页面：200 + text/html + 自包含（无外链、无写请求、有 canvas）
 *   B. Scene：200 + 节点/边合法 + 每条边都有 reason
 *   C. Scope：?scope= 只含该 scope；未知 scope 404
 *   D. 详情：Experience / Episode（成员预览 + 证据 + 连续性）
 *   E. 一致性：status?scope 与 scene 计数一致
 *   F. 只读：页面与已注册只读路由中不存在执行入口
 */

import { setTimeout as sleep } from 'node:timers/promises'

const CANDIDATE_PORTS = [61505, 58043, 59817, 51451, 63211, 50001]

function parseArgs(argv) {
  const args = { port: undefined, url: undefined, timeoutMs: 6000 }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--port') args.port = Number(argv[index + 1])
    else if (token === '--url') args.url = argv[index + 1]
    else if (token === '--timeout') args.timeoutMs = Number(argv[index + 1])
  }
  return args
}

async function fetchJson(baseUrl, path, timeoutMs) {
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body }
}

async function fetchText(baseUrl, path, timeoutMs) {
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
  return { status: response.status, headers: response.headers, text: await response.text() }
}

async function resolveBaseUrl(args) {
  if (args.url) return args.url.replace(/\/+$/u, '')
  if (Number.isFinite(args.port) && args.port > 0) return `http://127.0.0.1:${args.port}`
  if (process.env.DSH_WEB_URL) return process.env.DSH_WEB_URL.replace(/\/+$/u, '')
  if (process.env.DSH_PORT) return `http://127.0.0.1:${process.env.DSH_PORT}`

  for (const port of CANDIDATE_PORTS) {
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/api/memory-sea/health`, {
        signal: AbortSignal.timeout(800),
      })
      if (probe.ok) return `http://127.0.0.1:${port}`
    } catch {
      /* 端口未监听：继续试下一个 */
    }
  }
  return null
}

const failures = []
const notes = []

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(name)
  }
}

function validPoints(points) {
  const known = new Set(['experience', 'episode', 'memory', 'pattern'])
  const seen = new Set()
  for (const point of points) {
    if (!point || typeof point.id !== 'string' || seen.has(point.id)) return `重复或缺失 id：${JSON.stringify(point?.id)}`
    seen.add(point.id)
    if (!known.has(point.type)) return `未知类型：${point.type}`
    if (typeof point.label !== 'string' || point.label.trim().length === 0) return `节点 ${point.id} 缺少 label`
    for (const axis of ['x', 'y', 'z']) {
      if (!Number.isFinite(point[axis])) return `节点 ${point.id} 的 ${axis} 不是有限数`
    }
  }
  return null
}

function validEdges(points, edges) {
  const ids = new Set(points.map((point) => point.id))
  for (const edge of edges) {
    if (!ids.has(edge.a)) return `边引用不存在的节点 a=${edge.a}`
    if (!ids.has(edge.b)) return `边引用不存在的节点 b=${edge.b}`
    if (typeof edge.reason !== 'string' || edge.reason.trim().length === 0) return `边 ${edge.a}→${edge.b} 缺少 reason`
  }
  return null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const baseUrl = await resolveBaseUrl(args)
  if (!baseUrl) {
    console.error('找不到宿主 Web 服务：请传 --port <端口> 或 --url <http://127.0.0.1:端口>。')
    process.exit(2)
  }
  console.log(`Memory Sea Stage 6 验收目标：${baseUrl}`)

  const page = await fetchText(baseUrl, '/memory-sea/scene', args.timeoutMs)
  console.log('\nA. 页面')
  check('GET /memory-sea/scene 200', page.status === 200, `status=${page.status}`)
  check('content-type 是 HTML', /text\/html/u.test(page.headers.get('content-type') ?? ''), page.headers.get('content-type') ?? '')
  check('页面自包含（无 http(s) 外链）', !/https?:\/\//u.test(page.text), `${page.text.length} 字节`)
  check('页面有 3D 画布', page.text.includes('<canvas id="sea"'))
  check('页面使用同源相对 API', page.text.includes('/api/memory-sea'))
  check('页面不含写请求', !/method:\s*['"](POST|PUT|DELETE)['"]/iu.test(page.text))
  check('页面不含 Skill 执行入口', !/execute_skill|run_skill|autoToolCall/u.test(page.text))

  const fallback = await fetchText(baseUrl, '/api/memory-sea/ui', args.timeoutMs)
  check('回退入口 /api/memory-sea/ui 可用', fallback.status === 200, `status=${fallback.status}`)

  const scopesResponse = await fetchJson(baseUrl, '/api/memory-sea/scopes', args.timeoutMs)
  const scopes = Array.isArray(scopesResponse.body?.scopes) ? scopesResponse.body.scopes : []
  notes.push(`发现 ${scopes.length} 个 scope`)

  const defaultScene = await fetchJson(baseUrl, '/api/memory-sea/scene', args.timeoutMs)
  console.log('\nB. Scene 契约')
  check('GET /api/memory-sea/scene 200', defaultScene.status === 200, `status=${defaultScene.status}`)
  const scene = defaultScene.body ?? {}
  if (!scene || typeof scene.scopeId !== 'string') {
    console.log('\n⚠ 检测到旧实例在响应 exact 路由：/api/memory-sea/scene 没有 scopeId（Stage 6 新字段）。')
    console.log('  宿主热重载不会 dispose 旧插件实例，/scene、/status 等 exact 路由可能仍由旧实例先匹配；')
    console.log('  请完整退出并重启 DeepSeek，再重跑本脚本完成 C/D 段（scope 隔离与 Episode 详情）验收。')
  }
  const points = Array.isArray(scene.points) ? scene.points : []
  const edges = Array.isArray(scene.edges) ? scene.edges : []
  const pointProblem = validPoints(points)
  const edgeProblem = validEdges(points, edges)
  check('节点结构合法', pointProblem === null, pointProblem ?? `${points.length} 个节点`)
  check('边结构合法且都有 reason', edgeProblem === null, edgeProblem ?? `${edges.length} 条边`)
  check('Scene 带 scopeId', typeof scene.scopeId === 'string', scene.scopeId ?? '(缺失)')

  const counts = { experience: 0, episode: 0, memory: 0, pattern: 0 }
  for (const point of points) counts[point.type] = (counts[point.type] ?? 0) + 1
  const stats = scene.stats ?? {}
  check(
    'counts 与 stats 一致',
    counts.experience === stats.experiences && counts.episode === stats.episodes && counts.memory === stats.memories && counts.pattern === stats.patterns,
    `points=${JSON.stringify(counts)} stats=${JSON.stringify({ experiences: stats.experiences, episodes: stats.episodes, memories: stats.memories, patterns: stats.patterns })}`,
  )
  check('Memory=0 时如实返回（不伪造）', stats.memories === 0 ? counts.memory === 0 : counts.memory === stats.memories, `memories=${stats.memories}`)

  const edgeKinds = {}
  for (const edge of edges) edgeKinds[edge.kind] = (edgeKinds[edge.kind] ?? 0) + 1
  notes.push(`边类型分布：${JSON.stringify(edgeKinds)}`)

  console.log('\nC. Scope 隔离')
  const scopeId = scene.scopeId
  if (scopeId) {
    const scoped = await fetchJson(baseUrl, `/api/memory-sea/scene?scope=${encodeURIComponent(scopeId)}`, args.timeoutMs)
    const scopedPoints = Array.isArray(scoped.body?.points) ? scoped.body.points : []
    const allowed = new Set(scopedPoints.map((point) => point.id))
    check('已知 scope 200', scoped.status === 200, `status=${scoped.status}`)
    check(
      '只返回该 scope 的节点',
      scopedPoints.every((point) => allowed.has(point.id)) && scoped.body?.scopeId === scopeId,
      `${scopedPoints.length} 个节点`,
    )
    const unknown = await fetchJson(baseUrl, '/api/memory-sea/scene?scope=project_0000000000000000', args.timeoutMs)
    check('未知 scope 返回 404', unknown.status === 404, `status=${unknown.status} error=${unknown.body?.error ?? ''}`)
  } else {
    check('已知 scope 200', false, 'scene 没有 scopeId，无法验证 scope 隔离')
  }

  console.log('\nD. 节点详情')
  const experiencePoint = points.find((point) => point.type === 'experience')
  if (experiencePoint) {
    const detail = await fetchJson(baseUrl, `/api/memory-sea/experiences/${experiencePoint.id}?scope=${scopeId ?? ''}`, args.timeoutMs)
    const body = detail.body ?? {}
    check('Experience 详情 200', detail.status === 200, `status=${detail.status}`)
    check('Experience 详情带正文', typeof body.experience?.content === 'string' && body.experience.content.length > 0)
    check('Experience 详情带所属 Episode', typeof body.episode?.id === 'string', body.episode?.id ?? '(孤立经历)')
    const crossScope = await fetchJson(
      baseUrl,
      `/api/memory-sea/experiences/${experiencePoint.id}?scope=project_0000000000000000`,
      args.timeoutMs,
    )
    check('跨 scope 读 Experience 返回 404', crossScope.status === 404, `status=${crossScope.status}`)
  } else {
    check('Experience 详情 200', false, '默认 scope 没有 Experience 节点')
  }

  const episodePoint = points.find((point) => point.type === 'episode')
  if (episodePoint) {
    const detail = await fetchJson(baseUrl, `/api/memory-sea/episodes/${episodePoint.id}?scope=${scopeId ?? ''}`, args.timeoutMs)
    const body = detail.body ?? {}
    check('Episode 详情 200', detail.status === 200, `status=${detail.status}`)
    check('Episode 详情带成员经历预览', Array.isArray(body.experiences) && body.experiences.length > 0, `${body.experiences?.length ?? 0} 条`)
    check(
      '成员预览不复制全文（<=240 字）',
      Array.isArray(body.experiences) && body.experiences.every((item) => typeof item.contentPreview === 'string' && item.contentPreview.length <= 240),
    )
    check('Episode 详情带连续性字段', Array.isArray(body.continuity?.previous) && Array.isArray(body.continuity?.next))
    check('Episode 详情带证据记忆数组', Array.isArray(body.memories), `${body.memories?.length ?? 0} 条`)
    const continuity = await fetchJson(baseUrl, `/api/memory-sea/episodes/${episodePoint.id}/continuity?scope=${scopeId ?? ''}`, args.timeoutMs)
    check('旧连续性路由仍可用', continuity.status === 200, `status=${continuity.status}`)
  } else {
    check('Episode 详情 200', false, '默认 scope 没有 Episode 节点')
  }

  console.log('\nE. status 与 scene 一致')
  if (scopeId) {
    const status = await fetchJson(baseUrl, `/api/memory-sea/status?scope=${encodeURIComponent(scopeId)}`, args.timeoutMs)
    const body = status.body ?? {}
    check('status?scope 200', status.status === 200, `status=${status.status}`)
    check('status.scope.id 与 scene 一致', body.scope?.id === scopeId, `${body.scope?.id ?? ''}`)
    check('experiences 计数一致', body.experiences === counts.experience, `status=${body.experiences} scene=${counts.experience}`)
    check('episodes 计数一致', body.episodes === counts.episode, `status=${body.episodes} scene=${counts.episode}`)
    check('memories 计数一致', (body.memories?.total ?? 0) === counts.memory, `status=${body.memories?.total} scene=${counts.memory}`)
  }

  console.log('\nF. 只读边界')
  const operator = await fetchJson(baseUrl, '/api/memory-sea/operator/candidates', args.timeoutMs)
  check('人工审核入口未认证时拒绝', operator.status === 401 || operator.status === 503, `status=${operator.status} code=${operator.body?.code ?? ''}`)
  const executeProbe = await fetchText(baseUrl, '/api/memory-sea/execute', args.timeoutMs)
  check(
    '不存在执行入口',
    executeProbe.status === 404 || executeProbe.status === 401,
    `status=${executeProbe.status}${executeProbe.status === 401 ? '（宿主对未注册 /api 路径的鉴权兜底）' : ''}`,
  )

  console.log('\n附注：')
  for (const note of notes) console.log(`  · ${note}`)

  if (failures.length > 0) {
    console.error(`\nVERIFY STAGE 6 FAIL —— ${failures.length} 项失败：${failures.join(' / ')}`)
    process.exit(1)
  }
  console.log('\nVERIFY STAGE 6 DONE')
  await sleep(0)
}

main().catch((error) => {
  console.error(`VERIFY STAGE 6 ERROR：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
