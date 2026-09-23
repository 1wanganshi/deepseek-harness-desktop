import { ensureClientStoreCompatibility } from './compatibility.js'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Bundles that ship with DSH itself and must never be pruned from a profile. */
const OFFICIAL_BUNDLE_PREFIX = '@deepseek-ai/'

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
 * Remove profile `bundles` entries whose package cannot be resolved.
 *
 * DSH boots a profile by resolving every name in `dsh.profile.bundles`; a name
 * that resolves to neither the DSH installation nor the profile's
 * `node_modules` aborts the whole boot with
 * `cannot resolve profile bundle "<name>"`. That is exactly what a half-finished
 * plugin install leaves behind: an installer that copies a package into
 * `.vendor/` and adds its manifest entry, but whose `pnpm install` step fails
 * (for example when `pnpm` is not on `PATH`), produces a profile that can no
 * longer start at all — the user sees the app stuck in auto-recovery with no
 * way back short of manual repair.
 *
 * A missing plugin is not a reason to refuse to boot. Prune the unresolvable
 * entries, keep a byte-exact backup of `package.json` next to it, and let the
 * runtime come up with the remaining plugins. The `dependencies` entry is kept
 * so a later successful install restores the bundle without re-editing files.
 *
 * Official `@deepseek-ai/*` bundles are never pruned: they resolve from the DSH
 * installation rather than the profile, so a missing profile directory says
 * nothing about them, and dropping one would disable core functionality.
 */
export interface PruneUnresolvableBundlesResult {
  changed: boolean
  pruned: string[]
  backupPath: string | null
}

export async function pruneUnresolvableBundles(profilePath: string): Promise<PruneUnresolvableBundlesResult> {
  const packagePath = join(profilePath, 'package.json')
  let manifest: Record<string, unknown>
  let raw: string
  try {
    raw = await readFile(packagePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { changed: false, pruned: [], backupPath: null }
    }
    manifest = parsed as Record<string, unknown>
  } catch {
    return { changed: false, pruned: [], backupPath: null }
  }

  const dsh = asRecord(manifest.dsh)
  const profile = asRecord(dsh.profile)
  const bundles = Array.isArray(profile.bundles) ? profile.bundles : null
  if (bundles === null) return { changed: false, pruned: [], backupPath: null }

  const dependencies = asRecord(manifest.dependencies)
  const resolvable: unknown[] = []
  const pruned: string[] = []
  for (const entry of bundles) {
    if (typeof entry !== 'string') {
      resolvable.push(entry)
      continue
    }
    if (entry.startsWith(OFFICIAL_BUNDLE_PREFIX) || await isResolvablePackage(profilePath, entry)) {
      resolvable.push(entry)
      continue
    }
    pruned.push(entry)
  }
  if (pruned.length === 0) return { changed: false, pruned: [], backupPath: null }
  // A dependency that no longer appears in `bundles` is harmless to keep, but a
  // `file:` dependency whose directory is gone breaks `pnpm install` outright
  // (ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND). Drop those too.
  for (const name of pruned) {
    const spec = dependencies[name]
    if (typeof spec === 'string' && spec.startsWith('file:') && !await isResolvablePackage(profilePath, name)) {
      delete dependencies[name]
    }
  }

  const next = { ...manifest, dsh: { ...dsh, profile: { ...profile, bundles: resolvable } } }
  const backupPath = `${packagePath}.before-bundle-prune-${Date.now()}-${process.pid}`
  try {
    await writeFile(backupPath, raw, 'utf8')
    await writeFile(packagePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch {
    return { changed: false, pruned: [], backupPath: null }
  }
  return { changed: true, pruned, backupPath }
}

async function isResolvablePackage(profilePath: string, name: string): Promise<boolean> {
  try {
    await access(join(profilePath, 'node_modules', ...name.split('/'), 'package.json'))
    return true
  } catch {
    return false
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
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
