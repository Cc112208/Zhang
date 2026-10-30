/**
 * errors.ts —— Memory Sea 的错误边界。
 *
 * 核心约定（spec §21）：Memory Sea 挂掉 ≠ DeepSeek 挂掉。
 *   - 内部错误统一包成 MemorySeaError 子类，带 code 便于日志与工具返回。
 *   - 插件入口（index.ts）兜住所有异常，绝不让异常穿透到宿主。
 */

export type MemorySeaErrorCode =
  | 'storage_unavailable'
  | 'storage_busy'
  | 'capture_failed'
  | 'recall_failed'
  | 'not_found'
  | 'invalid_request'
  | 'disabled'

export class MemorySeaError extends Error {
  readonly code: MemorySeaErrorCode

  constructor(code: MemorySeaErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MemorySeaError'
    this.code = code
  }
}

export class StorageError extends MemorySeaError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('storage_unavailable', message, options)
    this.name = 'StorageError'
  }
}

export class CaptureError extends MemorySeaError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('capture_failed', message, options)
    this.name = 'CaptureError'
  }
}

export class RecallError extends MemorySeaError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('recall_failed', message, options)
    this.name = 'RecallError'
  }
}

/** 从任意异常里提取稳定的一行描述（日志/工具输出都只暴露这一行，避免把堆栈喷给用户）。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** 包一层，把非 MemorySeaError 的异常转成指定类型，保留 cause。 */
export function wrapError<T extends MemorySeaError>(
  Ctor: new (message: string, options?: { cause?: unknown }) => T,
  error: unknown,
  context: string,
): T {
  if (error instanceof MemorySeaError) return error as T
  return new Ctor(`${context}: ${errorMessage(error)}`, { cause: error })
}
