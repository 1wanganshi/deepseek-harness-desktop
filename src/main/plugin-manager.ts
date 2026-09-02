import { access, cp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginStatus } from '../shared/types.js'

export interface PluginManagerOptions {
  dshHome: string
  runPnpm: (cwd: string, args: string[]) => Promise<void>
  validateProfile?: () => Promise<boolean>
}

export class PluginManager {
  private readonly profilePath: string
  private readonly runPnpm: PluginManagerOptions['runPnpm']
  private readonly validateProfile: () => Promise<boolean>
  private lastSyncedAt: string | null = null
  private error: string | null = null
  private syncPromise: Promise<PluginStatus> | null = null

  constructor(options: PluginManagerOptions) {
    this.profilePath = join(options.dshHome, 'profiles', 'web')
    this.runPnpm = options.runPnpm
    this.validateProfile = options.validateProfile ?? (async () => {
      await access(join(this.profilePath, 'package.json'))
      return true
    })
  }

  async getStatus(): Promise<PluginStatus> {
    const names = await this.readPluginNames()
    return {
      profilePath: this.profilePath,
      names,
      canSync: true,
      lastSyncedAt: this.lastSyncedAt,
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

  private async performSync(): Promise<PluginStatus> {
    this.error = null
    const backupPath = `${this.profilePath}.backup`
    try {
      await mkdir(this.profilePath, { recursive: true })
      await rm(backupPath, { recursive: true, force: true })
      await cp(this.profilePath, backupPath, { recursive: true, force: true })
      await this.runPnpm(this.profilePath, ['update'])
      if (!await this.validateProfile()) throw new Error('Plugin profile validation failed')
      this.lastSyncedAt = new Date().toISOString()
      await rm(backupPath, { recursive: true, force: true })
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      await rm(this.profilePath, { recursive: true, force: true })
      await cp(backupPath, this.profilePath, { recursive: true, force: true }).catch(() => undefined)
      // Keep the backup for manual inspection and recovery after a failed update.
    }
    return this.getStatus()
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
