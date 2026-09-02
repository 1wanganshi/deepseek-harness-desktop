import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

type JsonRecord = Record<string, unknown>

export interface ClientStoreCompatibilityOptions {
  dshHome: string
  profilePath: string
  packagePath?: string
}

export interface ClientStoreCompatibilityResult {
  changed: boolean
  packagePath: string
  compatibilityPath: string
}

const PACKAGE_NAME = '@deepseek-ai/dsh-client-store'
const PACKAGE_SPECIFIER = 'file:../../.desktop-compat/dsh-client-store'
const PACKAGE_VERSION = '0.0.0-desktop-compat'

const compatibilityPackage = {
  name: PACKAGE_NAME,
  version: PACKAGE_VERSION,
  private: true,
  type: 'module',
  main: 'index.js',
  files: ['index.js', 'client.js', 'cordis.patch.yml'],
  exports: {
    '.': './index.js',
    './client': './client.js',
    './package.json': './package.json',
  },
  dsh: {
    bundle: {
      patch: './cordis.patch.yml',
    },
    client: {
      platform: 'web',
      immediately: true,
      inject: ['@deepseek-ai/dsh-client-runtime'],
    },
  },
}

const compatibilityIndex = `export function apply() {\n  // The browser face is provided by client.js; the host face is intentionally inert.\n}\n`
const compatibilityPatch = `# The desktop bridge has no host-side behavior, but it must be an active
# Loader entry so dsh-client-modules can discover and serve its browser bundle.
- insert:
    - id: dsh-client-store-compat
      name: '${PACKAGE_NAME}'
`

const compatibilityClient = `window.__ModuleLoader__.load({
  id: "${PACKAGE_NAME}",
  factory: (require) => {
    const runtime = require("@deepseek-ai/dsh-client-runtime/client");
    return {
      apply() {},
      createSnapshotStore: runtime.createSnapshotStore,
      defineStore: runtime.defineStore,
      shallowEqual: runtime.shallowEqual,
    };
  },
});
`

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeProfileManifest(input: JsonRecord): JsonRecord {
  const dependencies = isRecord(input.dependencies) ? { ...input.dependencies } : {}
  dependencies[PACKAGE_NAME] = PACKAGE_SPECIFIER

  const dsh = isRecord(input.dsh) ? input.dsh : {}
  const profile = isRecord(dsh.profile) ? dsh.profile : {}
  const bundles = Array.isArray(profile.bundles)
    ? profile.bundles.filter((name): name is string => typeof name === 'string')
    : []
  if (!bundles.includes(PACKAGE_NAME)) bundles.push(PACKAGE_NAME)

  return {
    ...input,
    dependencies,
    dsh: { ...dsh, profile: { ...profile, bundles } },
  }
}

async function readJson(path: string): Promise<JsonRecord> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function writeIfChanged(path: string, content: string): Promise<boolean> {
  try {
    if (await readFile(path, 'utf8') === content) return false
  } catch {
    // The file will be created below.
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
  return true
}

export async function ensureClientStoreCompatibility(options: ClientStoreCompatibilityOptions): Promise<ClientStoreCompatibilityResult> {
  const packagePath = options.packagePath ?? join(options.profilePath, 'package.json')
  const compatibilityPath = join(options.dshHome, '.desktop-compat', 'dsh-client-store')
  const currentProfile = await readJson(packagePath)
  const nextProfile = mergeProfileManifest(currentProfile)
  const profileContent = `${JSON.stringify(nextProfile, null, 2)}\n`
  const packageContent = `${JSON.stringify(compatibilityPackage, null, 2)}\n`
  const changedProfile = await writeIfChanged(packagePath, profileContent)
  const changedPackage = await writeIfChanged(join(compatibilityPath, 'package.json'), packageContent)
  const changedIndex = await writeIfChanged(join(compatibilityPath, 'index.js'), compatibilityIndex)
  const changedPatch = await writeIfChanged(join(compatibilityPath, 'cordis.patch.yml'), compatibilityPatch)
  const changedClient = await writeIfChanged(join(compatibilityPath, 'client.js'), compatibilityClient)
  return {
    changed: changedProfile || changedPackage || changedIndex || changedPatch || changedClient,
    packagePath,
    compatibilityPath,
  }
}

/**
 * Refreshes the files of a local `file:` dependency after pnpm has already
 * materialized it. pnpm can retain an older copy when only package metadata or
 * non-JavaScript assets changed; the DSH loader reads the profile copy, so the
 * bridge files must be synchronized explicitly.
 */
export async function synchronizeInstalledClientStoreCompatibility(options: Pick<ClientStoreCompatibilityOptions, 'dshHome' | 'profilePath'>): Promise<boolean> {
  const sourcePath = join(options.dshHome, '.desktop-compat', 'dsh-client-store')
  const targetPath = join(options.profilePath, 'node_modules', '@deepseek-ai', 'dsh-client-store')
  try {
    await readFile(join(targetPath, 'package.json'), 'utf8')
  } catch {
    return false
  }

  for (const file of ['package.json', 'index.js', 'client.js', 'cordis.patch.yml']) {
    await copyFile(join(sourcePath, file), join(targetPath, file))
  }
  return true
}
