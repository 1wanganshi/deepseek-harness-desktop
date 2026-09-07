import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { isHealthyHarnessDocument, validateDshRuntime } from '../src/main/runtime-health.js'

describe('runtime health validation', () => {
  it('rejects the official failure screen instead of treating HTTP 200 as healthy', () => {
    expect(isHealthyHarnessDocument(200, 'HARNESS\nFailed to load plugins\ninvalid plugin')).toBe(false)
    expect(isHealthyHarnessDocument(200, '<html>Harness</html>')).toBe(true)
  })

  it('starts the validator with the supplied isolated DSH_HOME', async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(),
      pid: 1234,
    })
    let launchEnv: NodeJS.ProcessEnv | undefined

    const result = await validateDshRuntime({
      runtimeRoot: 'C:/candidate-runtime',
      nodeExecutable: 'node',
      dshHome: 'C:/candidate-home',
      useProvidedHome: true,
      findAvailablePortImpl: async () => 32123,
      spawnImpl: ((_: string, __: string[], options: { env?: NodeJS.ProcessEnv }) => {
        launchEnv = options.env
        return child
      }) as never,
      fetchImpl: async () => new Response('', { status: 200 }),
    })

    expect(result).toBe(true)
    expect(launchEnv?.DSH_HOME).toBe('C:/candidate-home')
    expect(child.kill).toHaveBeenCalled()
  })

  it('prepares the isolated profile before checking static client-store collisions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-health-candidate-'))
    const runtimeRoot = join(root, 'runtime')
    const dshHome = join(root, 'home')
    await mkdir(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
    await writeFile(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ version: '0.1.2-rc.1' }))
    await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
    await writeFile(join(dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-client-store'] } } }))
    const child = Object.assign(new EventEmitter(), { exitCode: null, kill: vi.fn(), pid: 1234 })
    let prepared = false

    try {
      const result = await validateDshRuntime({
        runtimeRoot,
        nodeExecutable: 'node',
        dshHome,
        useProvidedHome: true,
        findAvailablePortImpl: async () => 32124,
        prepareValidationHome: async validationHome => {
          prepared = true
          const profilePath = join(validationHome, 'profiles', 'web')
          const profile = JSON.parse(await readFile(join(profilePath, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
          profile.dsh.profile.bundles = []
          await writeFile(join(profilePath, 'package.json'), JSON.stringify(profile))
        },
        spawnImpl: ((_: string, __: string[], options: { env?: NodeJS.ProcessEnv }) => {
          expect(options.env?.DSH_HOME).toBe(dshHome)
          return child
        }) as never,
        fetchImpl: async () => new Response('', { status: 200 }),
      })

      expect(result).toBe(true)
      expect(prepared).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
