import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repairBundledDependencies } from '../src/main/bundled-dependencies.js'

describe('bundled dependency repair', () => {
  it('installs production dependencies when the worker package is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bundled-repair-'))
    const workerPath = join(root, 'node_modules', '@deepseek-ai', 'dsh-workflow-worker-thread')
    const commands: string[][] = []

    const repaired = await repairBundledDependencies({
      workerPath,
      install: async args => {
      commands.push(args)
        await mkdir(join(workerPath, 'lib'), { recursive: true })
        await writeFile(join(workerPath, 'package.json'), '{}')
        await writeFile(join(workerPath, 'lib', 'index.js'), '')
      },
    })

    expect(repaired).toBe(true)
    expect(commands).toEqual([['install', '--prod', '--no-frozen-lockfile']])
  })

  it('does not reinstall when the worker package is already present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bundled-present-'))
    const workerPath = join(root, 'node_modules', '@deepseek-ai', 'dsh-workflow-worker-thread')
    await mkdir(join(workerPath, 'lib'), { recursive: true })
    await writeFile(join(workerPath, 'package.json'), '{}')
    await writeFile(join(workerPath, 'lib', 'index.js'), '')
    const install = async () => { throw new Error('should not install') }

    await expect(repairBundledDependencies({ workerPath, install })).resolves.toBe(false)
  })
})
