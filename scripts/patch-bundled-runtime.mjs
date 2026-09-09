import { cpSync, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const projectModules = join(projectRoot, 'node_modules')
const pnpmStore = join(projectRoot, 'node_modules', '.pnpm')

function detectBundledScope() {
  const candidates = [
    join(projectRoot, 'release', 'win-unpacked', 'resources', 'app'),
  ]
  // macOS electron-builder output: release/mac-arm64/<AppName>.app/Contents/Resources/app (and similar)
  try {
    for (const entry of readdirSync(join(projectRoot, 'release'))) {
      if (!entry.startsWith('mac')) continue
      const macDir = join(projectRoot, 'release', entry)
      if (!statSync(macDir).isDirectory()) continue
      for (const appEntry of readdirSync(macDir)) {
        if (!appEntry.endsWith('.app')) continue
        candidates.push(join(macDir, appEntry, 'Contents', 'Resources', 'app'))
      }
    }
  } catch {
    // No release directory yet; fall through to the default error below.
  }
  for (const candidate of candidates) {
    const scope = join(candidate, 'node_modules', '@deepseek-ai')
    if (existsSync(scope)) return scope
  }
  return null
}

const bundledScope = detectBundledScope()
if (bundledScope === null) {
  console.error('[patch-bundled-runtime] bundled node_modules not found, run pack first')
  process.exit(1)
}

function readVersion(pkgDir) {
  try {
    return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version
  } catch {
    return null
  }
}

function compareSemver(a, b) {
  const parse = (v) => v.split('-')[0].split('.').map(Number)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  }
  const preA = a.includes('-') ? a.split('-')[1] : 'zzz'
  const preB = b.includes('-') ? b.split('-')[1] : 'zzz'
  return preA.localeCompare(preB)
}

const best = new Map()

function consider(name, source) {
  const version = readVersion(source)
  if (!version) return
  const current = best.get(name)
  if (!current || compareSemver(version, current.version) > 0) {
    best.set(name, { version, source })
  }
}

// Top-level declared packages first
const topLevelScope = join(projectModules, '@deepseek-ai')
if (existsSync(topLevelScope)) {
  for (const entry of readdirSync(topLevelScope)) {
    if (entry.startsWith('.')) continue
    const source = realpathSync(join(topLevelScope, entry))
    consider(entry, source)
  }
}

// Scan every .pnpm store directory's internal node_modules (pnpm truncates long dir names,
// so the package identity must come from the inner node_modules layout, not the dir name)
if (existsSync(pnpmStore)) {
  for (const dir of readdirSync(pnpmStore)) {
    const innerScope = join(pnpmStore, dir, 'node_modules', '@deepseek-ai')
    if (!existsSync(innerScope)) continue
    let entries
    try {
      entries = readdirSync(innerScope)
    } catch {
      continue
    }
    for (const entry of entries) {
      consider(entry, join(innerScope, entry))
    }
  }
}

let copied = 0
for (const [name, info] of best.entries()) {
  const target = join(bundledScope, name)
  if (existsSync(target)) continue
  cpSync(info.source, target, { recursive: true })
  copied += 1
  console.log(`[patch-bundled-runtime] copied @deepseek-ai/${name}@${info.version}`)
}

console.log(`[patch-bundled-runtime] done, considered ${best.size} package(s), copied ${copied} missing one(s)`)
