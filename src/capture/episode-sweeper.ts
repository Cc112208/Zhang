/**
 * episode-sweeper.ts —— Episode 的「定时收割」（spec §10 / §11）。
 *
 * 为什么需要它：capture 只在「新经历到来」时懒性关闭过期 Episode。
 * 如果用户说完一段就停了，最后那段会永远停在 `open`，Scene 与状态统计都会不准。
 * Sweeper 用一个低成本定时器定期做三件事：
 *
 *   1. 关闭 last_experience_at 超过 idleMs 的 open Episode（idle_timeout）；
 *   2. 关闭那些「很久以前就开着、但再也没有新经历」的 Episode（启动恢复也算这类）；
 *   3. 把关闭事件交给回调，由上层排摘要任务。
 *
 * 设计边界：Sweeper **不写 SQL、不排任务、不做摘要** —— 只决定「哪些该关」，
 * 关闭动作交给 EpisodeBuilder / EpisodeRepository，任务交给回调。
 */

import type { Episode, EpisodeClosedReason } from '../types.js'
import type { EpisodeBuilder } from './episode-builder.js'

export interface EpisodeSweeperDeps {
  builder: Pick<EpisodeBuilder, 'closeIdleEpisodes' | 'closeForSession'>
  now?: () => number
  /** 单次 sweep 最多关闭多少个 Episode（保护主线程）。 */
  maxPerSweep?: number
  logger?: { info?(message: string): void; warn?(message: string): void }
}

export interface SweepResult {
  closed: Episode[]
  closedCount: number
  at: number
}

export class EpisodeSweeper {
  private readonly builder: EpisodeSweeperDeps['builder']
  private readonly now: () => number
  private readonly maxPerSweep: number
  private readonly logger?: EpisodeSweeperDeps['logger']
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight: Promise<void> | null = null

  constructor(deps: EpisodeSweeperDeps) {
    this.builder = deps.builder
    this.now = deps.now ?? (() => Date.now())
    this.maxPerSweep = deps.maxPerSweep ?? 200
    this.logger = deps.logger
  }

  get running(): boolean {
    return this.timer !== null
  }

  /** 执行一次收割。同步、可控、可测：不启动定时器也能用。 */
  sweep(reason: EpisodeClosedReason = 'idle_timeout'): SweepResult {
    const at = this.now()
    let closed: Episode[] = []
    try {
      closed = this.builder.closeIdleEpisodes(at, reason)
      if (closed.length > this.maxPerSweep) closed = closed.slice(0, this.maxPerSweep)
    } catch (error) {
      // 收割失败不能影响宿主：下一轮继续尝试。
      this.logger?.warn?.(`Episode 收割失败: ${String(error)}`)
      return { closed: [], closedCount: 0, at }
    }
    if (closed.length > 0) {
      this.logger?.info?.(`Episode 收割：关闭 ${closed.length} 个（${reason}）`)
    }
    return { closed, closedCount: closed.length, at }
  }

  /** 会话结束时立刻收割该会话的 open Episode。 */
  sweepSession(sessionId: string): Episode[] {
    try {
      return this.builder.closeForSession(sessionId, this.now())
    } catch (error) {
      this.logger?.warn?.(`会话结束收割失败: ${String(error)}`)
      return []
    }
  }

  /**
   * 启动周期性收割。
   * unref：定时器不能拖住宿主进程退出（宿主关闭时插件必须干净退场）。
   */
  start(intervalMs: number): void {
    if (this.timer) return
    const period = Math.max(1000, Math.round(intervalMs))
    this.timer = setInterval(() => {
      if (this.inFlight) return
      this.inFlight = Promise.resolve()
        .then(() => {
          this.sweep()
        })
        .catch((error: unknown) => {
          this.logger?.warn?.(`Episode 收割异常: ${String(error)}`)
        })
        .finally(() => {
          this.inFlight = null
        })
    }, period)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
