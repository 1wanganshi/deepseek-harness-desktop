import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DiagnosticsStore } from '../src/main/diagnostics.js'

describe('diagnostics store', () => {
  it('reads the current runtime root when a managed update changes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-diagnostics-'))
    const dshHome = join(root, 'dsh-home')
    await mkdir(join(dshHome, 'profiles', 'web', 'node_modules', 'plugin-a'), { recursive: true })
    let runtimeRoot = join(root, 'runtime-old')
    const store = new DiagnosticsStore({
      userDataPath: root,
      getRuntimeRoot: () => runtimeRoot,
      dshHome,
      getState: () => ({ status: 'running', version: '0.1.0', port: 3000, url: 'http://127.0.0.1:3000', recoveryAttempt: 0, lastError: null, lastHealthyAt: null }),
    })

    runtimeRoot = join(root, 'runtime-new')

    await expect(store.snapshot()).resolves.toMatchObject({ runtimeRoot, pluginNames: ['plugin-a'] })
  })
})
