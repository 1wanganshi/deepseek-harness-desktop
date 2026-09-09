// macOS 打包专用：修复 .app bundle 内的符号链接，让 codesign 可以封签。
//
// pnpm 虚拟存储会在包内部产生相对 symlink。electron-builder 原样打包时这些
// 链接指向 bundle 内部（合法）；但 patch-bundled-runtime 从 .pnpm store 复制到
// 顶层的包，其内部相对链接会指向 bundle 外部（codesign: invalid destination）
// 或彻底悬空。本脚本遍历 bundle 的 node_modules：
//   - 链接解析到 bundle 之外  → 用目标的真实内容替换（dereference 复制）
//   - 链接悬空               → 删除（模块解析会向上回退到顶层 node_modules，
//                               与 Windows 发行包的运行时行为一致）
//   - 链接指向 bundle 内部    → 保留不动
//
// 仅在 macOS CI 工作流中调用；Windows 打包路径完全不经过此脚本。
//
// Usage: node scripts/materialize-symlinks.mjs <path/to/App.app>
import { copyFileSync, cpSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const bundlePath = process.argv[2]
if (bundlePath === undefined) {
  console.error('[materialize-symlinks] missing .app bundle path argument')
  process.exit(1)
}
const bundleRoot = resolve(bundlePath)
const walkRoot = join(bundleRoot, 'Contents', 'Resources', 'app', 'node_modules')

let materialized = 0
let danglingRemoved = 0
let keptInternal = 0

function isInsideBundle(target) {
  const resolved = resolve(target)
  return resolved === bundleRoot || resolved.startsWith(bundleRoot + '/')
}

function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    let stats
    try {
      stats = lstatSync(full)
    } catch {
      continue
    }
    if (stats.isSymbolicLink()) {
      let target
      try {
        target = realpathSync(full)
      } catch {
        rmSync(full, { force: true, recursive: true })
        danglingRemoved += 1
        continue
      }
      if (isInsideBundle(target)) {
        keptInternal += 1
        continue
      }
      rmSync(full, { force: true, recursive: true })
      if (statSync(target).isDirectory()) {
        cpSync(target, full, { recursive: true, dereference: true })
      } else {
        copyFileSync(target, full)
      }
      materialized += 1
      continue
    }
    if (stats.isDirectory()) walk(full)
  }
}

walk(walkRoot)
console.log(`[materialize-symlinks] ${walkRoot}: materialized ${materialized}, removed dangling ${danglingRemoved}, kept internal ${keptInternal}`)
