import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ensureClientStoreCompatibility,
  patchVisionRouterPreludeContent,
  synchronizeInstalledClientStoreCompatibility,
} from '../src/main/compatibility.js'
import { prepareOfficialWebProfile } from '../src/main/profile-preparation.js'

describe('desktop plugin compatibility', () => {
  it('guards Vision Router catalog probing until remote.session is mounted', () => {
    const vulnerable = `function hasHostCatalog(remote) {\n  return !!(\n    remote && remote.session &&\n    typeof remote.session.modelCatalog === 'function'\n  );\n}`

    const patched = patchVisionRouterPreludeContent(vulnerable)

    expect(patched.changed).toBe(true)
    expect(patched.content).toContain('function readRemoteSession(remote)')
    expect(patched.content).not.toContain('remote && remote.session &&')
  })

  it('guards Vision Router catalog calls when the remote namespace is still mounting', () => {
    const vulnerable = `function catalogModels(remote) {\n  return function models() {\n    return Promise.resolve(remote.session.modelCatalog()).then(wrapCatalogResult);\n  };\n}`

    const patched = patchVisionRouterPreludeContent(vulnerable)

    expect(patched.changed).toBe(true)
    expect(patched.content).toContain('var session = readRemoteSession(remote)')
    expect(patched.content).not.toContain('remote.session.modelCatalog()')
  })

  it('keeps remote.session reads safe when the client plugin has no nested inject', () => {
    const vulnerable = `function compatibleRemote(remote) {\n  if (!hasHostCatalog(remote)) return remote;\n  if (!remote || (typeof remote !== 'object' && typeof remote !== 'function')) return remote;\n  return new Proxy(remote, {\n    get: function(target, property) {\n      if (property === '$on') {\n        var subscribe = Reflect.get(target, property, target);\n        if (typeof subscribe !== 'function') return subscribe;\n        return function(event, listener) {\n          var args = Array.prototype.slice.call(arguments);\n          if (event === LEGACY_CREDENTIAL_EVENT) args[0] = HOST_CREDENTIAL_EVENT;\n          return subscribe.apply(target, args);\n        };\n      }\n      var value = Reflect.get(target, property, target);\n      return typeof value === 'function' ? value.bind(target) : value;\n    }\n  });\n}`

    const patched = patchVisionRouterPreludeContent(vulnerable)

    expect(patched.changed).toBe(true)
    expect(patched.content).toContain('var hostCatalog = hasHostCatalog(remote)')
    expect(patched.content).toContain("if (property === 'session') return readRemoteSession(target)")
  })

  it('adds a local dsh-client-store bridge for legacy client plugins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compatibility-'))
    const dshHome = join(root, 'dsh-home')
    const profilePath = join(dshHome, 'profiles', 'web')
    const packagePath = join(profilePath, 'package.json')
    await mkdir(profilePath, { recursive: true })
    await writeFile(packagePath, JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-client-store', 'dsh-vision-router'] } },
    }))
    await ensureClientStoreCompatibility({ dshHome, profilePath, packagePath })

    const profile = JSON.parse(await readFile(packagePath, 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(profile.dependencies['@deepseek-ai/dsh-client-store']).toBe('file:../../.desktop-compat/dsh-client-store')
    expect(profile.dsh.profile.bundles).toContain('@deepseek-ai/dsh-client-store')
    expect(profile.dsh.profile.bundles).toContain('dsh-vision-router')
    await expect(readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'package.json'), 'utf8')).resolves.toContain('@deepseek-ai/dsh-client-store')
    await expect(readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'package.json'), 'utf8')).resolves.toContain('cordis.patch.yml')
    const bridgePackage = JSON.parse(await readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'package.json'), 'utf8')) as {
      exports?: { './client'?: string }
      dsh?: { client?: { platform?: string; immediately?: boolean } }
    }
    expect(bridgePackage.exports?.['./client']).toBe('./client.js')
    expect(bridgePackage.dsh?.client).toMatchObject({ platform: 'web', immediately: true })
    await expect(readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'cordis.patch.yml'), 'utf8')).resolves.toContain("name: '@deepseek-ai/dsh-client-store'")
    await expect(readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'index.js'), 'utf8')).resolves.toContain('export function apply')
    await expect(readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'client.js'), 'utf8')).resolves.not.toContain('@deepseek-ai/dsh-client-runtime/client')
    await expect(readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'client.js'), 'utf8')).resolves.toContain('plugin.apply = () => {}')
    await expect(readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'client.js'), 'utf8')).resolves.toContain('const createSnapshotStore')
    await expect(readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'client.js'), 'utf8')).resolves.not.toContain('return runtime')
    await expect(readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'client.js'), 'utf8')).resolves.not.toContain('apply:')
  })

  it('matches the official host-plugin shape with only a named apply export', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compatibility-export-'))
    const dshHome = join(root, 'dsh-home')
    const profilePath = join(dshHome, 'profiles', 'web')
    await ensureClientStoreCompatibility({ dshHome, profilePath })

    const indexPath = join(dshHome, '.desktop-compat', 'dsh-client-store', 'index.js')
    const loaded = await import(`${pathToFileURL(indexPath).href}?test=${Date.now()}`) as {
      apply?: unknown
      default?: unknown
    }
    expect(loaded.apply).toEqual(expect.any(Function))
    expect(loaded.default).toBeUndefined()
  })

  it('does not add a host entry when the runtime already has a static client-store module', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compatibility-static-'))
    const dshHome = join(root, 'dsh-home')
    const profilePath = join(dshHome, 'profiles', 'web')
    const packagePath = join(profilePath, 'package.json')
    await mkdir(profilePath, { recursive: true })
    await writeFile(packagePath, JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-client-store', 'dsh-vision-router'] } },
    }))

    await ensureClientStoreCompatibility({ dshHome, profilePath, packagePath, runtimeVersion: '0.1.2-rc.1' })

    const profile = JSON.parse(await readFile(packagePath, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(profile.dsh.profile.bundles).not.toContain('@deepseek-ai/dsh-client-store')
    const bridgePackage = JSON.parse(await readFile(join(dshHome, '.desktop-compat', 'dsh-client-store', 'package.json'), 'utf8')) as {
      dsh?: unknown
    }
    expect(bridgePackage.dsh).toBeUndefined()
  })

  it('exposes a directly mountable browser plugin from the compatibility factory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compatibility-browser-plugin-'))
    const dshHome = join(root, 'dsh-home')
    const profilePath = join(dshHome, 'profiles', 'web')
    await ensureClientStoreCompatibility({ dshHome, profilePath })
    const clientPath = join(dshHome, '.desktop-compat', 'dsh-client-store', 'client.js')
    const source = await readFile(clientPath, 'utf8')
    let registration: { factory: (require: (specifier: string) => unknown) => unknown } | undefined
    const context = { window: { __ModuleLoader__: { load: (value: typeof registration) => { registration = value } } } }
    // Evaluate only the registration wrapper; no browser globals are needed
    // to validate the module shape consumed by the client Loader.
    const vm = await import('node:vm')
    vm.runInNewContext(source, context)
    const plugin = registration?.factory(() => undefined)
    expect(typeof plugin).toBe('function')
    expect(typeof (plugin as { apply?: unknown }).apply).toBe('function')
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
