import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import YAML from 'yaml'

export type LegacyMigrationState = 'not-found' | 'migrated' | 'already-migrated' | 'failed'

export interface LegacyMigrationStatus {
  status: LegacyMigrationState
  legacyHome: string
  targetHome: string
  backupPath: string | null
  migratedAt: string | null
  pluginNames: string[]
  copiedPaths: string[]
  error: string | null
}

export interface LegacyMigrationOptions {
  legacyHome: string
  targetHome: string
  backupRoot: string
}

const markerName = '.desktop-migration.json'

const excludedTopLevelDirectories = new Set(['cache', 'logs', 'profiles'])
const excludedTopLevelFiles = new Set([
  'fix-dsh-lock.ps1',
  'start-dsh-web.ps1',
  'web-err.log',
  'web-out.log',
  'web-url.txt',
])

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeSettings(target: unknown, source: unknown): unknown {
  if (!isRecord(target) || !isRecord(source)) return source
  const merged: JsonRecord = { ...target }
  for (const [key, value] of Object.entries(source)) {
    merged[key] = key in merged ? mergeSettings(merged[key], value) : value
  }
  return merged
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function copyTree(source: string, target: string, filter?: (path: string) => boolean): Promise<void> {
  const sourceStat = await stat(source)
  await mkdir(dirname(target), { recursive: true })
  if (sourceStat.isDirectory()) {
    await cp(source, target, {
      recursive: true,
      force: true,
      filter: filter === undefined ? undefined : sourcePath => filter(sourcePath),
    })
    return
  }
  await cp(source, target, { force: true })
}

function sourceBackupFilter(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  return !normalized.includes('/node_modules/')
    && !normalized.endsWith('/node_modules')
    && !normalized.includes('/cache/')
    && !normalized.endsWith('/cache')
    && !normalized.includes('/logs/')
    && !normalized.endsWith('/logs')
    && !basename(normalized).startsWith('_backup')
}

function profileFilter(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  const name = basename(normalized)
  return !normalized.includes('/node_modules/')
    && !normalized.endsWith('/node_modules')
    && !name.endsWith('.bak')
    && !name.includes('.bak-')
}

async function parseYamlFile(path: string): Promise<unknown> {
  const parsed = YAML.parse(await readFile(path, 'utf8'))
  return parsed ?? {}
}

async function writeYamlAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.desktop-migration-${process.pid}.tmp`
  await writeFile(temporaryPath, YAML.stringify(value), 'utf8')
  await rename(temporaryPath, path)
}

async function mergeSettingsFiles(targetPath: string, sourcePath: string): Promise<void> {
  const source = await parseYamlFile(sourcePath)
  const target = await pathExists(targetPath) ? await parseYamlFile(targetPath) : {}
  await mkdir(dirname(targetPath), { recursive: true })
  await writeYamlAtomically(targetPath, mergeSettings(target, source))
}

async function readJsonFile(path: string): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!isRecord(parsed)) throw new Error(`${basename(path)} must contain a JSON object`)
  return parsed
}

function profileBundles(value: JsonRecord): string[] {
  const dsh = isRecord(value.dsh) ? value.dsh : {}
  const profile = isRecord(dsh.profile) ? dsh.profile : {}
  return Array.isArray(profile.bundles)
    ? profile.bundles.filter((bundle): bundle is string => typeof bundle === 'string')
    : []
}

function withProfileBundles(target: JsonRecord, source: JsonRecord): JsonRecord {
  const merged = mergeSettings(target, source) as JsonRecord
  const targetBundleNames = profileBundles(target)
  const sourceBundleNames = profileBundles(source)
  const bundles = [...new Set([...targetBundleNames, ...sourceBundleNames])]
  const dsh = isRecord(merged.dsh) ? merged.dsh : {}
  const profile = isRecord(dsh.profile) ? dsh.profile : {}
  merged.dsh = { ...dsh, profile: { ...profile, bundles } }
  return merged
}

async function mergeProfilePackage(targetPath: string, sourcePath: string): Promise<string[]> {
  const source = await readJsonFile(sourcePath)
  const target = await pathExists(targetPath) ? await readJsonFile(targetPath) : {}
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, `${JSON.stringify(withProfileBundles(target, source), null, 2)}\n`, 'utf8')
  return Object.keys(isRecord(source.dependencies) ? source.dependencies : {}).sort()
}

async function readMarker(path: string): Promise<LegacyMigrationStatus | null> {
  try {
    const marker = await readJsonFile(path)
    if (marker.status !== 'migrated') return null
    return {
      status: 'already-migrated',
      legacyHome: typeof marker.legacyHome === 'string' ? marker.legacyHome : '',
      targetHome: typeof marker.targetHome === 'string' ? marker.targetHome : dirname(path),
      backupPath: typeof marker.backupPath === 'string' ? marker.backupPath : null,
      migratedAt: typeof marker.migratedAt === 'string' ? marker.migratedAt : null,
      pluginNames: Array.isArray(marker.pluginNames) ? marker.pluginNames.filter((name): name is string => typeof name === 'string') : [],
      copiedPaths: Array.isArray(marker.copiedPaths) ? marker.copiedPaths.filter((name): name is string => typeof name === 'string') : [],
      error: null,
    }
  } catch {
    return null
  }
}

async function makeBackupPath(root: string): Promise<string> {
  await mkdir(root, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  let candidate = join(root, stamp)
  let suffix = 1
  while (await pathExists(candidate)) candidate = join(root, `${stamp}-${suffix++}`)
  await mkdir(candidate, { recursive: true })
  return candidate
}

async function migrateUserData(legacyHome: string, targetHome: string): Promise<string[]> {
  const copiedPaths: string[] = []
  for (const entry of await readdir(legacyHome, { withFileTypes: true })) {
    if (entry.name === 'profiles' || entry.name === 'cache' || entry.name === 'logs' || entry.name.startsWith('_backup')) continue
    if (entry.isDirectory()) {
      await copyTree(join(legacyHome, entry.name), join(targetHome, entry.name))
      copiedPaths.push(entry.name)
      continue
    }
    if (excludedTopLevelFiles.has(entry.name) || entry.name.includes('.test-backup') || entry.name.includes('.bak-')) continue
    await copyTree(join(legacyHome, entry.name), join(targetHome, entry.name))
    copiedPaths.push(entry.name)
  }

  const legacyProfiles = join(legacyHome, 'profiles')
  if (await pathExists(legacyProfiles)) {
    for (const entry of await readdir(legacyProfiles, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      if (entry.name === 'web') {
        await copyTree(join(legacyProfiles, entry.name), join(targetHome, 'profiles', entry.name), path => profileFilter(path) && basename(path).toLowerCase() !== 'package.json')
        copiedPaths.push(join('profiles', entry.name))
        continue
      }
      await copyTree(join(legacyProfiles, entry.name), join(targetHome, 'profiles', entry.name), profileFilter)
      copiedPaths.push(join('profiles', entry.name))
    }
  }
  return copiedPaths
}

async function restoreTarget(targetHome: string, targetBackup: string | null, targetExisted: boolean): Promise<void> {
  await rm(targetHome, { recursive: true, force: true })
  if (targetExisted && targetBackup !== null) await copyTree(targetBackup, targetHome)
}

export async function migrateLegacyDsh(options: LegacyMigrationOptions): Promise<LegacyMigrationStatus> {
  const legacyHome = resolve(options.legacyHome)
  const targetHome = resolve(options.targetHome)
  const markerPath = join(targetHome, markerName)
  const existing = await readMarker(markerPath)
  if (existing !== null) return existing
  if (!(await pathExists(legacyHome))) {
    return { status: 'not-found', legacyHome, targetHome, backupPath: null, migratedAt: null, pluginNames: [], copiedPaths: [], error: null }
  }
  if (legacyHome === targetHome) {
    return { status: 'failed', legacyHome, targetHome, backupPath: null, migratedAt: null, pluginNames: [], copiedPaths: [], error: 'Legacy and target DSH_HOME must be different' }
  }

  const backupPath = await makeBackupPath(options.backupRoot)
  const targetExisted = await pathExists(targetHome)
  const targetBackup = targetExisted ? join(backupPath, 'target') : null
  try {
    await copyTree(legacyHome, join(backupPath, 'legacy'), sourceBackupFilter)
    if (targetExisted && targetBackup !== null) await copyTree(targetHome, targetBackup)
    await mkdir(targetHome, { recursive: true })

    const sourceSettings = join(legacyHome, 'settings.yaml')
    if (await pathExists(sourceSettings)) await mergeSettingsFiles(join(targetHome, 'settings.yaml'), sourceSettings)
    const sourceCredentials = join(legacyHome, '.credentials.yaml')
    if (await pathExists(sourceCredentials)) await copyTree(sourceCredentials, join(targetHome, '.credentials.yaml'))
    const copiedPaths = await migrateUserData(legacyHome, targetHome)

    const sourcePackage = join(legacyHome, 'profiles', 'web', 'package.json')
    const targetPackage = join(targetHome, 'profiles', 'web', 'package.json')
    const pluginNames = await pathExists(sourcePackage)
      ? await mergeProfilePackage(targetPackage, sourcePackage)
      : []
    await writeFile(`${markerPath}.tmp`, `${JSON.stringify({
      status: 'migrated',
      legacyHome,
      targetHome,
      backupPath,
      migratedAt: new Date().toISOString(),
      pluginNames,
      copiedPaths,
    }, null, 2)}\n`, 'utf8')
    await rename(`${markerPath}.tmp`, markerPath)
    return { status: 'migrated', legacyHome, targetHome, backupPath, migratedAt: new Date().toISOString(), pluginNames, copiedPaths, error: null }
  } catch (error) {
    await restoreTarget(targetHome, targetBackup, targetExisted)
    return {
      status: 'failed',
      legacyHome,
      targetHome,
      backupPath,
      migratedAt: null,
      pluginNames: [],
      copiedPaths: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
