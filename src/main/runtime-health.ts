import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildDshLaunchArgs } from './runtime-controller.js'
import { findAvailablePort } from './ports.js'

export async function validateDshRuntime(options: {
  runtimeRoot: string
  nodeExecutable: string
  dshHome: string
}): Promise<boolean> {
  const port = await findAvailablePort()
  const validationHome = await mkdtemp(join(tmpdir(), 'dsh-runtime-validation-'))
  const dshBin = join(options.runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const child = spawn(options.nodeExecutable, buildDshLaunchArgs(dshBin, port), {
    cwd: options.runtimeRoot,
    env: { ...process.env, DSH_HOME: validationHome, DSH_DESKTOP_SUPERVISED: '1' },
    stdio: 'ignore',
    windowsHide: true,
  })
  try {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) return false
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) })
        if (response.ok) return true
      } catch {
        // Wait until official plugins have mounted.
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    return false
  } finally {
    child.kill()
    await rm(validationHome, { recursive: true, force: true })
  }
}
