import { copyFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

// Patch the bundled runtime first (same step as before).
execFileSync(process.execPath, [join(projectRoot, 'scripts', 'patch-bundled-runtime.mjs')], { stdio: 'inherit' })

if (process.platform === 'win32') {
  const target = join(projectRoot, 'release', 'win-unpacked', '安装.bat')
  copyFileSync(join(projectRoot, 'scripts', 'install.bat'), target)
  console.log('[post-pack] copied 安装.bat into win-unpacked')
} else if (process.platform === 'darwin') {
  // Locate the macOS .app and place the install script next to it so a future
  // manual zip step can package both together.
  let appDir = null
  try {
    for (const entry of readdirSync(join(projectRoot, 'release'))) {
      if (!entry.startsWith('mac')) continue
      const macDir = join(projectRoot, 'release', entry)
      if (!statSync(macDir).isDirectory()) continue
      for (const appEntry of readdirSync(macDir)) {
        if (appEntry.endsWith('.app') && statSync(join(macDir, appEntry)).isDirectory()) {
          appDir = join(macDir, appEntry)
          break
        }
      }
      if (appDir !== null) break
    }
  } catch {
    // No release directory yet.
  }
  if (appDir !== null) {
    const target = join(appDir, '..', '安装.command')
    copyFileSync(join(projectRoot, 'scripts', 'install-mac.command'), target)
    console.log(`[post-pack] copied 安装.command next to ${appDir}`)
  } else {
    console.warn('[post-pack] no macOS .app found in release/, skipped install script copy')
  }
} else {
  console.log(`[post-pack] unsupported platform ${process.platform}, skipped install script copy`)
}
