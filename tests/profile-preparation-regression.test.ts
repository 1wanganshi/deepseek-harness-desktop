import { access, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareOfficialWebProfile } from '../src/main/profile-preparation.js'
import { startAfterProfilePreparation } from '../src/main/startup-sequence.js'

describe('profile preparation regressions', () => {
  it('does not start Harness until profile preparation has settled', async () => {
    const events: string[] = []
    const preparation = (async () => {
      events.push('prepare')
      await Promise.resolve()
      events.push('prepared')
    })()

    const result = await startAfterProfilePreparation(preparation, async () => {
      events.push('start')
      return 'running'
    })

    expect(result).toBe('running')
    expect(events).toEqual(['prepare', 'prepared', 'start'])
  })

  it('does not force-rebuild an existing profile during startup repair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-no-force-'))
    const dshHome = join(root, 'dsh-home')
    const profilePath = join(dshHome, 'profiles', 'web')
    const packagePath = join(profilePath, 'package.json')
    await mkdir(profilePath, { recursive: true })
    await writeFile(packagePath, JSON.stringify({ dependencies: {} }))
    await prepareOfficialWebProfile({
      dshHome,
      profilePath,
      packagePath,
      nodeModulesPresent: true,
      dependencyInstallRequired: true,
      lockfilePresent: true,
      install: async args => { expect(args).toEqual(['install', '--no-frozen-lockfile']) },
    })
  })

  it('restores the existing profile when dependency installation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-rollback-'))
    const dshHome = join(root, 'dsh-home')
    const profilePath = join(dshHome, 'profiles', 'web')
    const packagePath = join(profilePath, 'package.json')
    const lockPath = join(profilePath, 'pnpm-lock.yaml')
    const originalPackage = JSON.stringify({ dependencies: { 'existing-plugin': '1.0.0' } }, null, 2) + '\n'
    const originalLock = 'lockfileVersion: 9.0\n'
    await mkdir(profilePath, { recursive: true })
    await writeFile(packagePath, originalPackage)
    await writeFile(lockPath, originalLock)
    const modulesPath = join(profilePath, 'node_modules')
    await mkdir(modulesPath, { recursive: true })
    await writeFile(join(modulesPath, 'existing-plugin.txt'), 'old dependency tree')

    await expect(prepareOfficialWebProfile({
      dshHome,
      profilePath,
      packagePath,
      nodeModulesPresent: true,
      dependencyInstallRequired: true,
      lockfilePresent: true,
      install: async () => {
        await writeFile(packagePath, 'partially rewritten')
        await writeFile(lockPath, 'partially rewritten')
        await rename(modulesPath, `${modulesPath}.partial`)
        await mkdir(modulesPath, { recursive: true })
        await writeFile(join(modulesPath, 'broken-plugin.txt'), 'partial dependency tree')
        throw new Error('network unavailable')
      },
    })).rejects.toThrow('network unavailable')

    await expect(readFile(packagePath, 'utf8')).resolves.toBe(originalPackage)
    await expect(readFile(lockPath, 'utf8')).resolves.toBe(originalLock)
    await expect(readFile(join(modulesPath, 'existing-plugin.txt'), 'utf8')).resolves.toBe('old dependency tree')
    await expect(access(join(modulesPath, 'broken-plugin.txt'))).rejects.toThrow()
    await expect(access(join(profilePath, 'package.json'))).resolves.toBeUndefined()
  })
})
