// 把非 TS 资源（SQL 迁移）同步到 dist，保证 dist 自包含、可直接被 Loader 加载。
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const assets = [
  ['src/storage/migrations', 'dist/src/storage/migrations'],
  // Stage 6：3D 页面的 CSS/JS 由插件在运行时读取并内联（宿主没有静态托管）。
  ['src/web/client', 'dist/src/web/client'],
  // Stage 6 方案 A：浏览器半端（自注册 client bundle，被宿主按 exports["./client"] 加载）。
  ['assets/client', 'dist/client'],
]

for (const [from, to] of assets) {
  const src = join(root, from)
  if (!existsSync(src)) {
    console.error(`[copy-assets] missing: ${from}`)
    process.exitCode = 1
    continue
  }
  mkdirSync(dirname(join(root, to)), { recursive: true })
  cpSync(src, join(root, to), { recursive: true })
  console.log(`[copy-assets] ${from} -> ${to}`)
}
