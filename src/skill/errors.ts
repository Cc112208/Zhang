/**
 * errors.ts —— Stage 5 的错误类型。
 *
 * 复用 MemorySeaError 的错误码体系（invalid_request），但用独立类名让日志与接口
 * 能明确区分「候选/尝试/审核的业务拒绝」和真正的存储故障。
 */

import { MemorySeaError } from '../errors.js'

export class SkillError extends MemorySeaError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('invalid_request', message, options)
    this.name = 'SkillError'
  }
}

/** 关联实体与调用方声明的 scope 不一致：这是数据完整性问题，必须显式失败。 */
export class SkillScopeError extends SkillError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SkillScopeError'
  }
}
