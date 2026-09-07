import { access, cp, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginStatus } from '../shared/types.js'

export interface PluginManagerOptions {
  dshHome: string
  runPnpm: (cwd: string, args: string[]) => Promise<void>
  validateCandidate?: (candidatePath: string) => Promise<void>
  now?: () => Date
}

export class PluginManager {
  private readonly profilePath: string
  private readonly runPnpm: PluginManagerOptions['runPnpm']
  private readonly validateCandidate: (candidatePath: string) => Promise<void>
  private readonly now: () => Date
  private lastSyncedAt: string | null = null
  private lastKnownGoodProfilePath: string | null = null
  private phase: PluginStatus['phase'] = 'idle'
  private error: string | null = null
  private syncPromise: Promise<PluginStatus> | null = null

  constructor(options: PluginManagerOptions) {
    this.profilePath = join(options.dshHome, 'profiles', 'web')
    this.runPnpm = options.runPnpm
    this.validateCandidate = options.validateCandidate ?? (async candidatePath => {
      await access(join(candidatePath, 'package.json'))
    })
    this.now = options.now ?? (() => new Date())
  }

  async getStatus(): Promise<PluginStatus> {
    const names = await this.readPluginNames()
    return {
      profilePath: this.profilePath,
      activeProfilePath: this.profilePath,
      lastKnownGoodProfilePath: this.lastKnownGoodProfilePath,
      names,
      canSync: true,
      lastSyncedAt: this.lastSyncedAt,
      phase: this.phase,
      error: this.error,
    }
  }

  async sync(): Promise<PluginStatus> {
    if (this.syncPromise !== null) return this.syncPromise
    this.syncPromise = this.performSync()
    try {
      return await this.syncPromise
    } finally {
      this.syncPromise = null
    }
  }

  async rollbackLastKnownGood(): Promise<PluginStatus> {
    if (this.lastKnownGoodProfilePath === null || !await this.pathExists(this.lastKnownGoodProfilePath)) {
      this.phase = 'failed'
      this.error = '没有可回滚的稳定插件 profile'
      return this.getStatus()
    }
    const failedPath = `${this.profilePath}.failed-${Date.now()}`
    try {
      await rename(this.profilePath, failedPath)
      await rename(this.lastKnownGoodProfilePath, this.profilePath)
      this.lastKnownGoodProfilePath = failedPath
      this.phase = 'rolled-back'
      this.error = '候选插件启动失败，已恢复上一个稳定版本'
    } catch (error) {
      this.phase = 'failed'
      this.error = error instanceof Error ? error.message : String(error)
      await rename(failedPath, this.profilePath).catch(() => undefined)
    }
    return this.getStatus()
  }

  private async performSync(): Promise<PluginStatus> {
    this.error = null
    this.phase = 'updating'
    const profilesRoot = join(this.profilePath, '..')
    const stamp = this.now().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    let candidatePath = join(profilesRoot, `web.candidate-${stamp}`)
    let suffix = 1
    while (await this.pathExists(candidatePath)) candidatePath = join(profilesRoot, `web.candidate-${stamp}-${suffix++}`)
    let rollbackPath: string | null = null
    try {
      await mkdir(profilesRoot, { recursive: true })
      await access(this.profilePath)
      await cp(this.profilePath, candidatePath, { recursive: true, force: true })
      await this.runPnpm(candidatePath, ['update'])
      await this.validateCandidate(candidatePath)
      rollbackPath = await this.nextRollbackPath(stamp)
      await rename(this.profilePath, rollbackPath)
      try {
        await rename(candidatePath, this.profilePath)
      } catch (error) {
        await rename(rollbackPath, this.profilePath).catch(() => undefined)
        throw error
      }
      this.lastKnownGoodProfilePath = rollbackPath
      this.lastSyncedAt = new Date().toISOString()
      this.phase = 'validated'
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.phase = 'rolled-back'
      await rm(candidatePath, { recursive: true, force: true }).catch(() => undefined)
    }
    return this.getStatus()
  }

  private async nextRollbackPath(stamp: string): Promise<string> {
    const profilesRoot = join(this.profilePath, '..')
    let path = join(profilesRoot, `web.last-known-good-${stamp}`)
    let suffix = 1
    while (await this.pathExists(path)) path = join(profilesRoot, `web.last-known-good-${stamp}-${suffix++}`)
    return path
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }

  private async readPluginNames(): Promise<string[]> {
    try {
      const data = JSON.parse(await readFile(join(this.profilePath, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      return [...new Set([
        ...Object.keys(data.dependencies ?? {}),
        ...Object.keys(data.devDependencies ?? {}),
      ])].sort()
    } catch {
      return []
    }
  }
}
