/**
 * index.ts —— DSH/Cordis 插件入口（spec §2）。
 *
 * 暴露：
 *   - Service：ctx.provide('memorySea', service) → 其他插件可 ctx.inject(['memorySea'])
 *   - 工具：memory_remember / memory_recall / memory_inspect
 *   - 自动捕获：监听 'session/event'，把 user / assistant / tool 结果变成 Experience
 *   - 只读 HTTP 路由（如果宿主有 webServer）：/api/memory-sea/{scene,legacy-scene,status}
 *
 * 错误策略（spec §21）：任何初始化 / 捕获失败都只降级或记日志，绝不抛出到宿主。
 */

import { resolveConfig } from './config.js'
import { MemorySeaService } from './service.js'
import type { MemoryKind, MemoryStatus, PatternKind, PatternStatus } from './types.js'
import type { SkillCandidateKind, SkillCandidateStatus } from './types.js'
import type { ProcedureDraft } from './types.js'
import { OperatorAuth } from './operator/operator-auth.js'
import { MessageCapture } from './capture/message-capture.js'
import { createRememberTool } from './tools/remember.js'
import { createRecallTool } from './tools/recall.js'
import { createInspectMemoryTool } from './tools/inspect-memory.js'
import { createSkillInspectTool, createSkillStatusTool } from './tools/skill-status.js'
import { errorMessage } from './errors.js'
import { renderScenePage } from './web/scene-page.js'

export const name = 'dsh-3d-memory-sea'
// webServer 是必需注入：宿主（DSH Web）里它一定存在；声明后 ctx.webServer 才可用。
// 之前只声明 ['tools'] 并用 ctx.get('webServer') 取，在新宿主上拿到 undefined，
// 导致所有 /api/memory-sea/* 只读路由静默缺失（宿主的兜底 401 unauthorized）。
export const inject = ['tools', 'webServer']

export interface PluginLogger {
  info?(message: string): void
  warn?(message: string): void
  error?(message: string, error?: unknown): void
}

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: unknown, res: HttpResponseLike) => void
  }): unknown
}

interface HttpRequestLike {
  url?: string
}

interface HttpResponseLike {
  writeHead?(status: number, headers?: Record<string, string>): unknown
  setHeader?(name: string, value: string): unknown
  end?(body?: string): unknown
}

interface PluginContextLike {
  tools?: { register(definition: unknown): () => void }
  on?(event: string, listener: (...args: unknown[]) => void): unknown
  provide?(serviceName: string, service: unknown): unknown
  effect?(callback: () => () => void, label?: string): unknown
  get?(serviceName: string): unknown
  webServer?: WebServerLike
  logger?: PluginLogger
}

const TOOL_NAME_PREFIX = 'memory_'
const MAX_TRACKED_TOOL_CALLS = 512

export function apply(ctx: PluginContextLike, rawConfig: unknown): (() => void) | void {
  const config = resolveConfig(rawConfig, process.env)
  const logger = ctx.logger ?? console
  if (!config.enabled) {
    logger.info?.('[memory-sea] 插件已禁用（config.enabled = false）')
    return
  }

  let service: MemorySeaService
  try {
    service = new MemorySeaService({
      config,
      logger: {
        info: (message) => logger.info?.(message),
        warn: (message) => logger.warn?.(message),
        error: (message, error) => logger.error?.(message, error),
      },
    })
  } catch (error) {
    // Memory Sea 挂掉 ≠ DeepSeek 挂掉：只降级，不注册任何东西。
    logger.error?.(`[memory-sea] 初始化失败，插件降级禁用：${errorMessage(error)}`, error)
    return
  }

  const disposers: (() => void)[] = []

  try {
    ctx.provide?.('memorySea', service)
  } catch (error) {
    logger.warn?.(`[memory-sea] 注册 ctx.memorySea 失败：${errorMessage(error)}`)
  }

  for (const createTool of [
    createRememberTool,
    createRecallTool,
    createInspectMemoryTool,
    createSkillStatusTool,
    createSkillInspectTool,
  ]) {
    try {
      if (!ctx.tools) throw new Error('宿主没有提供 tools 服务')
      disposers.push(ctx.tools.register(createTool(service)))
    } catch (error) {
      logger.warn?.(`[memory-sea] 注册工具失败：${errorMessage(error)}`)
    }
  }

  const autoCapture = new AutoCapture(service, config, logger)
  try {
    ctx.on?.('session/event', (session, event) => autoCapture.handle(session, event))
  } catch (error) {
    logger.warn?.(`[memory-sea] 注册自动捕获失败：${errorMessage(error)}`)
  }

  // Phase 2B：人工审核入口的本地操作者认证（失败关闭，写入不静默放行）。
  const operatorAuth = new OperatorAuth({ ...config.operator })
  try {
    operatorAuth.ensure()
  } catch (error) {
    logger.warn?.(`[memory-sea] 操作者认证初始化失败，人工审核入口不可用：${errorMessage(error)}`)
  }
  disposers.push(...registerOperatorRoutes(ctx, service, logger, operatorAuth))
  disposers.push(...registerSceneRoutes(ctx, service, logger))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 清理失败不影响宿主退出 */
      }
    }
    // 优雅关闭；宿主 dispose 不等待 Promise，但内部会先停定时器再关库。
    void service.close()
  }
}

/**
 * 自动捕获：把 Session 事件流变成 Experience。
 *
 * 两个细节：
 *   1. 记忆工具自身的结果不回灌（否则 memory_remember 会产生一条重复 Experience，形成自我循环）；
 *   2. 全程 try/catch —— 监听器抛错虽然会被宿主吞掉，但会把错误信息丢掉，这里自己记日志。
 */
class AutoCapture {
  private readonly capture: MessageCapture
  private readonly service: MemorySeaService
  private readonly logger: PluginLogger
  private readonly enabled: boolean
  private readonly toolNames = new Map<string, string>()

  constructor(service: MemorySeaService, config: ReturnType<typeof resolveConfig>, logger: PluginLogger) {
    this.service = service
    this.logger = logger
    this.enabled = config.capture.enabled
    this.capture = new MessageCapture({ config })
  }

  handle(rawSession: unknown, rawEvent: unknown): void {
    if (!this.enabled) return
    try {
      if (!rawEvent || typeof rawEvent !== 'object') return
      const event = rawEvent as { type?: string; time?: number; seq?: number; data?: Record<string, unknown> }
      if (event.type === 'tool/call') {
        this.rememberToolCall(event.data)
        return
      }
      if (event.type === 'tool/result' && this.isMemoryToolResult(event.data)) return

      const sessionId = this.sessionIdOf(rawSession)
      // 每次事件都从 session 的 cwd 重新解析 scope：解析器自己做了 sessionId→scope 缓存，
      // 这里多调一次是廉价的，换来的是「会话迁到别的项目目录」也能立刻切对 scope。
      const scope = this.service.resolveScopeForSession(rawSession)
      this.service.rememberSessionScope(sessionId, scope)

      // 会话结束：立刻关闭该会话的 open Episode，不等空闲超时（否则最后一段永远 open）。
      if (event.type === 'session/end-seed') {
        this.service.closeSession(sessionId, scope)
        return
      }

      const inputs = this.capture.fromSessionEvent({ id: sessionId }, event as never)
      for (const input of inputs) {
        try {
          this.service.capture(input, { scopeId: scope.id })
        } catch (error) {
          this.logger.warn?.(`[memory-sea] 自动捕获失败（${event.type}）：${errorMessage(error)}`)
        }
      }
    } catch (error) {
      this.logger.warn?.(`[memory-sea] session/event 处理失败：${errorMessage(error)}`)
    }
  }

  private rememberToolCall(data: Record<string, unknown> | undefined): void {
    const callId = typeof data?.callId === 'string' ? data.callId : undefined
    const toolName = typeof data?.name === 'string' ? data.name : undefined
    if (!callId || !toolName) return
    this.toolNames.set(callId, toolName)
    if (this.toolNames.size > MAX_TRACKED_TOOL_CALLS) {
      const oldest = this.toolNames.keys().next().value
      if (typeof oldest === 'string') this.toolNames.delete(oldest)
    }
  }

  private isMemoryToolResult(data: Record<string, unknown> | undefined): boolean {
    const message = data?.message as { toolCallId?: string } | undefined
    const callId = typeof message?.toolCallId === 'string' ? message.toolCallId : undefined
    if (!callId) return false
    const toolName = this.toolNames.get(callId)
    return typeof toolName === 'string' && toolName.startsWith(TOOL_NAME_PREFIX)
  }

  private sessionIdOf(rawSession: unknown): string {
    const id = (rawSession as { id?: unknown } | null)?.id
    return typeof id === 'string' && id.length > 0 ? id : 'unknown-session'
  }
}

function registerSceneRoutes(ctx: PluginContextLike, service: MemorySeaService, logger: PluginLogger): (() => void)[] {
  const disposers: (() => void)[] = []
  let webServer: WebServerLike | undefined
  // 优先用注入的 ctx.webServer（inject 里已声明 webServer）；老宿主再退回 ctx.get。
  const injected = ctx.webServer
  if (injected && typeof injected.register === 'function') {
    webServer = injected
  } else {
    try {
      const candidate = ctx.get?.('webServer')
      if (candidate && typeof (candidate as WebServerLike).register === 'function') {
        webServer = candidate as WebServerLike
      }
    } catch {
      webServer = undefined
    }
  }
  if (!webServer) {
    logger.warn?.('[memory-sea] 未拿到 webServer，只读调试路由不可用（不影响工具与自动捕获）')
    return disposers
  }

  // Scene / 状态类只读接口：支持 ?scope=<id>（Stage 6 页面需要按 scope 取数）。
  // 未传 scope 时沿用默认 scope；传了未知 scope 一律 404，绝不隐式回落（防误导与越权枚举）。
  const routes: { path: string; build: (scopeId?: string) => unknown }[] = [
    { path: '/api/memory-sea/scene', build: (scopeId) => service.getScene(scopeId ? { scopeId } : {}) },
    { path: '/api/memory-sea/legacy-scene', build: (scopeId) => service.getLegacyScene(scopeId ? { scopeId } : {}) },
    { path: '/api/memory-sea/status', build: (scopeId) => service.status(scopeId ? { scopeId } : {}) },
    { path: '/api/memory-sea/scopes', build: () => ({ ok: true, scopes: service.knownScopes(), defaultScope: service.defaultScope }) },
    { path: '/api/memory-sea/health', build: (scopeId) => ({ ok: true, status: service.status(scopeId ? { scopeId } : {}) }) },
  ]
  // Stage 7：多 scope 全景（All Scopes）只读接口。
  // ?scopes=a,b 可显式限定；未知 scope 与读取异常都写进 failures，不做隐式回落。
  try {
    const globalRoute = webServer.register({
      kind: 'exact',
      path: '/api/memory-sea/global-scene',
      handler: (req, res) => {
        try {
          const method = (req as { method?: unknown } | undefined)?.method
          if (typeof method === 'string' && method.toUpperCase() !== 'GET') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const params = queryOf(req)
          const rawScopes = params.get('scopes')
          const scopeIds = typeof rawScopes === 'string'
            ? rawScopes
                .split(',')
                .map((value) => value.trim())
                .filter((value) => value.length > 0)
            : []
          const scene = service.getGlobalScene(scopeIds.length > 0 ? { scopeIds } : {})
          writeJson(res, 200, { ok: true, ...scene })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: errorMessage(error) })
        }
      },
    })
    if (typeof globalRoute === 'function') disposers.push(globalRoute as () => void)
  } catch (error) {
    logger.warn?.(`[memory-sea] global-scene 路由注册失败：${errorMessage(error)}`)
  }

  // 只读调试接口：/api/memory-sea/memories（列表）与 /api/memory-sea/memories/:id（详情 + 证据）。
  // 明确不提供任何写操作 HTTP（spec §62）。
  try {
    const memoryRoute = webServer.register({
      kind: 'prefix',
      path: '/api/memory-sea/memories',
      handler: (req, res) => {
        try {
          const rawUrl = (req as HttpRequestLike | undefined)?.url
          const url: string = typeof rawUrl === 'string' ? rawUrl : ''
          const queryIndex = url.indexOf('?')
          const path: string = queryIndex >= 0 ? url.slice(0, queryIndex) : url
          const params = new URLSearchParams(queryIndex >= 0 ? url.slice(queryIndex + 1) : '')
          const rest = path.slice('/api/memory-sea/memories'.length).replace(/^\/+/, '')

          if (rest.length === 0) {
            const limitRaw = Number(params.get('limit'))
            const scopeId = params.get('scope')
            const status = params.get('status')
            const kind = params.get('kind')
            const memories = service.listMemories(
              {
                ...(status ? { status: status as MemoryStatus } : {}),
                ...(kind ? { kind: kind as MemoryKind } : {}),
                ...(params.get('includeSuperseded') === 'true' ? { includeSuperseded: true } : {}),
                ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: Math.min(200, Math.trunc(limitRaw)) } : {}),
              },
              scopeId ? { scopeId } : {},
            )
            writeJson(res, 200, { ok: true, memories })
            return
          }

          const memory = service.getMemory(decodeURIComponent(rest))
          if (!memory) {
            writeJson(res, 404, { ok: false, error: 'memory not found' })
            return
          }
          const requestedScope = params.get('scope')
          if (requestedScope && memory.scopeId !== requestedScope) {
            writeJson(res, 404, { ok: false, error: 'memory not found in scope' })
            return
          }
          writeJson(res, 200, { ok: true, memory, evidence: service.listMemoryEvidence(memory.id) })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: errorMessage(error) })
        }
      },
    })
    if (typeof memoryRoute === 'function') disposers.push(memoryRoute as () => void)
  } catch (error) {
    logger.warn?.(`[memory-sea] memories 路由注册失败：${errorMessage(error)}`)
  }

  // 只读调试接口：/api/memory-sea/patterns 与 /api/memory-sea/patterns/:id（详情 + 支持/冲突记忆）。
  try {
    const patternRoute = webServer.register({
      kind: 'prefix',
      path: '/api/memory-sea/patterns',
      handler: (req, res) => {
        try {
          const rawUrl = (req as HttpRequestLike | undefined)?.url
          const url: string = typeof rawUrl === 'string' ? rawUrl : ''
          const queryIndex = url.indexOf('?')
          const path: string = queryIndex >= 0 ? url.slice(0, queryIndex) : url
          const params = new URLSearchParams(queryIndex >= 0 ? url.slice(queryIndex + 1) : '')
          const rest = path.slice('/api/memory-sea/patterns'.length).replace(/^\/+/, '')

          if (rest.length === 0) {
            const limitRaw = Number(params.get('limit'))
            const scopeId = params.get('scope')
            const status = params.get('status')
            const kind = params.get('kind')
            const patterns = service.listPatterns(
              {
                ...(status ? { status: status as PatternStatus } : {}),
                ...(kind ? { kind: kind as PatternKind } : {}),
                ...(params.get('includeSuperseded') === 'true' ? { includeSuperseded: true } : {}),
                ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: Math.min(200, Math.trunc(limitRaw)) } : {}),
              },
              scopeId ? { scopeId } : {},
            )
            writeJson(res, 200, { ok: true, patterns })
            return
          }

          const pattern = service.getPattern(decodeURIComponent(rest))
          if (!pattern) {
            writeJson(res, 404, { ok: false, error: 'pattern not found' })
            return
          }
          const requestedScope = params.get('scope')
          if (requestedScope && pattern.scopeId !== requestedScope) {
            writeJson(res, 404, { ok: false, error: 'pattern not found in scope' })
            return
          }
          writeJson(res, 200, { ok: true, pattern, evidence: service.listPatternEvidence(pattern.id) })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: errorMessage(error) })
        }
      },
    })
    if (typeof patternRoute === 'function') disposers.push(patternRoute as () => void)
  } catch (error) {
    logger.warn?.(`[memory-sea] patterns 路由注册失败：${errorMessage(error)}`)
  }

  // Stage 4.6 只读调试接口：摘要质量分布与身份审计（只统计、不推断，无写操作）。
  try {
    const qualityRoute = webServer.register({
      kind: 'prefix',
      path: '/api/memory-sea/summary-quality',
      handler: (req, res) => {
        try {
          const params = queryOf(req)
          const scopeId = params.get('scope') ?? service.defaultScope.id
          const limitRaw = Number(params.get('limit'))
          const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.trunc(limitRaw)) : 50
          writeJson(res, 200, { ok: true, ...service.listSummaryQuality(scopeId, { limit }) })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: errorMessage(error) })
        }
      },
    })
    if (typeof qualityRoute === 'function') disposers.push(qualityRoute as () => void)
  } catch (error) {
    logger.warn?.(`[memory-sea] summary-quality 路由注册失败：${errorMessage(error)}`)
  }

  try {
    const actorRoute = webServer.register({
      kind: 'prefix',
      path: '/api/memory-sea/actor-identity',
      handler: (req, res) => {
        try {
          const params = queryOf(req)
          const scopeId = params.get('scope') ?? service.defaultScope.id
          const limitRaw = Number(params.get('limit'))
          const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, Math.trunc(limitRaw)) : 200
          writeJson(res, 200, { ok: true, scopeId, audit: service.auditActorIdentity(scopeId, { limit }) })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: errorMessage(error) })
        }
      },
    })
    if (typeof actorRoute === 'function') disposers.push(actorRoute as () => void)
  } catch (error) {
    logger.warn?.(`[memory-sea] actor-identity 路由注册失败：${errorMessage(error)}`)
  }

  // 只读调试接口：/api/memory-sea/skill-candidates 与 /skill-candidates/:id（详情 + 版本 + 尝试 + 审核 + 成熟度）。
  // 明确不提供任何写操作 HTTP：候选生成走后台 job，审核只能通过受控 Service 入口（spec §Phase1）。
  try {
    const skillRoute = webServer.register({
      kind: "prefix",
      path: "/api/memory-sea/skill-candidates",
      handler: (req, res) => {
        try {
          const rawUrl = (req as HttpRequestLike | undefined)?.url
          const url: string = typeof rawUrl === "string" ? rawUrl : ""
          const queryIndex = url.indexOf("?")
          const path: string = queryIndex >= 0 ? url.slice(0, queryIndex) : url
          const params = new URLSearchParams(queryIndex >= 0 ? url.slice(queryIndex + 1) : "")
          const rest = path.slice("/api/memory-sea/skill-candidates".length).replace(/^\/+/, "")
          const scopeId = params.get("scope") ?? service.defaultScope.id

          if (rest.length === 0) {
            const limitRaw = Number(params.get("limit"))
            const candidates = service.listSkillCandidates(scopeId, {
              ...(params.get("status") ? { status: params.get("status") as string } : {}),
              ...(params.get("kind") ? { kind: params.get("kind") as string } : {}),
              ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: Math.min(200, Math.trunc(limitRaw)) } : {}),
            })
            writeJson(res, 200, { ok: true, scopeId, candidates })
            return
          }

          const candidateId = decodeURIComponent(rest)
          const candidate = service.getSkillCandidate(scopeId, candidateId)
          if (!candidate) {
            writeJson(res, 404, { ok: false, error: "skill candidate not found" })
            return
          }
          writeJson(res, 200, {
            ok: true,
            scopeId,
            candidate,
            maturity: service.getSkillMaturity(scopeId, candidate.id),
            versions: service.listSkillVersions(scopeId, candidate.id),
            attempts: service.listSkillAttempts(scopeId, { candidateId: candidate.id, limit: 50 }),
            reviews: service.listSkillReviews(scopeId, candidate.id),
          })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: errorMessage(error) })
        }
      },
    })
    if (typeof skillRoute === "function") disposers.push(skillRoute as () => void)
  } catch (error) {
    logger.warn?.(`[memory-sea] skill-candidates 路由注册失败：${errorMessage(error)}`)
  }

  // 只读调试接口：/api/memory-sea/skill-attempts/:id/evidence（尝试的全部结果证据）。
  try {
    const attemptRoute = webServer.register({
      kind: "prefix",
      path: "/api/memory-sea/skill-attempts",
      handler: (req, res) => {
        try {
          const rawUrl = (req as HttpRequestLike | undefined)?.url
          const url: string = typeof rawUrl === "string" ? rawUrl : ""
          const queryIndex = url.indexOf("?")
          const path: string = queryIndex >= 0 ? url.slice(0, queryIndex) : url
          const params = new URLSearchParams(queryIndex >= 0 ? url.slice(queryIndex + 1) : "")
          const rest = path.slice("/api/memory-sea/skill-attempts".length).replace(/^\/+/, "")
          const scopeId = params.get("scope") ?? service.defaultScope.id
          const attemptId = decodeURIComponent(rest.replace(/\/evidence$/, ""))
          if (attemptId.length === 0) {
            writeJson(res, 400, { ok: false, error: "attempt id required" })
            return
          }
          const evidence = service.listSkillOutcomes(scopeId, attemptId)
          writeJson(res, 200, { ok: true, scopeId, attemptId, evidence })
        } catch (error) {
          // 「找不到尝试」属于客户端问题（404），不是服务端故障（500）。
          const message = errorMessage(error)
          const status = message.includes('未找到') ? 404 : 500
          writeJson(res, status, { ok: false, error: message })
        }
      },
    })
    if (typeof attemptRoute === "function") disposers.push(attemptRoute as () => void)
  } catch (error) {
    logger.warn?.(`[memory-sea] skill-attempts 路由注册失败：${errorMessage(error)}`)
  }
  // Stage 6 只读接口：/api/memory-sea/experiences/:id（原始经历正文 + 所属 Episode）。
  try {
    const experienceRoute = webServer.register({
      kind: 'prefix',
      path: '/api/memory-sea/experiences',
      handler: (req, res) => {
        try {
          const params = queryOf(req)
          const rawUrl = (req as HttpRequestLike | undefined)?.url
          const url: string = typeof rawUrl === 'string' ? rawUrl : ''
          const queryIndex = url.indexOf('?')
          const pathOnly: string = queryIndex >= 0 ? url.slice(0, queryIndex) : url
          const rest = pathOnly.slice('/api/memory-sea/experiences'.length).replace(/^\/+/, '').replace(/\/+$/, '')
          const experienceId = decodeURIComponent(rest)
          if (experienceId.length === 0) {
            writeJson(res, 400, { ok: false, error: 'experience id required' })
            return
          }
          const detail = service.getExperienceDetail(experienceId)
          if (!detail) {
            writeJson(res, 404, { ok: false, error: 'experience not found' })
            return
          }
          const requestedScope = params.get('scope')
          const actualScope = detail.experience.scopeId ?? detail.episode?.scopeId
          if (requestedScope && actualScope && requestedScope !== actualScope) {
            writeJson(res, 404, { ok: false, error: 'experience not found in scope' })
            return
          }
          writeJson(res, 200, { ok: true, ...detail })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: errorMessage(error) })
        }
      },
    })
    if (typeof experienceRoute === 'function') disposers.push(experienceRoute as () => void)
  } catch (error) {
    logger.warn?.(`[memory-sea] experiences 路由注册失败：${errorMessage(error)}`)
  }

  // 只读调试接口：/api/memory-sea/episode-relations（关系列表）与
  // /api/memory-sea/episodes/:id/continuity（某个 Episode 的前后连续性）。
  // 连续性只是关系视图，不是证据，也不提供写操作（spec §33 / §35）。
  try {
    const relationRoute = webServer.register({
      kind: 'prefix',
      path: '/api/memory-sea/episode-relations',
      handler: (req, res) => {
        try {
          const params = queryOf(req)
          const scopeId = params.get('scope') ?? service.defaultScope.id
          const limitRaw = Number(params.get('limit'))
          const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.trunc(limitRaw)) : 100
          writeJson(res, 200, { ok: true, scopeId, relations: service.listEpisodeRelations(scopeId, limit) })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: errorMessage(error) })
        }
      },
    })
    if (typeof relationRoute === 'function') disposers.push(relationRoute as () => void)
  } catch (error) {
    logger.warn?.(`[memory-sea] episode-relations 路由注册失败：${errorMessage(error)}`)
  }

  try {
    const continuityRoute = webServer.register({
      kind: 'prefix',
      path: '/api/memory-sea/episodes',
      handler: (req, res) => {
        try {
          const rawUrl = (req as HttpRequestLike | undefined)?.url
          const url: string = typeof rawUrl === 'string' ? rawUrl : ''
          const queryIndex = url.indexOf('?')
          const pathOnly: string = queryIndex >= 0 ? url.slice(0, queryIndex) : url
          const params = new URLSearchParams(queryIndex >= 0 ? url.slice(queryIndex + 1) : '')
          const rest = pathOnly.slice('/api/memory-sea/episodes'.length).replace(/^\/+/, '')
          const parts = rest.split('/').map((part) => decodeURIComponent(part)).filter((part) => part.length > 0)
          const episodeId = parts[0] ?? ''
          if (episodeId.length === 0) {
            writeJson(res, 400, { ok: false, error: 'episode id required' })
            return
          }
          const episode = service.getEpisode(episodeId)
          if (!episode) {
            writeJson(res, 404, { ok: false, error: 'episode not found' })
            return
          }
          const requestedScope = params.get('scope')
          if (requestedScope && episode.scopeId && requestedScope !== episode.scopeId) {
            writeJson(res, 404, { ok: false, error: 'episode not found in scope' })
            return
          }
          const scopeId = requestedScope ?? episode.scopeId ?? service.defaultScope.id
          if (parts.length === 1) {
            // Stage 6：Episode 详情 = Episode + 成员经历预览 + 证据 Memory + 连续性（只读）。
            const limitRaw = Number(params.get('limit'))
            const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.trunc(limitRaw)) : 50
            const detail = service.getEpisodeDetail(episodeId, { limit })
            if (!detail) {
              writeJson(res, 404, { ok: false, error: 'episode not found' })
              return
            }
            writeJson(res, 200, { ok: true, scopeId, ...detail })
            return
          }
          if (parts.length !== 2 || parts[1] !== 'continuity') {
            writeJson(res, 404, { ok: false, error: 'not found' })
            return
          }
          const depthRaw = Number(params.get('depth'))
          const depth = Number.isFinite(depthRaw) && depthRaw > 0 ? Math.min(3, Math.trunc(depthRaw)) : 2
          writeJson(res, 200, {
            ok: true,
            episodeId,
            scopeId,
            continuity: service.getEpisodeContinuity(scopeId, episodeId, depth),
          })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: errorMessage(error) })
        }
      },
    })
    if (typeof continuityRoute === 'function') disposers.push(continuityRoute as () => void)
  } catch (error) {
    logger.warn?.(`[memory-sea] episodes 连续性路由注册失败：${errorMessage(error)}`)
  }

  for (const route of routes) {
    try {
      const registered = webServer.register({
        kind: 'exact',
        path: route.path,
        handler: (req, res) => {
          try {
            const requested = queryOf(req).get('scope')
            const scopeId = requested && requested.length > 0 ? requested : undefined
            if (scopeId && !service.knownScopes().some((scope) => scope.id === scopeId)) {
              writeJson(res, 404, { ok: false, error: 'unknown scope', scope: scopeId })
              return
            }
            writeJson(res, 200, route.build(scopeId))
          } catch (error) {
            writeJson(res, 500, { ok: false, error: errorMessage(error) })
          }
        },
      })
      if (typeof registered === 'function') disposers.push(registered as () => void)
    } catch (error) {
      logger.warn?.(`[memory-sea] 注册路由 ${route.path} 失败：${errorMessage(error)}`)
    }
  }

  // Stage 6：3D 页面。宿主只支持路由处理器、没有静态目录托管，
  // 所以页面是「单个自包含 HTML」（CSS/JS 全部内联，无 CDN），由插件直接返回。
  // `/memory-sea/view` 是 prefix 变体：热重载时旧实例会继续占用 exact 路由，
  // prefix 路径能确保新实例的页面立即可用（内容与 scene 完全一致）。
  for (const pagePath of ['/memory-sea/scene', '/api/memory-sea/ui', '/memory-sea/atlas']) {
    try {
      const pageRoute = webServer.register({
        kind: 'exact',
        path: pagePath,
        handler: (_req, res) => {
          try {
            writeHtml(res, renderScenePage())
          } catch (error) {
            writeJson(res, 500, { ok: false, error: errorMessage(error) })
          }
        },
      })
      if (typeof pageRoute === 'function') disposers.push(pageRoute as () => void)
    } catch (error) {
      logger.warn?.(`[memory-sea] 页面路由注册失败（${pagePath}）：${errorMessage(error)}`)
    }
  }
  try {
    const viewRoute = webServer.register({
      kind: 'prefix',
      path: '/memory-sea/view',
      handler: (_req, res) => {
        try {
          writeHtml(res, renderScenePage())
        } catch (error) {
          writeJson(res, 500, { ok: false, error: errorMessage(error) })
        }
      },
    })
    if (typeof viewRoute === 'function') disposers.push(viewRoute as () => void)
  } catch (error) {
    logger.warn?.(`[memory-sea] 页面视图路由注册失败：${errorMessage(error)}`)
  }
  return disposers
}

function queryOf(req: unknown): URLSearchParams {
  const rawUrl = (req as HttpRequestLike | undefined)?.url
  const url: string = typeof rawUrl === 'string' ? rawUrl : ''
  const index = url.indexOf('?')
  return new URLSearchParams(index >= 0 ? url.slice(index + 1) : '')
}

function writeJson(res: HttpResponseLike, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead?.(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end?.(body)
}

/** 返回页面 HTML：先 setHeader 再 writeHead（宿主上反过来会 ERR_HTTP_HEADERS_SENT）。 */
function writeHtml(res: HttpResponseLike, body: string): void {
  if (typeof res.setHeader === 'function') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.writeHead?.(200)
  } else {
    res.writeHead?.(200, { 'content-type': 'text/html; charset=utf-8' })
  }
  res.end?.(body)
}

export { MemorySeaService }
export { toLegacyScene } from './scene/legacy-adapter.js'
export { resolveConfig, MEMORY_SEA_DEFAULTS, defaultDatabasePath } from './config.js'
export type { MemorySeaConfig } from './config.js'
export type {
  CaptureInput,
  CaptureResult,
  Episode,
  Experience,
  MemoryInspection,
  MemoryScope,
  MemorySeaScene,
  MemorySeaStatus,
  RecallHit,
  RecallReason,
  RecallRequest,
  RememberInput,
  SceneEdge,
  ScenePoint,
} from './types.js'

/**
 * Phase 2B：人工审核入口（写操作）。
 *
 * 与只读路由分开注册，且每条都先做操作者认证：
 *   - 认证失败 → 401/403/503（不静默成功）；
 *   - 认证成功 → reviewer 由认证结果生成（`local_token:op_xxxxxxxx`），
 *     不信任请求体里的 reviewerId；
 *   - 审核动作在 SkillService 里用事务提交 ReviewRecord + 状态迁移。
 */
function registerOperatorRoutes(
  ctx: PluginContextLike,
  service: MemorySeaService,
  logger: PluginLogger,
  operatorAuth: OperatorAuth,
): (() => void)[] {
  const webServer = ctx.webServer ?? (ctx.get?.('webServer') as WebServerLike | undefined)
  if (!webServer) return []
  const disposers: (() => void)[] = []
  const base = '/api/memory-sea/operator'

  const guard = (req: unknown): { ok: true; reviewer: string } | { ok: false; status: number; code: string; message: string } => {
    const result = operatorAuth.authenticate(req as OperatorRequestLike)
    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        code: result.code,
        message: result.message,
      }
    }
    return { ok: true, reviewer: operatorAuth.reviewerLabel(result) }
  }

  try {
    const route = webServer.register({
      kind: 'prefix',
      path: base,
      handler: (req, res) => {
        void (async () => {
          const auth = guard(req)
          const method = operatorMethod(req)
          const path = operatorPath(req)
          const params = operatorQuery(req)
          const scopeId = params.get('scope') ?? service.defaultScope.id
          if (!auth.ok) {
            writeJson(res, auth.status, { ok: false, code: auth.code, error: auth.message })
            return
          }
          const rest = path.slice(base.length).replace(/^\/+/, '')
          const readBody = async (): Promise<Record<string, unknown>> => {
            const raw = await readJsonBody(req)
            return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
              ? (raw as Record<string, unknown>)
              : {}
          }
          try {
            if (method === 'GET' && rest === 'candidates') {
              const limit = numberFrom(params.get('limit'), 20, 1, 100)
              const status = params.get('status') as SkillCandidateStatus | null
              const kind = params.get('kind') as SkillCandidateKind | null
              const candidates = service.listSkillCandidates(scopeId, {
                ...(status ? { status } : {}),
                ...(kind ? { kind } : {}),
                limit,
              })
              writeJson(res, 200, { ok: true, scopeId, candidates })
              return
            }
            if (method === 'GET' && rest.startsWith('candidates/')) {
              const [candidateId, tail] = splitCandidateRest(rest.slice('candidates/'.length))
              if (candidateId.length === 0) {
                writeJson(res, 400, { ok: false, error: 'candidate id required' })
                return
              }
              if (tail === 'reviews') {
                writeJson(res, 200, {
                  ok: true,
                  scopeId,
                  candidateId,
                  reviews: service.listSkillReviews(scopeId, candidateId),
                })
                return
              }
              const detail = service.getSkillCandidateDetail(scopeId, candidateId)
              if (!detail) {
                writeJson(res, 404, { ok: false, error: 'skill candidate not found' })
                return
              }
              writeJson(res, 200, { ok: true, scopeId, ...detail })
              return
            }
            if (method === 'POST' && rest.startsWith('candidates/')) {
              const [candidateId, tail] = splitCandidateRest(rest.slice('candidates/'.length))
              if (candidateId.length === 0) {
                writeJson(res, 400, { ok: false, error: 'candidate id required' })
                return
              }
              const body = await readBody()
              if (tail === 'submit') {
                const reason = typeof body.reason === 'string' ? body.reason : undefined
                const result = service.submitSkillCandidate(scopeId, candidateId, {
                  reviewer: auth.reviewer,
                  ...(reason ? { reason } : {}),
                })
                writeJson(res, 200, { ok: true, scopeId, ...result })
                return
              }
              if (tail === 'review') {
                const decision = body.decision
                if (decision !== 'approve' && decision !== 'reject' && decision !== 'request_changes') {
                  writeJson(res, 400, { ok: false, error: 'decision 必须是 approve / reject / request_changes' })
                  return
                }
                const versionId = typeof body.versionId === 'string' ? body.versionId : ''
                if (versionId.length === 0) {
                  writeJson(res, 400, { ok: false, error: 'versionId 必填（审核的是具体版本）' })
                  return
                }
                const result = service.reviewSkillCandidate({
                  scopeId,
                  versionId,
                  decision,
                  reviewer: auth.reviewer,
                  reason: typeof body.reason === 'string' ? body.reason : '',
                })
                writeJson(res, 200, { ok: true, scopeId, ...result })
                return
              }
              if (tail === 'versions') {
                const procedure = body.procedure
                if (!procedure || typeof procedure !== 'object') {
                  writeJson(res, 400, { ok: false, error: 'procedure 必填' })
                  return
                }
                const changeReason = typeof body.changeReason === 'string' ? body.changeReason : ''
                const version = service.editSkillProcedure(scopeId, candidateId, {
                  procedure: procedure as ProcedureDraft,
                  changeReason,
                  createdBy: auth.reviewer,
                  ...(typeof body.title === 'string' ? { title: body.title } : {}),
                })
                writeJson(res, 200, { ok: true, scopeId, candidateId, version })
                return
              }
              writeJson(res, 404, { ok: false, error: 'unknown operator action' })
              return
            }
            writeJson(res, 405, { ok: false, error: `${method} ${path} 不支持` })
          } catch (error) {
            const message = errorMessage(error)
            // 客户端错误要给出准确状态码：找不到 404、状态机冲突 409、请求内容不合法 400、其余才是服务端故障。
            const status = /未找到/.test(message)
              ? 404
              : /不在|已经|已被|当前 *[a-z_]+|状态不允许|冲突/.test(message)
                ? 409
                : /不能|必须|至少|不允许|无效|超过|无效的/.test(message)
                  ? 400
                  : 500
            writeJson(res, status, { ok: false, error: message })
          }
        })().catch((error: unknown) => {
          try {
            writeJson(res, 500, { ok: false, error: errorMessage(error) })
          } catch {
            // 响应已结束：忽略。
          }
        })
      },
    })
    if (typeof route === 'function') disposers.push(route as () => void)
  } catch (error) {
    logger.warn?.(`[memory-sea] operator 路由注册失败：${errorMessage(error)}`)
  }

  return disposers
}

interface OperatorRequestLike {
  url?: string
  method?: string
  headers?: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string }
  connection?: { remoteAddress?: string }
  [Symbol.asyncIterator]?(): AsyncIterator<unknown>
}

function operatorPath(req: unknown): string {
  const rawUrl = (req as OperatorRequestLike | undefined)?.url
  const url: string = typeof rawUrl === 'string' ? rawUrl : ''
  const index = url.indexOf('?')
  return index >= 0 ? url.slice(0, index) : url
}

function operatorQuery(req: unknown): URLSearchParams {
  const rawUrl = (req as OperatorRequestLike | undefined)?.url
  const url: string = typeof rawUrl === 'string' ? rawUrl : ''
  const index = url.indexOf('?')
  return new URLSearchParams(index >= 0 ? url.slice(index + 1) : '')
}

function operatorMethod(req: unknown): string {
  const method = (req as OperatorRequestLike | undefined)?.method
  return typeof method === 'string' ? method.toUpperCase() : 'GET'
}

function splitCandidateRest(value: string): [string, string] {
  const index = value.indexOf('/')
  if (index < 0) return [decodeURIComponent(value), '']
  return [decodeURIComponent(value.slice(0, index)), value.slice(index + 1).replace(/\/+$/, '')]
}

function numberFrom(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = value === null ? Number.NaN : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/** 读取 JSON 请求体（限制 256KB，避免审核入口成为内存放大点）。 */
async function readJsonBody(req: unknown): Promise<unknown> {
  const source = req as OperatorRequestLike | undefined
  if (!source || typeof source[Symbol.asyncIterator] !== 'function') return null
  const limit = 256 * 1024
  // 先收字节再统一解码：宿主的 body 可能以字符串片段到达（历史实现按 latin1 逐字节展开），
  // 逐片解码还会把跨片的中文字符切坏，所以这里只在最后做一次 UTF-8 解码。
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of source as AsyncIterable<unknown>) {
    const bytes =
      chunk instanceof Uint8Array
        ? Buffer.from(chunk)
        : typeof chunk === 'string'
          ? stringToBytes(chunk)
          : Buffer.from(String(chunk), 'utf8')
    size += bytes.length
    if (size > limit) throw new Error('请求体过大（>256KB）')
    chunks.push(bytes)
  }
  const body = Buffer.concat(chunks).toString('utf8')
  if (body.trim().length === 0) return null
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** 字符串片段可能是正常 UTF-8 解码结果，也可能是按 latin1 展开的 mojibake。 */
function stringToBytes(value: string): Buffer {
  if (value.length === 0) return Buffer.alloc(0)
  let suspicious = 0
  let high = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0xfffd) suspicious += 1
    else if (code > 0x7f) high += 1
    if (code > 0xff) return Buffer.from(value, 'utf8')
  }
  if (high === 0 || suspicious === 0) return Buffer.from(value, 'utf8')
  return Buffer.from(value, 'latin1')
}