/**
 * path-normalizer.ts —— 把任意写法的项目路径规范化成稳定的 scope id（spec §4）。
 *
 * 为什么需要它：Project scope 不能用绝对路径本身当数据库主键（同一个项目在不同
 * 平台/写法下字符串不同、Windows 大小写不敏感）。这里做四步：
 *
 *   resolve 绝对路径 → 统一分隔符 → 去掉末尾分隔符 → Windows 下小写 → hash
 *
 * 于是 `C:\Code\MemorySea`、`C:/Code/MemorySea`、`c:\code\memorysea` 在 Windows 下
 * 得到同一个 `project_<hash>`。哈希只用于标识，不承载语义。
 */

import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'

/** global scope 的固定 id（跨项目共享的记忆用，Stage 2 只保留入口，不做检索）。 */
export const GLOBAL_SCOPE_ID = 'global'

/** legacy scope：旧数据无法推导 rootPath 时的兜底作用域，确保永不丢数据。 */
export const LEGACY_SCOPE_ID = 'project_legacy'

export type PathPlatform = 'win32' | 'posix'

/**
 * 规范化项目根路径。
 *
 * - 相对路径先按当前进程 cwd 解析成绝对路径（调用方应尽量传绝对路径）；
 * - 统一用 `/`；
 * - 去掉末尾的 `/`（保留根 `/`，以及 Windows 盘符根 `c:/`）；
 * - Windows 下整体小写（大小写不敏感）。
 */
export function normalizeProjectPath(input: string, platform: PathPlatform = process.platform as PathPlatform): string {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw.length === 0) return platform === 'win32' ? 'c:/' : '/'

  // Honor the requested platform, including when tests emulate Windows on POSIX.
  let normalized = (platform === 'win32' ? win32.resolve(raw) : posix.resolve(raw)).split('\\').join('/')

  // 去掉末尾分隔符，但保留根与盘符根。
  while (normalized.length > 1 && normalized.endsWith('/') && !/^[a-zA-Z]:\/$/.test(normalized)) {
    normalized = normalized.slice(0, -1)
  }
  if (normalized.length === 0) normalized = '/'

  if (platform === 'win32') {
    normalized = normalized.toLowerCase()
    // `c:` → `c:/`（盘符根统一成带斜杠的写法）
    if (/^[a-z]:$/.test(normalized)) normalized = `${normalized}/`
  }
  return normalized
}

/**
 * 从项目根路径派生 scope id。同一个项目在 Windows 下不论路径写法都得到同一个 id。
 */
export function deriveProjectScopeId(
  rootPath: string,
  platform: PathPlatform = process.platform as PathPlatform,
): string {
  const normalized = normalizeProjectPath(rootPath, platform)
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex')
  return `project_${digest.slice(0, 16)}`
}

/** 判断一个字符串是不是本模块生成的 project scope id。 */
export function isProjectScopeId(value: unknown): value is string {
  return typeof value === 'string' && /^project_[0-9a-f]{16}$/u.test(value)
}

/** 判断一个字符串是不是 legacy 兜底 scope id。 */
export function isLegacyScopeId(value: unknown): value is string {
  return value === LEGACY_SCOPE_ID
}

/** 给日志用的短标签（不打印完整绝对路径）。 */
export function shortScopeId(scopeId: string): string {
  return scopeId.length > 16 ? `${scopeId.slice(0, 16)}…` : scopeId
}
