import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureClientStoreCompatibility, synchronizeInstalledClientStoreCompatibility } from '../src/main/compatibility.js'
import { prepareOfficialWebProfile } from '../src/main/profile-preparation.js'

describe('desktop plugin compatibility', () => {
  it('adds a local dsh-client-store bridge for legacy client plugins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compatibility-'))
    const dshHome = join(root, 'dsh-home')
    const profilePath = join(dshHome, 'profiles', 'web')
    const packagePath = join(profilePath, 'package.json')
    await ensureClientStoreCompatibility({ dshHome, profilePath, packagePath })

    const profile = JSON.parse(await readFile(packagePath, 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(profile.dependencies['@deepseek-ai/dsh-client-store']).toBe('file:../../.desktop-compat/dsh-client-store')
    expect(profile.dsh.profile.bundles).toContain('@deepseek-ai/dsh-client-store')
    await expect(readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'package.json'), 'utf8')).resolves.toContain('@deepseek-ai/dsh-client-store')
    await expect(readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'package.json'), 'utf8')).resolves.toContain('cordis.patch.yml')
    await expect(readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'package.json'), 'utf8')).resolves.toContain('"immediately": true')
    await expect(readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'cordis.patch.yml'), 'utf8')).resolves.toContain("name: '@deepseek-ai/dsh-client-store'")
    await expect(readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'index.js'), 'utf8')).resolves.toContain('export function apply')
    await expect(readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'client.js'), 'utf8')).resolves.toContain('@deepseek-ai/dsh-client-runtime/client')
    await expect(readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'client.js'), 'utf8')).resolves.toContain('apply() {}')
    await expect(readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'client.js'), 'utf8')).resolves.toContain('createSnapshotStore: runtime.createSnapshotStore')
    await expect(readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'client.js'), 'utf8')).resolves.not.toContain('return runtime')
    await expect(readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'client.js'), 'utf8')).resolves.not.toContain('apply:')
  })

  it('is idempotent and does not duplicate the compatibility bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compatibility-idempotent-'))
    const dshHome = join(root, 'dsh-home')
    const profilePath = join(dshHome, 'profiles', 'web')
    const packagePath = join(profilePath, 'package.json')

    const first = await ensureClientStoreCompatibility({ dshHome, profilePath, packagePath })
    const second = await ensureClientStoreCompatibility({ dshHome, profilePath, packagePath })
    const profile = JSON.parse(await readFile(packagePath, 'utf8')) as { dsh: { profile: { bundles: string[] } } }

    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(profile.dsh.profile.bundles.filter(name => name === '@deepseek-ai/dsh-client-store')).toHaveLength(1)
    await expect(access(join(dshHome, '.desktop-compat', 'dsh-client-store', 'client.js'))).resolves.toBeUndefined()
  })

  it('rebuilds dependencies with a mutable lock when the bridge is newly added', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compatibility-install-'))
    const dshHome = join(root, 'dsh-home')
    const profilePath = join(dshHome, 'profiles', 'web')
    const packagePath = join(profilePath, 'package.json')
    await mkdir(profilePath, { recursive: true })
    await writeFile(packagePath, JSON.stringify({ dependencies: { 'dsh-plugin-example': '1.0.0' } }))
    const installArgs: string[][] = []

    await prepareOfficialWebProfile({
      dshHome,
      profilePath,
      packagePath,
      nodeModulesPresent: true,
      dependencyInstallRequired: false,
      lockfilePresent: true,
      install: async args => { installArgs.push(args) },
    })

    expect(installArgs).toEqual([['install', '--no-frozen-lockfile']])
  })

  it('requires a rebuild when the installed bridge is missing its patch file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compatibility-incomplete-'))
    const dshHome = join(root, 'dsh-home')
    const profilePath = join(dshHome, 'profiles', 'web')
    const packagePath = join(profilePath, 'package.json')
    await mkdir(profilePath, { recursive: true })
    await writeFile(packagePath, JSON.stringify({ dependencies: {} }))
    const installArgs: string[][] = []

    await prepareOfficialWebProfile({
      dshHome,
      profilePath,
      packagePath,
      nodeModulesPresent: true,
      dependencyInstallRequired: true,
      lockfilePresent: true,
      install: async args => { installArgs.push(args) },
    })

    expect(installArgs).toEqual([['install', '--no-frozen-lockfile']])
  })

  it('repairs an existing profile without forcing pnpm to rebuild every package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compatibility-force-'))
    const dshHome = join(root, 'dsh-home')
    const profilePath = join(dshHome, 'profiles', 'web')
    const packagePath = join(profilePath, 'package.json')
    await mkdir(profilePath, { recursive: true })
    await writeFile(packagePath, JSON.stringify({ dependencies: {} }))
    const installArgs: string[][] = []

    await prepareOfficialWebProfile({
      dshHome,
      profilePath,
      packagePath,
      nodeModulesPresent: true,
      dependencyInstallRequired: true,
      lockfilePresent: true,
      install: async args => { installArgs.push(args) },
    })

    expect(installArgs).toEqual([['install', '--no-frozen-lockfile']])
  })

  it('synchronizes every compatibility file into the installed local package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compatibility-sync-'))
    const dshHome = join(root, 'dsh-home')
    const profilePath = join(dshHome, 'profiles', 'web')
    const installed = join(profilePath, 'node_modules', '@deepseek-ai', 'dsh-client-store')
    await ensureClientStoreCompatibility({ dshHome, profilePath })
    await mkdir(installed, { recursive: true })
    await writeFile(join(installed, 'package.json'), '{}')

    await synchronizeInstalledClientStoreCompatibility({ dshHome, profilePath })

    await expect(readFile(join(installed, 'package.json'), 'utf8')).resolves.toContain('cordis.patch.yml')
    await expect(readFile(join(installed, 'cordis.patch.yml'), 'utf8')).resolves.toContain('name:')
    await expect(readFile(join(installed, 'client.js'), 'utf8')).resolves.toContain('__ModuleLoader__')
  })
})
