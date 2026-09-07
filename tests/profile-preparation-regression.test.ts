import { access, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasMissingProfileDependencies, prepareOfficialWebProfile } from '../src/main/profile-preparation.js'
import { ensureClientStoreCompatibility } from '../src/main/compatibility.js'
import { startAfterProfilePreparation } from '../src/main/startup-sequence.js'

describe('profile preparation regressions', () => {
  it('detects declared profile dependencies missing from node_modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-missing-deps-'))
    const profilePath = join(root, 'profiles', 'web')
    await mkdir(profilePath, { recursive: true })
    await writeFile(join(profilePath, 'package.json'), JSON.stringify({
      dependencies: {
        'dsh-marketing-toolkit': 'file:D:/vibecoding/工作区1/dsh-marketing-toolkit',
        '@deepseek-ai/dsh-client-store': 'file:../../.desktop-compat/dsh-client-store',
      },
    }))
    await mkdir(join(profilePath, 'node_modules', '@deepseek-ai', 'dsh-client-store'), { recursive: true })

    await expect(hasMissingProfileDependencies(profilePath)).resolves.toEqual(['dsh-marketing-toolkit'])
  })

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
      runtimeVersion: '0.1.2-rc.1',
      install: async args => { expect(args).toEqual(['install', '--no-frozen-lockfile']) },
    })
  })

  it('refreshes a stale lockfile when a restored plugin declaration is missing from node_modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-stale-lockfile-'))
    const dshHome = join(root, 'dsh-home')
    const profilePath = join(dshHome, 'profiles', 'web')
    const packagePath = join(profilePath, 'package.json')
    await mkdir(join(profilePath, 'node_modules'), { recursive: true })
    await writeFile(packagePath, JSON.stringify({ dependencies: {
      '@deepseek-ai/dsh-client-store': 'file:../../.desktop-compat/dsh-client-store',
      'restored-plugin': 'file:C:/plugins/restored',
    }, dsh: { profile: { bundles: [] } } }))
    await writeFile(join(profilePath, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    await ensureClientStoreCompatibility({ dshHome, profilePath, packagePath, runtimeVersion: '0.1.2-rc.1' })

    await prepareOfficialWebProfile({
      dshHome,
      profilePath,
      packagePath,
      nodeModulesPresent: true,
      dependencyInstallRequired: true,
      lockfilePresent: true,
      runtimeVersion: '0.1.2-rc.1',
      install: async args => { expect(args).toEqual(['install', '--no-frozen-lockfile']) },
    })
  })

  it('does not activate the legacy client-store bridge for a 0.1.2 runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-static-client-store-'))
    const dshHome = join(root, 'dsh-home')
    const profilePath = join(dshHome, 'profiles', 'web')
    const packagePath = join(profilePath, 'package.json')
    await mkdir(profilePath, { recursive: true })
    await writeFile(packagePath, JSON.stringify({
      dependencies: { '@deepseek-ai/dsh-client-store': 'file:../../.desktop-compat/dsh-client-store' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-client-store'] } },
    }))

    await prepareOfficialWebProfile({
      dshHome,
      profilePath,
      packagePath,
      nodeModulesPresent: false,
      dependencyInstallRequired: false,
      lockfilePresent: false,
      runtimeVersion: '0.1.2-rc.1',
      install: async () => undefined,
    })

    const profile = JSON.parse(await readFile(packagePath, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(profile.dsh.profile.bundles).not.toContain('@deepseek-ai/dsh-client-store')
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
