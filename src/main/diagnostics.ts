import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { LegacyMigrationStatus } from './migration.js'
import type { RuntimeDiagnostics, RuntimeState } from '../shared/types.js'

export class DiagnosticsStore {
  private readonly logPath: string
  private readonly getRuntimeRoot: () => string
  private readonly dshHome: string
  private readonly getState: () => RuntimeState
  private readonly getUpdate: () => { latestVersion: string | null; updateAvailable: boolean }
  private readonly getMigration: () => LegacyMigrationStatus

  constructor(options: {
    userDataPath: string
    getRuntimeRoot: () => string
    dshHome: string
    getState: () => RuntimeState
    getUpdate: () => { latestVersion: string | null; updateAvailable: boolean }
    getMigration?: () => LegacyMigrationStatus
  }) {
    this.logPath = join(options.userDataPath, 'logs', 'harness.log')
    this.getRuntimeRoot = options.getRuntimeRoot
    this.dshHome = options.dshHome
    this.getState = options.getState
    this.getUpdate = options.getUpdate
    this.getMigration = options.getMigration ?? (() : LegacyMigrationStatus => ({
      status: 'not-found',
      legacyHome: '',
      targetHome: this.dshHome,
      backupPath: null,
      migratedAt: null,
      pluginNames: [],
      copiedPaths: [],
      error: null,
    }))
  }

  async log(line: string): Promise<void> {
    await mkdir(join(this.logPath, '..'), { recursive: true })
    await appendFile(this.logPath, `${new Date().toISOString()} ${line}\n`, 'utf8')
  }

  async snapshot(): Promise<RuntimeDiagnostics> {
    const recentLogs = await this.readRecentLogs()
    const pluginNames = await this.readPluginNames()
    const update = this.getUpdate()
    return {
      state: this.getState(),
      runtimeRoot: this.getRuntimeRoot(),
      dshHome: this.dshHome,
      recentLogs,
      pluginCount: pluginNames.length,
      pluginNames,
      latestVersion: update.latestVersion,
      updateAvailable: update.updateAvailable,
      migration: this.getMigration(),
    }
  }

  private async readRecentLogs(): Promise<string[]> {
    try {
      const content = await readFile(this.logPath, 'utf8')
      return content.split(/\r?\n/).filter(Boolean).slice(-80)
    } catch {
      return []
    }
  }

  private async readPluginNames(): Promise<string[]> {
    try {
      const profile = join(this.dshHome, 'profiles', 'web', 'node_modules')
      return (await readdir(profile, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .filter(name => name !== '.pnpm')
    } catch {
      return []
    }
  }
}
