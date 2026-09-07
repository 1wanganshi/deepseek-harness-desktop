import { access, cp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import YAML from 'yaml'

type RecordValue = Record<string, unknown>

export interface ConfigurationDurabilityReport {
  captured: boolean
  restored: Array<'credentials' | 'models' | 'plugins'>
  snapshotPath: string
}

export interface ConfigurationDurabilityOptions {
  dshHome: string
  backupRoot: string
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeMissing(target: unknown, source: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(source)) {
    const merged = [...target]
    for (const entry of source) {
      const id = isRecord(entry) && typeof entry.id === 'string' ? entry.id : null
      const exists = id === null
        ? merged.some(value => JSON.stringify(value) === JSON.stringify(entry))
        : merged.some(value => isRecord(value) && value.id === id)
      if (!exists) merged.push(entry)
    }
    return merged
  }
  if (!isRecord(target) || !isRecord(source)) return target
  const merged: RecordValue = { ...target }
  for (const [key, value] of Object.entries(source)) {
    merged[key] = key in merged ? mergeMissing(merged[key], value) : value
  }
  return merged
}

function profileBundles(value: RecordValue): string[] {
  const dsh = isRecord(value.dsh) ? value.dsh : {}
  const profile = isRecord(dsh.profile) ? dsh.profile : {}
  return Array.isArray(profile.bundles) ? profile.bundles.filter((bundle): bundle is string => typeof bundle === 'string') : []
}

function mergeProfile(target: RecordValue, source: RecordValue): RecordValue {
  const merged = mergeMissing(target, source) as RecordValue
  const bundles = [...new Set([...profileBundles(target), ...profileBundles(source)])]
  const dsh = isRecord(merged.dsh) ? merged.dsh : {}
  const profile = isRecord(dsh.profile) ? dsh.profile : {}
  return { ...merged, dsh: { ...dsh, profile: { ...profile, bundles } } }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function nonEmptyFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0
  } catch {
    return false
  }
}

async function readYaml(path: string): Promise<unknown> {
  return YAML.parse(await readFile(path, 'utf8')) ?? {}
}

async function readJson(path: string): Promise<RecordValue> {
  return JSON.parse(await readFile(path, 'utf8')) as RecordValue
}

async function writeAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.desktop-durability-${process.pid}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}

/**
 * Keeps a local, last-known-good copy of user-owned model, credential, and
 * profile declarations. Recovery is additive: a desktop selection or newer
 * model is never overwritten by an older snapshot.
 */
export class ConfigurationDurabilityGuard {
  private readonly dshHome: string
  private readonly snapshotPath: string

  constructor(options: ConfigurationDurabilityOptions) {
    this.dshHome = options.dshHome
    this.snapshotPath = join(options.backupRoot, 'current')
  }

  async protect(): Promise<ConfigurationDurabilityReport> {
    const restored: ConfigurationDurabilityReport['restored'] = []
    const liveSettings = join(this.dshHome, 'settings.yaml')
    const savedSettings = join(this.snapshotPath, 'settings.yaml')
    const liveCredentials = join(this.dshHome, '.credentials.yaml')
    const savedCredentials = join(this.snapshotPath, '.credentials.yaml')
    const liveProfile = join(this.dshHome, 'profiles', 'web', 'package.json')
    const savedProfile = join(this.snapshotPath, 'profiles', 'web', 'package.json')

    if (await exists(savedSettings)) {
      const source = await readYaml(savedSettings)
      const target = await exists(liveSettings) ? await readYaml(liveSettings) : {}
      const merged = mergeMissing(target, source)
      if (JSON.stringify(merged) !== JSON.stringify(target)) {
        await writeAtomically(liveSettings, YAML.stringify(merged))
        restored.push('models')
      }
    }

    if (await exists(savedCredentials) && !await nonEmptyFile(liveCredentials)) {
      await mkdir(dirname(liveCredentials), { recursive: true })
      await cp(savedCredentials, liveCredentials, { force: true })
      restored.push('credentials')
    }

    if (await exists(savedProfile)) {
      const source = await readJson(savedProfile)
      const target = await exists(liveProfile) ? await readJson(liveProfile) : {}
      const merged = mergeProfile(target, source)
      if (JSON.stringify(merged) !== JSON.stringify(target)) {
        await writeAtomically(liveProfile, `${JSON.stringify(merged, null, 2)}\n`)
        restored.push('plugins')
      }
    }

    await this.captureCurrentConfiguration()
    return { captured: true, restored, snapshotPath: this.snapshotPath }
  }

  private async captureCurrentConfiguration(): Promise<void> {
    for (const relativePath of [
      'settings.yaml',
      '.credentials.yaml',
      join('profiles', 'web', 'package.json'),
      join('profiles', 'web', 'cordis.patch.yml'),
      join('profiles', 'web', 'pnpm-lock.yaml'),
    ]) {
      const source = join(this.dshHome, relativePath)
      if (!await exists(source)) continue
      const target = join(this.snapshotPath, relativePath)
      await mkdir(dirname(target), { recursive: true })
      await cp(source, target, { force: true })
    }
  }
}
