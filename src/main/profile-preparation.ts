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
  install: (args: string[]) => Promise<void>
}

export interface PrepareOfficialWebProfileResult {
  compatibilityChanged: boolean
  rebuiltDependencies: boolean
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
    })
    compatibilityChanged = compatibility.changed
    const shouldInstall = options.dependencyInstallRequired
      || compatibility.changed
      || !options.nodeModulesPresent
    if (!shouldInstall) return { compatibilityChanged, rebuiltDependencies: false }

    const args = ['install']
    args.push(options.lockfilePresent && !compatibility.changed
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
  } catch (error) {
    if (nodeModulesBackup !== null) {
      await rm(join(options.profilePath, 'node_modules'), { recursive: true, force: true })
      await rename(nodeModulesBackup, join(options.profilePath, 'node_modules')).catch(() => undefined)
    }
    await restoreOptional(options.packagePath, packageBefore)
    await restoreOptional(lockfilePath, lockfileBefore)
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
