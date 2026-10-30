/**
 * job-runner.ts —— 后台任务的调度循环（spec §16 / §17）。
 *
 * 分工：JobRepository 负责「任务状态在数据库里怎么变」，本文件只负责
 * 「什么时候领、领多少、执行 handler、把结果写回去」。因此这里没有一行 SQL。
 *
 * 生存原则（spec §21：Memory Sea 挂掉 ≠ 宿主挂掉）：
 *   - tick 绝不向上抛错，handler 的异常在这里被吞掉并记录；
 *   - 定时器必须 unref，后台任务层不应该阻止宿主进程退出；
 *   - handler 缺失按失败处理，而不是让 tick 崩掉。
 */

import type { MemoryJob, MemoryJobType } from '../types.js'
import { errorMessage } from '../errors.js'
import type { JobRepository } from './job-repository.js'

export interface JobRunnerLogger {
  info?(message: string): void
  warn?(message: string): void
  error?(message: string, error?: unknown): void
}

export interface JobRunnerDeps {
  jobs: JobRepository
  /** 每种任务一个 handler；缺失的 type 在运行时按失败处理。 */
  handlers: Record<MemoryJobType, (job: MemoryJob) => Promise<void>>
  /** 注入时钟，缺省 Date.now。 */
  now?: () => number
  /** 两次 tick 的间隔，缺省 2000ms。 */
  intervalMs?: number
  /** 单轮最多领取条数，缺省 8。 */
  maxPerTick?: number
  /** running 超过该时长视为僵死，缺省 60000ms。 */
  staleMs?: number
  logger?: JobRunnerLogger
}

const DEFAULT_INTERVAL_MS = 2_000
const DEFAULT_MAX_PER_TICK = 8
const DEFAULT_STALE_MS = 60_000

function positiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

export class JobRunner {
  private readonly jobs: JobRepository
  private readonly handlers: Record<MemoryJobType, (job: MemoryJob) => Promise<void>>
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly maxPerTick: number
  private readonly staleMs: number
  private readonly logger: JobRunnerLogger

  private timer: ReturnType<typeof setInterval> | null = null
  /** 当前正在跑的 tick；同一时刻最多一个，避免重叠领取与重复执行。 */
  private inFlight: Promise<void> | null = null
  private active = false

  constructor(deps: JobRunnerDeps) {
    this.jobs = deps.jobs
    this.handlers = deps.handlers
    this.now = deps.now ?? Date.now
    this.intervalMs = positiveInt(deps.intervalMs, DEFAULT_INTERVAL_MS)
    this.maxPerTick = positiveInt(deps.maxPerTick, DEFAULT_MAX_PER_TICK)
    this.staleMs = positiveInt(deps.staleMs, DEFAULT_STALE_MS)
    this.logger = deps.logger ?? {}
  }

  get running(): boolean {
    return this.active
  }

  /** 幂等启动；首次立即跑一轮，宿主启动时积压的任务不用等一个 interval。 */
  start(): void {
    if (this.active) return
    this.active = true
    this.scheduleTick()
    const timer = setInterval(() => this.scheduleTick(), this.intervalMs)
    // unref：定时器不持有事件循环，宿主想退出时不会被后台任务拖住。
    timer.unref?.()
    this.timer = timer
  }

  /**
   * 同步停止（契约是 void，不能 await）。清理定时器后不会再有新的 tick；
   * 已经在跑的 tick 通过 whenIdle() 等待，宿主关闭数据库前应先 await 它。
   */
  stop(): void {
    this.active = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 等待当前 tick 执行完毕（没在跑则立即 resolve）。 */
  async whenIdle(): Promise<void> {
    await this.inFlight
  }

  /**
   * 执行一轮：回收僵死 → 领取到期任务 → 逐个执行。
   *
   * 返回本轮实际处理的任务条数（成功与失败都计入：它们都已被领取并尝试执行）。
   * 本方法保证不抛错——这是后台循环能长期存活的前提。
   */
  async tick(): Promise<number> {
    let processed = 0
    try {
      const now = this.now()

      const reclaimed = this.jobs.reclaimStale(now, this.staleMs)
      if (reclaimed > 0) {
        this.logger.warn?.(`[memory-sea] 回收了 ${reclaimed} 个僵死的后台任务`)
      }

      const claimed = this.jobs.claim(now, { limit: this.maxPerTick })
      for (const job of claimed) {
        processed += 1
        try {
          const handler = this.handlers[job.type]
          // handlers 类型上要求齐全，但运行时仍可能因装配错误缺项；缺 handler 当失败处理。
          if (!handler) throw new Error(`未注册 ${job.type} 类型的任务处理器`)

          await handler(job)
          this.jobs.complete(job.id, this.now())
        } catch (error) {
          const message = errorMessage(error)
          this.logger.error?.(`[memory-sea] 任务 ${job.id} (${job.type}) 执行失败: ${message}`, error)
          try {
            // 失败也走统一的退避重试逻辑，不在 runner 里判断是否该重试。
            this.jobs.fail(job.id, message, this.now())
          } catch (failError) {
            this.logger.error?.(
              `[memory-sea] 任务 ${job.id} 记录失败时又出错: ${errorMessage(failError)}`,
              failError,
            )
          }
        }
      }

      if (processed > 0) {
        this.logger.info?.(`[memory-sea] 本轮处理了 ${processed} 个后台任务`)
      }
    } catch (error) {
      // 领任务本身失败（数据库关闭 / 锁超时等）：记一笔，下一轮再试，绝不冒泡。
      this.logger.error?.(`[memory-sea] 后台任务调度失败: ${errorMessage(error)}`, error)
    }
    return processed
  }

  // ---------------------------------------------------------------- 内部

  /** 已有 tick 在跑时直接跳过本轮，用 inFlight 做单飞（single-flight）保护。 */
  private scheduleTick(): void {
    if (this.inFlight) return
    this.inFlight = this.tick()
      .then(() => undefined)
      .finally(() => {
        this.inFlight = null
      })
  }
}
