import type { LegacyMigrationStatus } from '../main/migration.js'
import type { ProjectSessionMergeStatus } from '../main/session-merge.js'
import type { DesktopRestartResult } from '../main/desktop-restart.js'

export type RuntimeStatus = 'starting' | 'running' | 'recovering' | 'stopped' | 'error'

export interface RuntimeState {
  status: RuntimeStatus
  version: string
  port: number | null
  url: string | null
  recoveryAttempt: number
  lastError: string | null
  lastHealthyAt: string | null
}

export interface RuntimeDiagnostics {
  state: RuntimeState
  desktopVersion: string
  runtimeRoot: string
  dshHome: string
  recentLogs: string[]
  pluginCount: number
  pluginNames: string[]
  migration: LegacyMigrationStatus
  projectSessionMerge: ProjectSessionMergeStatus
}

export type RepairCheckStatus = 'pending' | 'checking' | 'repairing' | 'ok' | 'fixed' | 'failed' | 'skipped'

export interface RepairCheck {
  id: string
  label: string
  description: string
  repairMethod: string
  status: RepairCheckStatus
  problem: string | null
  detail: string | null
}

export interface RepairReport {
  startedAt: string
  finishedAt: string | null
  knownErrors: string[]
  checks: RepairCheck[]
  fixedCount: number
  state: RuntimeState
}

/** Legacy shape kept for isolated compatibility tests; the desktop API no
 * longer exposes online update operations. */
export interface UpdateStatus {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  checkedAt: string | null
  error: string | null
}

export interface PluginStatus {
  profilePath: string
  activeProfilePath: string
  lastKnownGoodProfilePath: string | null
  names: string[]
  canSync: boolean
  lastSyncedAt: string | null
  phase: 'idle' | 'updating' | 'validated' | 'rolled-back' | 'failed'
  error: string | null
}

export interface DesktopApi {
  getSnapshot: () => Promise<RuntimeDiagnostics>
  openDiagnostics: () => Promise<void>
  openRepairWindow: () => Promise<void>
  closeRepairWindow: () => Promise<void>
  setShellOverlayVisible: (visible: boolean) => Promise<void>
  setStatusPanelExpanded: (expanded: boolean) => Promise<void>
  getStatusPanelExpanded: () => Promise<boolean>
  repairRuntime: () => Promise<RepairReport>
  restartDesktop: () => Promise<DesktopRestartResult>
  onRuntimeState: (listener: (state: RuntimeState) => void) => () => void
  onStatusPanelExpanded: (listener: (expanded: boolean) => void) => () => void
  onRepairProgress: (listener: (report: RepairReport) => void) => () => void
}
