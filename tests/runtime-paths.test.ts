import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clearActiveRuntimePointer, createRuntimePaths, resolveActiveRuntime, resolveBundledRuntime } from '../src/main/runtime-paths.js'

describe('bundled runtime mode', () => {
  it('always selects the installation copy even when user data has an update pointer', async () => {
    const root = join(tmpdir(), `dsh-runtime-bundled-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const paths = createRuntimePaths(join(root, 'app'), join(root, 'user-data'))
    await mkdir(join(paths.userRuntimeRoot, 'versions', 'dsh-0.1.2'), { recursive: true })
    await writeFile(paths.pointerPath, JSON.stringify({ root: join(paths.userRuntimeRoot, 'versions', 'dsh-0.1.2'), version: '0.1.2' }))

    expect(resolveBundledRuntime(paths, '0.1.1-rc.2')).toEqual({ root: paths.bundledRoot, version: '0.1.1-rc.2' })
  })
})

describe('runtime pointer recovery', () => {
  it('restores a missing pointer from the failed candidate marker', async () => {
    const root = join(tmpdir(), `dsh-runtime-pointer-recovery-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const userData = join(root, 'user-data')
    const paths = createRuntimePaths(join(root, 'app'), userData)
    const candidate = join(userData, 'runtime', 'versions', 'dsh-0.1.2-rc.1')
    await mkdir(join(candidate, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    await writeFile(join(candidate, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '')
    await mkdir(join(userData, 'runtime'), { recursive: true })
    await writeFile(paths.updateFailurePath as string, JSON.stringify({ version: '0.1.2-rc.1', candidate }))

    await expect(resolveActiveRuntime(paths, '0.1.1-rc.2')).resolves.toEqual({ root: join(root, 'app'), version: '0.1.1-rc.2' })
    await expect(readFile(paths.pointerPath, 'utf8')).resolves.toContain('0.1.2-rc.1')
  })

  it('clears only a valid active pointer so bundled runtime selection is restored', async () => {
    const root = join(tmpdir(), `dsh-runtime-pointer-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const userData = join(root, 'user-data')
    const paths = createRuntimePaths(join(root, 'app'), userData)
    await mkdir(join(userData, 'runtime'), { recursive: true })
    await writeFile(paths.pointerPath, JSON.stringify({ root: join(userData, 'runtime', 'versions', 'bad'), version: '0.1.2-rc.1' }))

    await clearActiveRuntimePointer(paths)

    await expect(access(paths.pointerPath)).rejects.toThrow()
    await expect(readFile(join(userData, 'runtime', 'versions', 'bad'))).rejects.toThrow()
  })
})
