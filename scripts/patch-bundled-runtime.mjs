import { cpSync, existsSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const projectModules = join(projectRoot, 'node_modules', '@deepseek-ai')
const bundledModules = join(projectRoot, 'release', 'win-unpacked', 'resources', 'app', 'node_modules', '@deepseek-ai')

if (!existsSync(bundledModules)) {
  console.error('[patch-bundled-runtime] bundled node_modules not found, run pack first:', bundledModules)
  process.exit(1)
}

const bundled = new Set(readdirSync(bundledModules))
let copied = 0
for (const entry of readdirSync(projectModules)) {
  if (entry.startsWith('.')) continue
  if (bundled.has(entry)) continue
  const source = realpathSync(join(projectModules, entry))
  const target = join(bundledModules, entry)
  if (!existsSync(join(source, 'package.json'))) continue
  cpSync(source, target, { recursive: true })
  copied += 1
  console.log(`[patch-bundled-runtime] copied missing runtime package @deepseek-ai/${entry} <- ${source}`)
}
console.log(`[patch-bundled-runtime] done, copied ${copied} package(s)`)
