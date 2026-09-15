import { ensureClientStoreCompatibility } from './compatibility.js'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface PrepareOfficialWebProfileOptions {
  dshHome: string
  profilePath: string
  packagePath: string
  nodeModulesPresent: boolean
  dependencyInstallRequired: boolean
  lockfilePresent: boolean
  runtimeVersion?: string
  install: (args: string[]) => Promise<void>
}

export interface PrepareOfficialWebProfileResult {
  compatibilityChanged: boolean
  rebuiltDependencies: boolean
  /** True when a previous install failed recently and was skipped. */
  installSkipped?: boolean
}

/**
 * A failed dependency install is expensive to retry: pnpm resolves the whole
 * graph over the network before reporting the failure, which delays startup by
 * many seconds on every launch. Remember the failure so a still-broken
 * registry does not get retried on every boot, while the next attempt is
 * allowed once the quiet period elapses.
 */
const INSTALL_FAILURE_TTL_MS = 6 * 60 * 60 * 1000

function installFailureMarkerPath(profilePath: string): string {
  return join(profilePath, '.desktop-install-failed.json')
}

async function readRecentInstallFailure(profilePath: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(installFailureMarkerPath(profilePath), 'utf8')) as unknown
    if (typeof marker !== 'object' || marker === null) return false
    const at = (marker as { at?: unknown }).at
    if (typeof at !== 'number') return false
    return Date.now() - at < INSTALL_FAILURE_TTL_MS
  } catch {
    return false
  }
}

async function recordInstallFailure(profilePath: string): Promise<void> {
  try {
    await writeFile(installFailureMarkerPath(profilePath), JSON.stringify({ at: Date.now() }), 'utf8')
  } catch {
    // A missing marker only costs one extra retry; never fail the boot for it.
  }
}

async function clearInstallFailure(profilePath: string): Promise<void> {
  await rm(installFailureMarkerPath(profilePath), { force: true }).catch(() => undefined)
}

/**
 * Returns declared runtime dependencies whose package directories are absent.
 * A profile can retain a valid lockfile while its materialized tree is
 * incomplete (for example after an interrupted update), so the lockfile alone
 * cannot be used as the startup readiness check.
 */
export async function hasMissingProfileDependencies(profilePath: string): Promise<string[]> {
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(join(profilePath, 'package.json'), 'utf8'))
  } catch {
    return []
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return []
  const dependencies = (manifest as { dependencies?: unknown }).dependencies
  if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) return []
  const nodeModulesPath = join(profilePath, 'node_modules')
  const missing: string[] = []
  for (const name of Object.keys(dependencies as Record<string, unknown>)) {
    try {
      await access(join(nodeModulesPath, ...name.split('/')))
    } catch {
      missing.push(name)
    }
  }
  return missing.sort()
}

/**
 * Makes a migrated Web profile compatible with the supported official runtime.
 * A changed local bridge requires a non-frozen install so pnpm can rewrite the
 * profile lockfile to include the local file dependency.
 */
export async function prepareOfficialWebProfile(
  options: PrepareOfficialWebProfileOptions,
): Promise<PrepareOfficialWebProfileResult> {
  const packageBefore = await readOptional(options.packagePath)
  const lockfilePath = join(dirname(options.packagePath), 'pnpm-lock.yaml')
  const lockfileBefore = await readOptional(lockfilePath)
  let compatibilityChanged = false
  let nodeModulesBackup: string | null = null
  try {
    const compatibility = await ensureClientStoreCompatibility({
      dshHome: options.dshHome,
      profilePath: options.profilePath,
      packagePath: options.packagePath,
      runtimeVersion: options.runtimeVersion,
    })
    compatibilityChanged = compatibility.changed
    const shouldInstall = options.dependencyInstallRequired
      || compatibility.changed
      || !options.nodeModulesPresent
    if (!shouldInstall) return { compatibilityChanged, rebuiltDependencies: false }

    // Skip a retry that recently failed: the registry is unreachable or its
    // metadata is broken, and re-resolving the graph would only delay boot
    // again. The caller keeps whatever complete tree is already on disk — the
    // compatibility files above were already refreshed in place.
    if (await readRecentInstallFailure(options.profilePath)) {
      return { compatibilityChanged, rebuiltDependencies: false, installSkipped: true }
    }

    const args = ['install']
    args.push(options.lockfilePresent && !compatibility.changed && !options.dependencyInstallRequired
      ? '--frozen-lockfile'
      : '--no-frozen-lockfile')

    const nodeModulesPath = join(options.profilePath, 'node_modules')
    if (options.nodeModulesPresent && await pathExists(nodeModulesPath)) {
      nodeModulesBackup = `${nodeModulesPath}.desktop-preparation-${process.pid}-${Date.now()}`
      await rename(nodeModulesPath, nodeModulesBackup)
      await mkdir(nodeModulesPath, { recursive: true })
    }
    await options.install(args)
    if (nodeModulesBackup !== null) {
      await rm(nodeModulesBackup, { recursive: true, force: true })
      nodeModulesBackup = null
    }
    await clearInstallFailure(options.profilePath)
  } catch (error) {
    if (nodeModulesBackup !== null) {
      await rm(join(options.profilePath, 'node_modules'), { recursive: true, force: true })
      await rename(nodeModulesBackup, join(options.profilePath, 'node_modules')).catch(() => undefined)
    }
    await restoreOptional(options.packagePath, packageBefore)
    await restoreOptional(lockfilePath, lockfileBefore)
    await recordInstallFailure(options.profilePath)
    throw error
  }
  return { compatibilityChanged, rebuiltDependencies: true }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function restoreOptional(path: string, content: string | null): Promise<void> {
  if (content === null) {
    await rm(path, { force: true })
    return
  }
  await writeFile(path, content, 'utf8')
}
