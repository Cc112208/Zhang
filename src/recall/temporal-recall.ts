/**
 * temporal-recall.ts —— 时间维度（spec §13）。
 *
 * 只做两件事：
 *   1. before / after 窗口判定（硬过滤 + 命中加分）；
 *   2. recency（越新越容易被联想到）的确定性衰减。
 *
 * 明确不做自然语言时间解析（「三天前」「上个月」）——那是未来的接口预留点，
 * 见 parseTimeExpression 的占位说明。
 */

export interface TemporalWindow {
  before?: number
  after?: number
}

export interface TemporalSignal {
  /** 0..1。没有窗口时恒为 0（时间不提供额外证据）。 */
  score: number
  detail?: string
  /** 没有窗口时视为 true。 */
  inWindow: boolean
}

/** 默认 14 天半衰期：两周前的经历仍然有 50% 的新鲜度权重。 */
export const DEFAULT_RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000

export class TemporalRecall {
  private readonly halfLifeMs: number
  private readonly nowFn: () => number

  constructor(deps: { halfLifeMs?: number; now?: () => number } = {}) {
    this.halfLifeMs = deps.halfLifeMs && deps.halfLifeMs > 0 ? deps.halfLifeMs : DEFAULT_RECENCY_HALF_LIFE_MS
    this.nowFn = deps.now ?? Date.now
  }

  hasWindow(window: TemporalWindow | undefined): boolean {
    return Boolean(window && (typeof window.before === 'number' || typeof window.after === 'number'))
  }

  inWindow(at: number, window: TemporalWindow | undefined): boolean {
    if (!window) return true
    if (typeof window.after === 'number' && at <= window.after) return false
    if (typeof window.before === 'number' && at >= window.before) return false
    return true
  }

  evaluate(at: number, window: TemporalWindow | undefined): TemporalSignal {
    if (!this.hasWindow(window)) return { score: 0, inWindow: true }
    if (!this.inWindow(at, window)) return { score: 0, inWindow: false }
    return { score: 1, inWindow: true, detail: `落在请求时间范围内（${this.describeAge(at)}）` }
  }

  /** 指数衰减：半个半衰期 → 0.707，一个半衰期 → 0.5。未来时间按「刚刚」处理。 */
  recencyScore(at: number): number {
    const age = Math.max(0, this.nowFn() - at)
    if (age <= 0) return 1
    return Math.round(Math.exp((-Math.LN2 * age) / this.halfLifeMs) * 10_000) / 10_000
  }

  /** 给人看的时间描述，进入 RecallReason.detail。 */
  describeAge(at: number): string {
    const diff = this.nowFn() - at
    if (!Number.isFinite(diff)) return '时间未知'
    if (diff <= 60_000) return '刚刚'
    const minutes = Math.floor(diff / 60_000)
    if (minutes < 60) return `${minutes} 分钟前`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours} 小时前`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days} 天前`
    const months = Math.floor(days / 30)
    if (months < 12) return `${months} 个月前`
    return `${Math.floor(months / 12)} 年前`
  }
}

/**
 * 自然语言时间解析的预留接口（spec §13：这一版不实现复杂理解）。
 * 未来在这里接 chrono / 规则解析，输入「上周三」输出 {after, before}。
 */
export type TimeExpressionParser = (expression: string, now: number) => TemporalWindow | null

/** 当前占位实现：不解析，返回 null，调用方据此忽略自然语言时间。 */
export const unsupportedTimeExpressionParser: TimeExpressionParser = () => null
