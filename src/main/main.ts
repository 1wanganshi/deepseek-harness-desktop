import { app, BrowserWindow, dialog, Menu, WebContentsView, Tray, nativeImage, ipcMain, session } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundledPnpmScript, runCommand } from './command.js'
import { DiagnosticsStore } from './diagnostics.js'
import { migrateLegacyDsh, type LegacyMigrationStatus } from './migration.js'
import { ConfigurationDurabilityGuard } from './configuration-durability.js'
import { mergeLegacyProjectSessions, type ProjectSessionMergeStatus } from './session-merge.js'
import { SessionDurabilityGuard, findUnlinkedSessions, recoverMissingSessionIndexes, repairWorkspaceLinks } from './session-durability.js'
import { readInstalledDshVersion } from './official-updates.js'
import { isLocalUrl } from './ports.js'
import { hasMissingProfileDependencies, prepareOfficialWebProfile, pruneUnresolvableBundles } from './profile-preparation.js'
import { ensureVisionRouterCompatibility, synchronizeInstalledClientStoreCompatibility } from './compatibility.js'
import { mitigateIncompatibleTaskBoard, normalizeProfilePatchFile, migratePersonaPresetSchema } from './incompatible-plugins.js'
import { RuntimeController } from './runtime-controller.js'
import { createRuntimePaths, ensureRuntimeDirectories, resolveBundledRuntime, type ResolvedRuntime } from './runtime-paths.js'
import { cleanupStaleProcessLock, isWindowsDshProcessAlive, isWindowsProcessAlive } from './stale-locks.js'
import { removeLegacyDoctorSupervisor } from './doctor-supervisor.js'
import { startAfterProfilePreparation } from './startup-sequence.js'
import { buildRestartHelperArgs, restartDesktop, shutdownDesktop, shouldProceedWithDesktopRestart, type DesktopRestartResult } from './desktop-restart.js'
import { repairBundledDependencies } from './bundled-dependencies.js'
import { repairOpenAiProviderCompatibility } from './provider-compatibility.js'
import { repairVisionCapabilities } from './vision-capability.js'
import { ensureMainWindowIsNotTopmost, shouldHideOnClose, shouldHideOnMinimize } from './desktop-shell.js'
import { resolveMacOsBinDir, startPickerBridge, type PickerBridge } from './picker-bridge.js'
import { createHarnessLoader, type HarnessLoader } from './harness-loader.js'
import {
  createHarnessMountRecovery,
  createRuntimeRestartGate,
  evaluateHarnessMount,
  type HarnessMountProbe,
  type HarnessMountRecovery,
  type RuntimeRestartGate,
} from './harness-mount-recovery.js'
import { repairWindowOptions } from './repair-window.js'
import { createRendererUnresponsiveRecovery, pingRenderer, type RendererUnresponsiveRecovery } from './renderer-unresponsive-recovery.js'
import { buildStatusPanelMenu } from './status-panel-menu.js'
import { desktopWebPreferences } from './desktop-web-preferences.js'
import type { RepairCheck, RepairCheckStatus, RepairReport, RuntimeDiagnostics, RuntimeState } from '../shared/types.js'
import { REPAIR_PLAN } from '../shared/repair-plan.js'
import { createRepairChecks, updateRepairCheck } from '../shared/repair-progress.js'

const nodeExecutable = process.platform === 'win32'
  ? join(process.resourcesPath, 'node', 'node.exe')
  : process.platform === 'darwin'
    // Packaged macOS apps ship a POSIX node binary beside the other resources;
    // process.execPath is the app's own Electron executable and must never be
    // used to launch the Harness runtime.
    ? join(process.resourcesPath, 'node', 'node')
    : process.execPath
const hasSingleInstanceLock = app.requestSingleInstanceLock()

let mainWindow: BrowserWindow | null = null
let harnessView: WebContentsView | null = null
let harnessLoader: HarnessLoader | null = null
/** Rebuilt with every window; it reloads the view the window owns. */
let harnessMount: HarnessMountRecovery
/**
 * Guards reloads of a renderer that stopped answering. A wedged client plugin
 * (a synchronous loop in the page) freezes the UI without crashing it, so this
 * is the only signal the shell gets.
 */
let rendererRecovery: RendererUnresponsiveRecovery
let runtime: RuntimeController
let diagnostics: DiagnosticsStore
let activeRuntime: ResolvedRuntime
let diagnosticsWindow: BrowserWindow | null = null
let repairWindow: BrowserWindow | null = null
let tray: Tray | null = null
let statusPanelExpanded = false
let maintenanceQueue = Promise.resolve()
let desktopExitInFlight = false
let quitApproved = false
let profilePreparation: Promise<void> = Promise.resolve()
let prepareActiveProfile: () => Promise<void> = async () => undefined
let repairBundledAppDependencies: () => Promise<{ fixed: boolean; detail: string }> = async () => ({ fixed: false, detail: '桌面壳依赖维修尚未初始化' })
let runtimePaths: ReturnType<typeof createRuntimePaths> | null = null
let sessionDurability: SessionDurabilityGuard | null = null
let sessionDurabilitySweepTimer: ReturnType<typeof setInterval> | null = null
let sessionDurabilitySweepInFlight = false
let configurationDurability: ConfigurationDurabilityGuard | null = null
let authenticatedHarnessAdvertisedUrl: string | null = null
let authenticatedHarnessTargetUrl: string | null = null
/**
 * The official page asked for a reload the shell could not complete (its
 * renderer died, or the load failed). The runtime is still up, so the next
 * `onState` for a *new* URL must reload instead of assuming the page is fine.
 * The page itself is never hidden for this: a long transcript is exactly what
 * makes a renderer die, and hiding the window then would be the visible bug.
 */
let harnessViewRecoveryPending = false
/** Main-process liveness watchdog for the official page; rebuilt with the window. */
let harnessWatchdog: NodeJS.Timeout | null = null
/**
 * Whether the runtime is currently unable to serve the official page. Kept in
 * the main process because it changes the reserved strip above the page (so the
 * user can always reach 维修 / 重启) and is broadcast to the control bar.
 */
let harnessAttention = false
let pickerBridge: PickerBridge | null = null
/**
 * Bounds how often the *shell* may restart the runtime. The in-controller
 * budget (`RuntimeRestartBudget`) already stops a failing runtime from looping;
 * this gate is the outer backstop for restart requests that come from the
 * window layer (a renderer that keeps dying with no runtime URL to fall back
 * on). It re-arms only when a running runtime reports a URL.
 */
const runtimeRestartGate: RuntimeRestartGate = createRuntimeRestartGate({
  maxRestarts: 2,
  windowMs: 5 * 60 * 1000,
  restart: () => runtimeRestart(),
  onLatched: info => {
    void diagnostics?.log(`运行时在 ${Math.round(info.windowMs / 1000)} 秒内重启 ${info.restartsInWindow} 次，已暂停自动重启以免进入循环；请使用维修窗口检查`)
  },
})
let pickerChildEnv: NodeJS.ProcessEnv | undefined
let migration: LegacyMigrationStatus = {
  status: 'not-found',
  legacyHome: '',
  targetHome: '',
  backupPath: null,
  migratedAt: null,
  pluginNames: [],
  copiedPaths: [],
  error: null,
}
/**
 * The repository this desktop shell is developed in. The packaged app knows it
 * from its own resources; a development checkout falls back to the source tree
 * so the constant cannot drift away from the actual checkout location.
 */
function resolveProjectCwd(appRoot: string): string {
  const candidates = [join(appRoot, '..', '..'), appRoot]
  for (const candidate of candidates) {
    const resolved = resolve(candidate)
    if (existsSync(join(resolved, 'package.json')) && existsSync(join(resolved, 'src', 'main'))) return resolved
  }
  return resolve(appRoot)
}

// Declared before `projectSessionMerge`: the initializer below reads this
// binding at module-evaluation time, and a later declaration would put it in
// the temporal dead zone.
const DHS1_PROJECT_CWD = resolveProjectCwd(app.getAppPath())

let projectSessionMerge: ProjectSessionMergeStatus = {
  status: 'not-found',
  projectCwd: DHS1_PROJECT_CWD,
  sourceSessionIds: [],
  copiedSessionIds: [],
  skippedSessionIds: [],
  copiedPaths: [],
  workspaceUpdated: false,
  workspaceId: null,
  workspaceSessionIdsAdded: 0,
  backupPath: null,
  error: null,
}

const SESSION_DURABILITY_SWEEP_MS = 120_000

/**
 * One backup location for every session repair path — the startup pass, the
 * periodic sweep, the exit check and the manual repair must all write snapshots
 * beside each other, otherwise a restore looks in a directory the other path
 * never wrote to.
 */
function sessionDurabilityBackupRoot(): string {
  return join(app.getPath('userData'), 'session-durability-backups')
}

const APP_USER_MODEL_ID = 'com.deepseek.harness.desktop'
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID)

const STATUS_PANEL_HEIGHT = 76
// While the runtime is unavailable the collapsed control bar is the only way to
// reach 维修 / 重启, so a thin strip above the page is reserved for it. The
// strip is released again as soon as the runtime is serving the page.
const STATUS_LAUNCHER_HEIGHT = 32
/**
 * Renderer liveness watchdog.
 *
 * Electron's `unresponsive` event did not fire for the observed plugin wedge
 * (a renderer pegged at 100% CPU for over a minute with no event delivered), so
 * the shell probes the page itself. `executeJavaScript` resolves only once the
 * renderer has run the script, so a missed response inside the timeout is the
 * wedge signal. The timeout is generous so a page busy replaying a long
 * transcript is never mistaken for a wedged one.
 */
const RENDERER_PING_INTERVAL_MS = 5_000
const RENDERER_PING_TIMEOUT_MS = 15_000

function bundledVersion(appRoot: string): Promise<string> {
  return readInstalledDshVersion(appRoot)
}

function resolveNodeExecutable(): string {
  return existsSync(nodeExecutable) ? nodeExecutable : 'node'
}

async function createServices(): Promise<void> {
  const appRoot = app.getAppPath()
  const paths = createRuntimePaths(appRoot, app.getPath('userData'))
  runtimePaths = paths
  await ensureRuntimeDirectories(paths)
  const initialVersion = await bundledVersion(appRoot)
  // The released desktop build is immutable: the DSH runtime is always the
  // copy shipped in this installation. User-data runtime pointers are kept as
  // diagnostics/history only and can never replace the bundled runtime.
  activeRuntime = resolveBundledRuntime(paths, initialVersion)

  if (process.platform === 'darwin') {
    const binDir = resolveMacOsBinDir(appRoot)
    if (binDir !== null) {
      pickerBridge = await startPickerBridge()
      pickerChildEnv = {
        PATH: [binDir, process.env.PATH].filter((value): value is string => Boolean(value)).join(delimiter),
        DSH_DESKTOP_PICKER_PORT: String(pickerBridge.port),
        DSH_DESKTOP_PICKER_TOKEN: pickerBridge.token,
      }
    }
  }

  const log = async (line: string) => diagnostics?.log(line)
  runtime = new RuntimeController({
    resolveRuntime: async () => {
      activeRuntime = resolveBundledRuntime(paths, initialVersion)
      return activeRuntime
    },
    dshHome: paths.dshHome,
    nodeExecutable: resolveNodeExecutable(),
    childEnv: pickerChildEnv,
    log: line => { void log(line) },
    onState: state => {
      sendDesktopEvent('desktop:runtime-state', state)
      setHarnessAttention(state.status !== 'running')
      if (state.status === 'running' && state.url !== null) {
        // A running runtime that answers is the only proof the restart loop is
        // over; until this fires the shell may not restart it again.
        runtimeRestartGate.notifyHealthy()
        harnessViewRecoveryPending = false
        scheduleSessionDurabilitySweep()
        void loadHarness(state.url)
      }
      if (state.status !== 'running') {
        stopSessionDurabilitySweep()
      }
      // The official page stays visible through a transient recovery: hiding it
      // is what made a few seconds of reconnect look like the whole app
      // restarting. Only a terminal state gives up the URL (and with it the
      // view); the repair window and the control bar remain reachable because
      // the launcher strip keeps the shell above the page.
      if (state.status === 'error' || state.status === 'stopped') {
        authenticatedHarnessAdvertisedUrl = null
        authenticatedHarnessTargetUrl = null
        harnessLoader?.setDesiredUrl(null)
      }
    },
    // The child is confirmed down, so nothing holds DSH_HOME: the only moment
    // the shell may safely write the session/workspace indexes. While the
    // runtime is up (or coming up) the sweep is strictly read-only.
    onStopped: () => { void runIdleWorkspaceLinkRepair() },
    // Unlike the tiered backoff inside the controller, this is a budget across
    // *lifecycles*: a session that kills the runtime on load must not be able to
    // reboot it forever. When it latches, the shell stops restarting and the
    // control bar asks the user to diagnose, rather than looping.
    onRestartBlocked: reason => { void log(`已暂停自动重启：${reason}`) },
  })
  sessionDurability = new SessionDurabilityGuard({
    dshHome: paths.dshHome,
    backupRoot: sessionDurabilityBackupRoot(),
  })
  configurationDurability = new ConfigurationDurabilityGuard({
    dshHome: paths.dshHome,
    backupRoot: join(app.getPath('userData'), 'configuration-durability-backups'),
  })

  const pnpmScript = bundledPnpmScript(appRoot)
  const runPnpm = (cwd: string, args: string[]) => runCommand(
    resolveNodeExecutable(),
    [pnpmScript, ...args],
    cwd,
    { ...process.env, DSH_HOME: paths.dshHome },
    { timeoutMs: 600_000 },
  )
    repairBundledAppDependencies = async () => {
      const workerPath = join(appRoot, 'node_modules', '@deepseek-ai', 'dsh-workflow-worker-thread')
      const workflowPath = join(appRoot, 'node_modules', '@deepseek-ai', 'dsh-tool-workflow')
    const repaired = await repairBundledDependencies({
      workerPath,
      requiredPackagePaths: [workflowPath],
      install: args => runPnpm(appRoot, args),
    })
    if (repaired) void diagnostics.log('已修复桌面应用缺少的官方 workflow worker 依赖')
    return { fixed: repaired, detail: repaired ? '已重新安装官方 workflow worker 依赖' : '官方 workflow worker 依赖完整' }
  }
  diagnostics = new DiagnosticsStore({
    userDataPath: app.getPath('userData'),
    getRuntimeRoot: () => activeRuntime.root,
    dshHome: paths.dshHome,
    getState: () => runtime.getState(),
    getDesktopVersion: () => app.getVersion(),
    getMigration: () => migration,
    getProjectSessionMerge: () => projectSessionMerge,
  })

  if (pickerBridge !== null) {
    void diagnostics.log(`macOS 目录选择桥已就绪：127.0.0.1:${pickerBridge.port}（osascript 垫片接管 choose folder，规避 -1713）`)
  }

  if (await removeLegacyDoctorSupervisor()) {
    void diagnostics.log('已移除旧版社区 Doctor 后台监督任务；桌面端将自行管理运行时重启和维修')
  }

  migration = await migrateLegacyDsh({
    legacyHome: join(app.getPath('home'), '.dsh'),
    targetHome: paths.dshHome,
    backupRoot: join(app.getPath('userData'), 'migration-backups'),
  })
  if (migration.status === 'migrated') {
    void diagnostics.log(`已迁移旧 DHS_HOME：${migration.pluginNames.length} 个插件清单，${migration.copiedPaths.length} 项用户数据`)
  } else if (migration.status === 'failed') {
    void diagnostics.log(`旧 DHS_HOME 迁移失败并已回滚：${migration.error ?? '未知错误'}`)
  }

  try {
    const protection = await configurationDurability.protect()
    if (protection.restored.length > 0) {
      void diagnostics.log(`启动前已从本机安全快照补回配置：${protection.restored.join('、')}`)
    }
  } catch (error) {
    void diagnostics.log(`配置安全快照检查失败，未修改原始数据：${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const providerCompatibility = await repairOpenAiProviderCompatibility(join(paths.dshHome, 'settings.yaml'))
    if (providerCompatibility.changed) {
      void diagnostics.log(`启动预检已修复 OpenAI 兼容 Provider 的 developer role：${providerCompatibility.providerIds.join(', ')}`)
    }
  } catch (error) {
    void diagnostics.log(`启动预检未能修复模型 Provider 兼容配置，可从维修窗口重试：${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const vision = await repairVisionCapabilities(paths.dshHome)
    if (vision.changed) {
      const parts: string[] = []
      if (vision.added.length > 0) parts.push(`启用识图 ${vision.added.join(', ')}`)
      if (vision.removed.length > 0) parts.push(`移除误标的识图声明 ${vision.removed.join(', ')}`)
      void diagnostics.log(`启动预检已按实际探测结果校准模型视觉能力：${parts.join('；')}`)
    }
  } catch (error) {
    void diagnostics.log(`启动预检未能校准模型视觉能力：${error instanceof Error ? error.message : String(error)}`)
  }

  projectSessionMerge = await mergeLegacyProjectSessions({
    legacyHome: join(app.getPath('home'), '.dsh'),
    targetHome: paths.dshHome,
    projectCwd: DHS1_PROJECT_CWD,
    backupRoot: join(app.getPath('userData'), 'migration-backups'),
  })
  if (projectSessionMerge.status === 'merged' || projectSessionMerge.status === 'already-merged') {
    void diagnostics.log(`DHS1 会话库统一完成：源记录 ${projectSessionMerge.sourceSessionIds.length} 条，新增 ${projectSessionMerge.copiedSessionIds.length} 条，已存在 ${projectSessionMerge.skippedSessionIds.length} 条${projectSessionMerge.backupPath === null ? '' : `，备份 ${projectSessionMerge.backupPath}`}`)
  } else if (projectSessionMerge.status === 'failed') {
    void diagnostics.log(`DHS1 会话库统一失败，源数据保留未改动：${projectSessionMerge.error ?? '未知错误'}`)
  }

  const taskBoardLock = join(paths.dshHome, 'task-board', 'ledger-v2.lock')
  if (await cleanupStaleProcessLock(taskBoardLock, isWindowsProcessAlive)) {
    void diagnostics.log('已清理任务板陈旧进程锁，原进程已不存在')
  }

  const profileModulesLock = join(paths.dshHome, 'profiles', 'node_modules.lock')
  if (await cleanupStaleProcessLock(profileModulesLock, pid => isWindowsDshProcessAlive(pid, paths.dshHome))) {
    void diagnostics.log('已清理 Web 插件依赖的陈旧进程锁，原进程已不存在')
  }

  const profilePath = join(paths.dshHome, 'profiles', 'web')
  const profileNodeModules = join(profilePath, 'node_modules')
  const profilePackagePath = join(profilePath, 'package.json')
  if (existsSync(profilePackagePath)) {
    const profilePatchLock = join(profilePath, 'cordis.patch.yml.lock')
    if (await cleanupStaleProcessLock(profilePatchLock, isWindowsProcessAlive)) {
      void diagnostics.log('已清理 Web profile 补丁的陈旧进程锁，原进程已不存在')
    }
    // Preparation can rebuild the profile dependency tree. Keep it separate
    // from window creation, but never let the Harness boot while pnpm is
    // changing files that the Harness will load.
    prepareActiveProfile = async () => {
      activeRuntime = resolveBundledRuntime(paths, initialVersion)
      await prepareWebProfile({
        paths,
        profilePath,
        profileNodeModules,
        profilePackagePath,
        migrationStatus: migration.status,
        runPnpm,
        runtimeVersion: activeRuntime.version,
      })
    }
    profilePreparation = prepareActiveProfile()
  }
}

async function prepareWebProfile(options: {
  paths: ReturnType<typeof createRuntimePaths>
  profilePath: string
  profileNodeModules: string
  profilePackagePath: string
  migrationStatus: LegacyMigrationStatus['status']
  runPnpm: (cwd: string, args: string[]) => Promise<void>
  runtimeVersion: string
}): Promise<void> {
  const { paths, profilePath, profileNodeModules, profilePackagePath, migrationStatus, runPnpm, runtimeVersion } = options
  // DHS validates this file during process boot. Repair legacy formats before
  // any dependency work so a failed install can never leave a boot-blocking
  // overlay behind.
  const patchNormalization = await normalizeProfilePatchFile(profilePath)
  if (patchNormalization.changed) {
    void diagnostics.log('启动预检已将 Web profile patch 修复为合法数组格式')
  }
  // A bundle whose package is missing aborts the whole Harness boot. Heal that
  // before the dependency install runs, so a half-finished plugin install
  // disables just that plugin instead of leaving the app unable to start.
  try {
    const pruned = await pruneUnresolvableBundles(profilePath)
    if (pruned.changed) {
      void diagnostics.log(`启动预检移除了 ${pruned.pruned.length} 个无法解析的插件（${pruned.pruned.join(', ')}），备份：${pruned.backupPath}`)
    }
  } catch (error) {
    // Healing is best-effort: a failure here must not become a new way to block
    // startup. The install attempt below still runs and reports its own errors.
    void diagnostics.log(`启动预检清理无效插件失败：${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const lockfile = join(profilePath, 'pnpm-lock.yaml')
    const compatibilityPackagePath = join(profileNodeModules, '@deepseek-ai', 'dsh-client-store', 'package.json')
    const compatibilityPatchPath = join(profileNodeModules, '@deepseek-ai', 'dsh-client-store', 'cordis.patch.yml')
    const compatibilityClientPath = join(profileNodeModules, '@deepseek-ai', 'dsh-client-store', 'client.js')
    const missingProfileDependencies = await hasMissingProfileDependencies(profilePath)
    if (missingProfileDependencies.length > 0) {
      void diagnostics.log(`启动预检发现 ${missingProfileDependencies.length} 个 profile 依赖缺失：${missingProfileDependencies.join(', ')}`)
    }
    const preparation = await prepareOfficialWebProfile({
      dshHome: paths.dshHome,
      profilePath,
      packagePath: profilePackagePath,
      nodeModulesPresent: existsSync(profileNodeModules),
      dependencyInstallRequired: migrationStatus === 'migrated'
        || missingProfileDependencies.length > 0
        || !existsSync(compatibilityPackagePath)
        || !existsSync(compatibilityPatchPath)
        || !existsSync(compatibilityClientPath),
      lockfilePresent: existsSync(lockfile),
      runtimeVersion,
      install: args => runPnpm(profilePath, args),
    })
    if (await synchronizeInstalledClientStoreCompatibility({ dshHome: paths.dshHome, profilePath })) {
      void diagnostics.log('已同步旧版 Web 插件兼容包文件')
    }
    if (await ensureVisionRouterCompatibility({ profilePath })) {
      void diagnostics.log('已启用 Vision Router 远程目录竞态兼容层')
    }
    if (preparation.compatibilityChanged) void diagnostics.log('已启用旧版 Web 插件兼容层：dsh-client-store → 官方 dsh-client-runtime')
    if (preparation.rebuiltDependencies) void diagnostics.log('已为官方 Web profile 重建插件依赖')
    const mitigation = await mitigateIncompatibleTaskBoard({ profilePath, runtimeVersion })
    if (mitigation.changed) {
      void diagnostics.log('已应用稳定性插件加载覆盖；受影响插件的文件、配置和凭据均保留')
    }
    if (mitigation.taskBoardDisabled) {
      void diagnostics.log('当前官方 Harness 版本低于任务板插件要求，已禁用不兼容入口；插件文件和配置仍保留')
    }
    const personaMigration = await migratePersonaPresetSchema({ dshHome: paths.dshHome, profilePath })
    if (personaMigration.changed) {
      void diagnostics.log(`已迁移 persona preset 配置字段到 0.1.3 schema（text → prefix）：${personaMigration.files.length} 个文件`)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    // A failed install is not by itself proof that the profile is unusable:
    // the registry can be unreachable while a complete dependency tree is
    // already on disk. Only block startup when dependencies are genuinely
    // absent, otherwise degrade to a warning and let the runtime try.
    const stillMissing = await hasMissingProfileDependencies(profilePath).catch(() => [])
    if (stillMissing.length === 0 && existsSync(profileNodeModules)) {
      void diagnostics.log(`插件依赖重建未完成（${detail}），但已安装的依赖完整，继续启动`)
    } else {
      // The install failed and some dependency is genuinely absent. Rather than
      // refuse to boot — which leaves the user with an app that can never reach
      // the runtime — prune the bundles that cannot resolve and start with the
      // rest. Only a profile that is still broken after pruning is fatal.
      const pruned = await pruneUnresolvableBundles(profilePath).catch(() => ({ changed: false, pruned: [], backupPath: null }))
      const remaining = await hasMissingProfileDependencies(profilePath).catch(() => stillMissing)
      if (pruned.changed && remaining.length === 0) {
        void diagnostics.log(`插件依赖重建失败（${detail}），已移除无法解析的插件并继续启动：${pruned.pruned.join(', ')}；备份：${pruned.backupPath}`)
      } else {
        // Never launch Harness against a partially rebuilt profile. Keeping the
        // rejection lets the startup gate show the real failure and leaves the
        // existing profile backup available for the repair flow.
        void diagnostics.log(`插件兼容层或依赖重建失败，已阻止启动：${detail}`)
        throw error
      }
    }
  }
}

async function startRuntime(): Promise<RuntimeState> {
  await repairBundledAppDependencies()
  if (runtimePaths === null) throw new Error('运行时路径尚未初始化')
  if (configurationDurability !== null) {
    const protection = await configurationDurability.protect()
    if (protection.restored.length > 0) {
      void diagnostics.log(`启动前已从本机安全快照补回配置：${protection.restored.join('、')}`)
    }
  }
  const recovered = await recoverMissingSessionIndexes(runtimePaths.dshHome)
  const linked = await repairWorkspaceLinks(runtimePaths.dshHome, sessionDurabilityBackupRoot())
  if (recovered.length > 0) {
    void diagnostics.log(`已从持久化转录恢复 ${recovered.length} 个会话索引`)
  }
  if (linked.length > 0) void diagnostics.log(`已将 ${linked.length} 个会话重新挂回所属工作区`)
  const state = await runtime.start()
  await sessionDurability?.captureBaseline()
  return state
}

/**
 * Restart the runtime through the shared gate. Every automatic restart path
 * must go through here so the retry budget is respected; an explicit user
 * action (the repair window) may call `runtime.restart()` directly.
 */
async function runtimeRestart(): Promise<void> {
  await startAfterProfilePreparation(profilePreparation, () => runtime.restart())
}

/**
 * Run the workspace link repair, but only when nothing else owns the files.
 *
 * `repairWorkspaceLinks` rewrites `storages/workspace.json` with an atomic
 * replace. The official runtime holds that file for the whole time it is up, so
 * doing this while it runs makes the runtime reload its workspace state and die
 * — the desktop shell then restarted it, which the user saw as "typing in an old
 * chat reboots the app". A long conversation is what makes the collision likely,
 * because that is when the runtime flushes transcripts and rewrites its own
 * state files; a new session has nothing to flush.
 *
 * So the repair only ever runs while the runtime is confirmed down: before it
 * starts, right after it stops, and when the whole desktop app is exiting.
 */
async function runIdleWorkspaceLinkRepair(): Promise<void> {
  if (runtimePaths === null) return
  const status = runtime.getState().status
  if (status !== 'stopped' && status !== 'error') return
  try {
    const linked = await repairWorkspaceLinks(runtimePaths.dshHome, sessionDurabilityBackupRoot())
    if (linked.length > 0) void diagnostics.log(`已在空闲窗口将 ${linked.length} 个新会话挂回所属工作区`)
  } catch (error) {
    void diagnostics.log(`空闲会话挂载失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * A session directory can appear on disk while the workspace link that makes it
 * visible in the UI is still missing — the transcript gets flushed lazily, so
 * the two are written at different moments. Linking only at startup and at exit
 * left such a session invisible for the whole run, which is exactly the report
 * "yesterday's session was lost".
 *
 * This pass therefore runs every couple of minutes, but it is strictly
 * read-only: it reports which sessions are not yet linked and leaves the actual
 * repair to `runIdleWorkspaceLinkRepair`. Writing `workspace.json` while the
 * runtime is up is what used to kill a long conversation, so the periodic pass
 * must never touch it.
 */
function scheduleSessionDurabilitySweep(): void {
  if (sessionDurabilitySweepTimer !== null || runtimePaths === null) return
  sessionDurabilitySweepTimer = setInterval(() => {
    if (runtimePaths === null || sessionDurabilitySweepInFlight) return
    sessionDurabilitySweepInFlight = true
    void (async () => {
      try {
        const unlinked = await findUnlinkedSessions(runtimePaths.dshHome)
        if (unlinked.length > 0) {
          void diagnostics.log(`发现 ${unlinked.length} 个会话尚未挂回工作区，将在运行时停止后自动挂载（运行期间不写入 workspace.json）`)
        }
      } catch (error) {
        void diagnostics.log(`会话持久化巡检失败：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        sessionDurabilitySweepInFlight = false
      }
    })()
  }, SESSION_DURABILITY_SWEEP_MS)
}

function stopSessionDurabilitySweep(): void {
  if (sessionDurabilitySweepTimer !== null) clearInterval(sessionDurabilitySweepTimer)
  sessionDurabilitySweepTimer = null
  // The runtime just left `running`, so this is the first moment the workspace
  // file is free again.
  void runIdleWorkspaceLinkRepair()
}

async function createWindow(): Promise<void> {
  const appRoot = app.getAppPath()
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0b0e14',
    show: false,
    webPreferences: {
      ...desktopWebPreferences(fileURLToPath(new URL('../preload.js', import.meta.url))),
    },
  })
  mainWindow.once('ready-to-show', () => {
    ensureMainWindowIsNotTopmost(mainWindow)
    mainWindow?.show()
  })
  mainWindow.on('minimize', () => {
    if (!shouldHideOnMinimize(process.platform)) return
    hideMainWindow()
  })
  mainWindow.on('close', event => {
    if (!shouldHideOnClose({ platform: process.platform, quitting: quitApproved })) return
    event.preventDefault()
    hideMainWindow()
  })
  mainWindow.on('resize', () => resizeHarnessView())
  mainWindow.on('closed', () => {
    if (repairWindow !== null && !repairWindow.isDestroyed()) repairWindow.close()
    if (harnessWatchdog !== null) {
      clearInterval(harnessWatchdog)
      harnessWatchdog = null
    }
    mainWindow = null
    harnessView = null
    harnessLoader = null
  })

  harnessView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  harnessView.webContents.setWindowOpenHandler(({ url }) => ({ action: isLocalUrl(url) ? 'allow' : 'deny' }))
  harnessView.webContents.on('will-navigate', (event, url) => {
    if (!isLocalUrl(url)) event.preventDefault()
  })
  harnessView.webContents.on('did-start-loading', () => {
    void diagnostics.log('官方 Web UI 开始加载')
  })
  harnessView.webContents.on('dom-ready', () => {
    void diagnostics.log(`官方 Web UI DOM 已就绪：${harnessView?.webContents.getURL() ?? 'unknown'}`)
  })
  harnessView.webContents.on('did-finish-load', () => {
    const webContents = harnessView?.webContents
    void diagnostics.log(`官方 Web UI 加载完成：${webContents?.getURL() ?? 'unknown'}`)
    if (webContents !== undefined) {
      void webContents.executeJavaScript(`(() => {
        const root = document.querySelector('#root')
        return JSON.stringify({
          readyState: document.readyState,
          rootChildren: root?.childElementCount ?? -1,
          bodyText: document.body?.innerText?.slice(0, 240) ?? '',
          bootReady: Boolean(window.__DSH_BOOT_READY__),
        })
      })()`, true).then(result => {
        const rawStatus = String(result)
        void diagnostics.log(`官方 Web UI 挂载状态：${rawStatus}`)
        let probe: HarnessMountProbe
        try {
          probe = JSON.parse(rawStatus) as HarnessMountProbe
        } catch (error) {
          void diagnostics.log(`官方 Web UI 挂载状态解析失败：${error instanceof Error ? error.message : String(error)}`)
          probe = {}
        }
        const verdict = evaluateHarnessMount(probe)
        const url = runtime.getState().url
        if (verdict.state === 'mounted') {
          // The only signal that clears the retry streak. Static page chrome
          // ("探索未至之境", the sidebar) is painted before a long transcript is
          // replayed, so "the document has text" must never count as mounted —
          // that made the retry ceiling unreachable and the shell kept reloading
          // the official page under the user while they were typing.
          harnessMount.markMounted()
          return
        }
        if (verdict.state === 'plugin-failure') {
          void diagnostics.log(`官方 Web UI 插件加载失败：${verdict.detail}`)
          harnessMount.schedule('插件加载失败', url)
          return
        }
        harnessMount.schedule('页面加载完成但未挂载', url)
      }).catch(error => {
        void diagnostics.log(`官方 Web UI 挂载检查失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }
  })
  harnessView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    void diagnostics.log(`官方 Web UI 加载失败：code=${errorCode} ${errorDescription} url=${validatedURL} mainFrame=${isMainFrame}`)
    if (isMainFrame) harnessMount.schedule(`加载失败 ${errorCode}`, runtime.getState().url)
  })
  harnessView.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    void diagnostics.log(`官方 Web UI 控制台：level=${level} ${message} (${sourceId}:${line})`)
  })
  harnessView.webContents.on('render-process-gone', () => {
    // A renderer crash (GPU reset, compositor memory pressure, a multi-megabyte
    // transcript replay) says nothing about the Harness server, which usually
    // keeps serving. Reload the *page* and leave the runtime alone — restarting
    // it tore down a healthy process and re-ran the whole boot sequence, which
    // the user experienced as the app rebooting mid-conversation.
    void diagnostics.log('官方 Web UI 渲染进程退出，将重新加载官方页面（不重启运行时）')
    harnessViewRecoveryPending = true
    harnessLoader?.clearLoadedUrl()
    const currentUrl = runtime.getState().url
    if (currentUrl === null) {
      // A dying renderer with no known URL is the one case that still needs a
      // runtime restart, so it goes through the shell-level gate rather than
      // straight to the controller.
      void runtimeRestartGate.restart().catch(() => undefined)
      return
    }
    if (rendererRecovery.rebuildInFlight()) {
      // This crash is the deliberate teardown of a wedged renderer. Load the page
      // straight away: the mount-recovery budget exists for a page that never
      // mounted, and spending it here would leave a genuinely unmounted page with
      // no retries left. The unresponsive guard owns its own budget.
      rendererRecovery.rebuildScheduled()
      void loadHarness(currentUrl)
      return
    }
    harnessMount.schedule('渲染进程已退出', currentUrl)
  })
  // A page that stops answering is wedged, not dead: `render-process-gone` and
  // `did-fail-load` never fire, so without this the user had to restart the whole
  // app. The conversation lives in the runtime, so only the render is lost.
  //
  // Electron's own `unresponsive` event is NOT reliable here: for the observed
  // plugin wedge it never fired, even with the renderer pegged at 100% CPU for
  // over a minute. So the shell runs its own watchdog — pinging the page with
  // `executeJavaScript`, which only resolves once the renderer has actually run
  // it — and treats a missed response as the signal.
  const rebuildWedgedRenderer = (): void => {
    void diagnostics.log('官方 Web UI 渲染进程无响应，将重建渲染进程（不重启运行时）')
    if (!rendererRecovery.recover()) {
      void diagnostics.log('官方 Web UI 渲染进程反复无响应，已暂停自动重建；会话与运行时仍在运行，可通过「重启」恢复')
      return
    }
    // A plain `reload()`/`loadURL()` cannot rescue this: the renderer is stuck in
    // a synchronous loop, so it never processes the navigation and the process is
    // never replaced. Observed in the field as a reload that logs "开始加载" and
    // then never "加载完成", with the original renderer still pegged at ~100% CPU
    // half an hour later. Per Electron's own guidance for the `unresponsive`
    // event, kill the wedged process; `render-process-gone` then performs the
    // page load in a *new* renderer, so the reload path stays in one place.
    if (harnessView !== null && !harnessView.webContents.isDestroyed()) {
      harnessView.webContents.forcefullyCrashRenderer()
    }
  }
  harnessView.webContents.on('unresponsive', rebuildWedgedRenderer)
  harnessView.webContents.on('responsive', () => {
    // The renderer answered again, so a rebuild is no longer needed and the
    // budget refills for the next genuine wedge.
    rendererRecovery.markResponsive()
  })
  if (harnessWatchdog !== null) clearInterval(harnessWatchdog)
  harnessWatchdog = setInterval(() => {
    if (harnessView === null || harnessView.webContents.isDestroyed()) return
    // Only ever judge a page that is meant to be live: during the initial load a
    // miss is expected, not evidence of a wedge.
    const state = runtime.getState()
    if (state.status !== 'running' || state.url === null) return
    if (harnessViewRecoveryPending) return
    void pingRenderer({
      timeoutMs: RENDERER_PING_TIMEOUT_MS,
      ping: () => harnessView!.webContents.executeJavaScript('1'),
    }).then(alive => {
      if (alive) return
      if (harnessView === null || harnessView.webContents.isDestroyed()) return
      rebuildWedgedRenderer()
    }).catch(() => undefined)
  }, RENDERER_PING_INTERVAL_MS)

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl !== undefined) await mainWindow.loadURL(devUrl)
  else await mainWindow.loadFile(join(appRoot, 'dist-renderer', 'index.html'))
  mainWindow.show()
  // BrowserWindow's own WebContentsView is created while loading the shell.
  // Add the official Harness view afterwards so the shell background cannot
  // cover it in Chromium's view compositor.
  mainWindow.contentView.addChildView(harnessView)
  harnessView.setVisible(false)
  harnessLoader = createHarnessLoader(
    url => harnessView!.webContents.loadURL(url),
    visible => harnessView?.setVisible(visible),
  )
  // Bounded page-level retry. Scoped to this window on purpose: closing the
  // window must discard the counter along with the view it reloads.
  harnessMount = createHarnessMountRecovery({
    maxAttempts: 2,
    retryDelayMs: 700,
    getCurrentUrl: () => runtime.getState().url,
    reload: url => { void loadHarness(url) },
    onRetry: (attempt, reason) => {
      void diagnostics.log(`官方 Web UI ${reason}，准备第 ${attempt} 次自动重试`)
    },
    onAbandoned: reason => {
      void diagnostics.log(`官方 Web UI 连续挂载失败，已停止自动重试（页面保留，其他会话仍可使用）：${reason}`)
    },
  })
  // Separate budget from the mount retry above: reloading a wedged renderer is a
  // routine remedy and must not consume the retries that a never-mounted page
  // needs. Five reloads in ten minutes tolerates a plugin that wedges on open
  // while still refusing to reload forever.
  rendererRecovery = createRendererUnresponsiveRecovery({
    maxReloads: 5,
    windowMs: 10 * 60_000,
    onReload: ({ attempt }) => {
      void diagnostics.log(`官方 Web UI 第 ${attempt} 次因无响应而重新加载页面`)
    },
    onLatched: () => {
      void diagnostics.log('官方 Web UI 反复无响应，已暂停自动重载（运行时保持运行，可用「重启」手动恢复）')
    },
  })
  resizeHarnessView()
}

async function openDiagnosticsWindow(): Promise<void> {
  const appRoot = app.getAppPath()
  if (diagnosticsWindow !== null && !diagnosticsWindow.isDestroyed()) {
    diagnosticsWindow.focus()
    return
  }
  diagnosticsWindow = new BrowserWindow({
    parent: mainWindow ?? undefined,
    width: 820,
    height: 720,
    minWidth: 640,
    minHeight: 520,
    backgroundColor: '#0b0e14',
    title: 'DeepSeek Harness 诊断',
    webPreferences: {
      ...desktopWebPreferences(fileURLToPath(new URL('../preload.js', import.meta.url))),
    },
  })
  diagnosticsWindow.on('closed', () => { diagnosticsWindow = null })
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl !== undefined) await diagnosticsWindow.loadURL(`${devUrl}?diagnostics=1`)
  else await diagnosticsWindow.loadFile(join(appRoot, 'dist-renderer', 'index.html'), { query: { diagnostics: '1' } })
}

function sendDesktopEvent(channel: string, payload: unknown): void {
  for (const window of [mainWindow, repairWindow]) {
    if (window !== null && !window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

async function openRepairWindow(): Promise<void> {
  if (repairWindow !== null && !repairWindow.isDestroyed()) {
    repairWindow.show()
    repairWindow.focus()
    return
  }
  const appRoot = app.getAppPath()
  repairWindow = new BrowserWindow({
    ...repairWindowOptions(),
    parent: mainWindow ?? undefined,
    webPreferences: {
      ...desktopWebPreferences(fileURLToPath(new URL('../preload.js', import.meta.url))),
    },
  })
  repairWindow.once('ready-to-show', () => repairWindow?.show())
  repairWindow.on('closed', () => { repairWindow = null })
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl !== undefined) await repairWindow.loadURL(devUrl + '?repair=1&auto=1')
  else await repairWindow.loadFile(join(appRoot, 'dist-renderer', 'index.html'), { query: { repair: '1', auto: '1' } })
  repairWindow.show()
  void diagnostics?.log(`维修窗口已创建：可见=${repairWindow.isVisible()} 已销毁=${repairWindow.isDestroyed()}`)
}

function resizeHarnessView(): void {
  if (mainWindow === null || harnessView === null) return
  const [width, height] = mainWindow.getContentSize()
  // The official Web UI fills the content area while collapsed — except when the
  // runtime is unavailable, where a thin strip is reserved so the control bar
  // (and with it 维修 / 重启) stays clickable instead of being covered by the
  // page. Only the fully expanded status bar reserves more.
  const topInset = statusPanelExpanded ? STATUS_PANEL_HEIGHT : (harnessAttention ? STATUS_LAUNCHER_HEIGHT : 0)
  const bounds = { x: 0, y: topInset, width, height: Math.max(0, height - topInset) }
  harnessView.setBounds(bounds)
  void diagnostics?.log(`状态栏视图边界：${statusPanelExpanded ? '展开' : '隐藏'} y=${bounds.y} h=${bounds.height}`)
  // WebContentsView compositing can apply a stale bound for one frame while
  // the shell renderer is committing the panel state. Re-apply on the next
  // turn for both directions so a collapsed panel cannot leave a black strip.
  setTimeout(() => {
    if (mainWindow === null || harnessView === null) return
    const [nextWidth, nextHeight] = mainWindow.getContentSize()
    const nextInset = statusPanelExpanded ? STATUS_PANEL_HEIGHT : (harnessAttention ? STATUS_LAUNCHER_HEIGHT : 0)
    harnessView.setBounds({ x: 0, y: nextInset, width: nextWidth, height: Math.max(0, nextHeight - nextInset) })
  }, 0)
}

/**
 * Whether the official page needs attention. The reserved strip above the page
 * is what keeps 维修 / 重启 reachable while the runtime is down, so this both
 * re-lays-out the view and tells the control bar to show its launcher.
 */
function setHarnessAttention(next: boolean): void {
  if (harnessAttention === next) return
  harnessAttention = next
  resizeHarnessView()
  sendDesktopEvent('desktop:harness-attention', next)
}

function toggleStatusPanelFromMenu(): void {
  statusPanelExpanded = !statusPanelExpanded
  void diagnostics?.log(`状态栏菜单已切换：${statusPanelExpanded ? '展开' : '隐藏'}`)
  resizeHarnessView()
  sendDesktopEvent('desktop:status-panel-expanded', statusPanelExpanded)
}

/**
 * Keep the main window a normal, non-topmost window.
 *
 * Nothing in this shell asks for an always-on-top window, but the flag is a
 * persistent Win32 window style: once some other process sets `WS_EX_TOPMOST`
 * on our HWND (an automation helper calling `SetWindowPos(HWND_TOPMOST)` is
 * enough), it sticks for the lifetime of the window and the app appears to sit
 * above every other application. Re-assert the normal state whenever the window
 * is shown so it can never get stuck on top.
 */
function showMainWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  ensureMainWindowIsNotTopmost(mainWindow)
  mainWindow.show()
  mainWindow.focus()
}

function hideMainWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  mainWindow.hide()
}

function describeSessionBlockers(report: Awaited<ReturnType<SessionDurabilityGuard['verifyForRestart']>> | null): string {
  if (report === null || report.blockers.length === 0) return 'Harness 停止失败，未执行退出。'
  return report.blockers.map(blocker => `会话 ${blocker.sessionId}：${blocker.reason}`).join('\n')
}

async function requestSafeDesktopExit(): Promise<void> {
  if (quitApproved || desktopExitInFlight) return
  if (runtime === undefined || sessionDurability === null) {
    quitApproved = true
    app.quit()
    return
  }
  desktopExitInFlight = true
  try {
    const result = await shutdownDesktop({
      verifyBeforeStop: () => sessionDurability?.verifyForRestart() ?? Promise.reject(new Error('会话持久化守卫尚未初始化')),
      stop: () => runtime.stop(),
      verifyAfterStop: () => sessionDurability?.verifyForRestart() ?? Promise.reject(new Error('会话持久化守卫尚未初始化')),
      resumeAfterBlockedStop: async () => { await startRuntime() },
      onStopError: error => void diagnostics.log(`桌面退出前停止 Harness 失败，已取消退出：${error instanceof Error ? error.message : String(error)}`),
    })
    if (!result.stopped) {
      const detail = describeSessionBlockers(result.report)
      void diagnostics.log(`已取消桌面退出：${detail.replace(/\n/g, '；')}`)
      // The durability guard is an advisory: it must warn about a risky exit
      // but never trap the user inside a running app. Offer an explicit
      // force-quit escape hatch instead of a single acknowledgement button.
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        title: 'DeepSeek Harness Desktop',
        message: '为保护会话记录，桌面端未退出。',
        detail: `${detail}\n\n可以先用「仍然退出」强制关闭；未完成的会话记录可能无法在下次启动时恢复。`,
        buttons: ['知道了', '仍然退出'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }
      const choice = mainWindow !== null && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options)
      if (choice.response === 1) {
        void diagnostics.log('用户选择仍然退出，已跳过会话持久化护栏')
        quitApproved = true
        app.exit(0)
      }
      return
    }
    quitApproved = true
    app.quit()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    void diagnostics.log(`桌面退出前会话校验失败，已取消退出：${detail}`)
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      title: 'DeepSeek Harness Desktop',
      message: '无法确认会话已完整保存，桌面端未退出。',
      detail: `${detail}\n\n可以先用「仍然退出」强制关闭；未完成的会话记录可能无法在下次启动时恢复。`,
      buttons: ['知道了', '仍然退出'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
    const choice = mainWindow !== null && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options)
    if (choice.response === 1) {
      void diagnostics.log('用户选择仍然退出，已跳过会话持久化护栏')
      quitApproved = true
      app.exit(0)
    }
  } finally {
    desktopExitInFlight = false
  }
}

function quitFromTray(): void {
  void requestSafeDesktopExit()
}

function resolveTrayIconPath(appRoot: string): string {
  const installedIconPath = join(process.resourcesPath, 'icon.ico')
  return existsSync(installedIconPath) ? installedIconPath : join(appRoot, 'resources', 'icon.ico')
}

function installTray(appRoot: string): void {
  if (process.platform !== 'win32' || tray !== null) return
  const iconPath = resolveTrayIconPath(appRoot)
  if (!existsSync(iconPath)) {
    void diagnostics.log(`系统托盘图标不存在：${iconPath}`)
    return
  }
  tray = new Tray(nativeImage.createFromPath(iconPath))
  tray.setToolTip('DeepSeek Harness Desktop')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 DeepSeek Harness', click: showMainWindow },
    { label: '隐藏窗口', click: hideMainWindow },
    { type: 'separator' },
    { label: '退出桌面端', click: quitFromTray },
  ]))
  tray.on('click', showMainWindow)
  tray.on('double-click', showMainWindow)
}

function installStatusPanelMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildStatusPanelMenu(toggleStatusPanelFromMenu)))
}

function scheduleDesktopRelaunch(): void {
  const helperPath = join(app.getAppPath(), 'dist-electron', 'main', 'restart-helper.js')
  const helper = spawn(resolveNodeExecutable(), buildRestartHelperArgs(
    helperPath,
    process.pid,
    process.execPath,
    process.argv,
  ), {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  helper.unref()
  void diagnostics.log('已安排桌面重启：等待旧进程退出后重新打开应用')
}

async function loadHarness(url: string): Promise<void> {
  if (harnessView === null || harnessLoader === null) return
  try {
    const authenticatedUrl = authenticatedHarnessAdvertisedUrl === url && authenticatedHarnessTargetUrl !== null
      ? authenticatedHarnessTargetUrl
      : await authenticateHarnessUrl(url)
    if (authenticatedUrl !== url) {
      authenticatedHarnessAdvertisedUrl = url
      authenticatedHarnessTargetUrl = authenticatedUrl
    }
    harnessLoader.setDesiredUrl(authenticatedUrl)
    await harnessLoader.load(authenticatedUrl)
  } catch (error) {
    harnessLoader.setDesiredUrl(null)
    harnessLoader.clearLoadedUrl()
    harnessView.setVisible(false)
    void diagnostics.log(`官方 Web UI 加载失败，将在恢复后重试：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * The DHS CLI advertises a one-time token URL. Electron's WebContentsView can
 * complete the 303 response without persisting its Set-Cookie header, leaving
 * the redirected root as an empty unauthenticated document. Exchange the token
 * in the main process and install the cookie explicitly before loading `/`.
 */
async function authenticateHarnessUrl(url: string): Promise<string> {
  if (harnessView === null) return url
  try {
    const parsed = new URL(url)
    if (parsed.searchParams.get('token') === null) return url
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000) })
    const setCookie = response.headers.get('set-cookie')
    if (setCookie === null) throw new Error(`认证地址未返回 Cookie（HTTP ${response.status}）`)
    const pair = setCookie.split(';', 1)[0]
    const separator = pair.indexOf('=')
    if (separator <= 0) throw new Error('认证 Cookie 格式无效')
    const name = pair.slice(0, separator)
    const value = pair.slice(separator + 1)
    const maxAge = /(?:^|;)\s*max-age=(\d+)/i.exec(setCookie)?.[1]
    const expires = /(?:^|;)\s*expires=([^;]+)/i.exec(setCookie)?.[1]
    const expirationDate = maxAge !== undefined
      ? Math.floor(Date.now() / 1000) + Number(maxAge)
      : expires !== undefined ? Math.floor(Date.parse(expires) / 1000) : undefined
    const cookies = await harnessView.webContents.session.cookies.get({ domain: parsed.hostname })
    const staleCookies = cookies.filter(cookie => cookie.name.startsWith('dsh-auth-'))
    const removalResults = await Promise.allSettled(staleCookies.map(cookie => harnessView!.webContents.session.cookies.remove(`${parsed.origin}/`, cookie.name)))
    const failedRemovals = removalResults.filter(result => result.status === 'rejected').length
    if (failedRemovals > 0) throw new Error(`清理过期认证 Cookie 失败（${failedRemovals}/${staleCookies.length}）`)
    if (staleCookies.length > 0) {
      void diagnostics.log(`已清理 ${staleCookies.length} 个过期 Harness 认证 Cookie`)
    }
    await harnessView.webContents.session.cookies.set({
      url: parsed.origin,
      name,
      value,
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      ...(expirationDate === undefined || !Number.isFinite(expirationDate) ? {} : { expirationDate }),
    })
    void diagnostics.log(`已写入 Harness 认证 Cookie：${parsed.origin}`)
    return parsed.origin + '/'
  } catch (error) {
    void diagnostics.log(`Harness 认证 Cookie 写入失败，已阻止本次页面加载：${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

function queueMaintenance<T>(operation: () => Promise<T>): Promise<T> {
  const next = maintenanceQueue.then(operation, operation)
  maintenanceQueue = next.then(() => undefined, () => undefined)
  return next
}

function knownRuntimeErrors(state: RuntimeState): string[] {
  const errors: string[] = []
  if (state.lastError !== null) errors.push(state.lastError)
  if (state.status === 'error') errors.push('运行时多次自动恢复失败，已停止自动重试')
  return errors
}

async function runRepairPipeline(): Promise<RepairReport> {
  const startedAt = new Date().toISOString()
  let checks: RepairCheck[] = createRepairChecks(REPAIR_PLAN)
  const knownErrors = knownRuntimeErrors(runtime.getState())
  const snapshot = (finishedAt: string | null): RepairReport => ({
    startedAt,
    finishedAt,
    knownErrors,
    checks: checks.map(check => ({ ...check })),
    fixedCount: checks.filter(check => check.status === 'fixed').length,
    state: runtime.getState(),
  })
  const broadcast = (): void => { sendDesktopEvent('desktop:repair-progress', snapshot(null)) }
  const update = (id: string, patch: Partial<Pick<RepairCheck, 'status' | 'problem' | 'detail'>>): void => {
    checks = updateRepairCheck(checks, id, patch)
    broadcast()
  }
  const beginCheck = async (id: string): Promise<void> => {
    update(id, { status: 'checking', problem: null, detail: '正在检查当前状态…' })
    await new Promise<void>(resolve => setTimeout(resolve, 80))
  }
  const beginRepair = async (id: string, problem: string): Promise<void> => {
    update(id, { status: 'repairing', problem, detail: '正在执行维修方法…' })
    await new Promise<void>(resolve => setTimeout(resolve, 80))
  }
  const complete = (id: string, status: RepairCheckStatus, detail: string, problem?: string): void => {
    update(id, { status, detail, ...(problem === undefined ? {} : { problem }) })
  }
  const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

  void diagnostics.log('开始手动维修 Harness 运行时')
  broadcast()

  try {
    await beginCheck('deps')
    const deps = await repairBundledAppDependencies()
    if (deps.fixed) {
      await beginRepair('deps', '检测到官方 workflow 依赖缺失或损坏')
      complete('deps', 'fixed', deps.detail)
    } else {
      complete('deps', 'ok', deps.detail, '未发现依赖问题')
    }
  } catch (error) {
    complete('deps', 'failed', message(error), '官方 workflow 依赖维修失败')
  }

  try {
    await beginCheck('locks')
    const taskBoardLock = join(runtimePaths?.dshHome ?? '', 'task-board', 'ledger-v2.lock')
    const profilePatchLock = join(runtimePaths?.dshHome ?? '', 'profiles', 'web', 'cordis.patch.yml.lock')
    const cleanedTaskBoard = await cleanupStaleProcessLock(taskBoardLock, isWindowsProcessAlive)
    const cleanedProfilePatch = await cleanupStaleProcessLock(profilePatchLock, pid => isWindowsDshProcessAlive(pid, runtimePaths?.dshHome ?? ''))
    if (cleanedTaskBoard || cleanedProfilePatch) {
      const cleanedParts = [
        ...(cleanedTaskBoard ? ['任务板'] : []),
        ...(cleanedProfilePatch ? ['Web profile 补丁'] : []),
      ]
      await beginRepair('locks', `发现陈旧进程锁：${cleanedParts.join('、')}`)
      complete('locks', 'fixed', `已清理${cleanedParts.join('、')}陈旧进程锁`)
    } else {
      complete('locks', 'ok', '未发现陈旧进程锁', '未发现问题')
    }
  } catch (error) {
    complete('locks', 'failed', message(error), '陈旧进程锁检查失败')
  }

  try {
    await beginCheck('profile')
    await beginRepair('profile', '正在确认 Web profile 依赖和兼容层')
    await startAfterProfilePreparation(profilePreparation, prepareActiveProfile)
    complete('profile', 'ok', '官方 Web 插件依赖已就绪', '未发现阻断运行的问题')
  } catch (error) {
    complete('profile', 'failed', message(error), 'Web profile 依赖维修失败')
  }

  try {
    await beginCheck('sessions')
    if (runtimePaths === null) throw new Error('运行目录尚未初始化')
    await beginRepair('sessions', '检查 DHS1 旧库中是否存在桌面端未显示的历史会话')
    projectSessionMerge = await mergeLegacyProjectSessions({
      legacyHome: join(app.getPath('home'), '.dsh'),
      targetHome: runtimePaths.dshHome,
      projectCwd: DHS1_PROJECT_CWD,
      backupRoot: join(app.getPath('userData'), 'migration-backups'),
    })
    if (projectSessionMerge.status === 'failed') {
      complete('sessions', 'failed', projectSessionMerge.error ?? 'DHS1 会话统一失败', '源数据已保留，未完成合并')
    } else if (projectSessionMerge.status === 'merged') {
      complete('sessions', 'fixed', `已合并 ${projectSessionMerge.copiedSessionIds.length} 条 DHS1 历史会话${projectSessionMerge.backupPath === null ? '' : `，备份已创建`}`)
    } else {
      complete('sessions', 'ok', `DHS1 会话已完整：${projectSessionMerge.sourceSessionIds.length} 条可用`, '未发现缺失记录')
    }
  } catch (error) {
    complete('sessions', 'failed', message(error), 'DHS1 会话库检查失败')
  }

  try {
    await beginCheck('provider-compatibility')
    if (runtimePaths === null) throw new Error('运行目录尚未初始化')
    const providerCompatibility = await repairOpenAiProviderCompatibility(join(runtimePaths.dshHome, 'settings.yaml'))
    if (providerCompatibility.changed) {
      await beginRepair('provider-compatibility', `发现 ${providerCompatibility.providerIds.length} 个 reasoning Provider 可能发送 developer role`)
      complete('provider-compatibility', 'fixed', `已修复 Provider：${providerCompatibility.providerIds.join('、')}`)
      void diagnostics.log(`已修复 OpenAI 兼容 Provider 的 developer role：${providerCompatibility.providerIds.join(', ')}`)
    } else {
      complete('provider-compatibility', 'ok', '未发现需要调整的 reasoning Provider 兼容配置', '未发现问题')
    }
  } catch (error) {
    complete('provider-compatibility', 'failed', message(error), '模型 Provider 兼容配置维修失败')
  }

  try {
    await beginCheck('vision-capability')
    if (runtimePaths === null) throw new Error('运行目录尚未初始化')
    const vision = await repairVisionCapabilities(runtimePaths.dshHome, { force: true })
    if (vision.changed) {
      const details: string[] = []
      if (vision.added.length > 0) details.push(`启用识图：${vision.added.join('、')}`)
      if (vision.removed.length > 0) details.push(`移除误标：${vision.removed.join('、')}`)
      complete('vision-capability', 'fixed', `已校准模型视觉能力；${details.join('；')}`)
      void diagnostics.log(`已按实际探测结果校准模型视觉能力：${details.join('；')}`)
    } else {
      complete('vision-capability', 'ok', '模型视觉能力与探测结果一致', '未发现不一致的识图能力声明')
    }
  } catch (error) {
    complete('vision-capability', 'failed', message(error), '模型视觉能力校准失败')
  }

  try {
    await beginCheck('data')
    if (runtimePaths === null) throw new Error('运行目录尚未初始化')
    const directories = [runtimePaths.userRuntimeRoot, runtimePaths.dshHome]
    const missing = directories.filter(path => !existsSync(path))
    if (missing.length > 0) {
      await beginRepair('data', `发现 ${missing.length} 个运行目录缺失`)
      await ensureRuntimeDirectories(runtimePaths)
      complete('data', 'fixed', `已创建 ${missing.length} 个缺失运行目录`)
    } else {
      await ensureRuntimeDirectories(runtimePaths)
      complete('data', 'ok', 'DSH_HOME 与运行时目录均可访问', '未发现问题')
    }
  } catch (error) {
    complete('data', 'failed', message(error), '运行目录维修失败')
  }

  try {
    await beginCheck('runtime')
    await beginRepair('runtime', '需要重启 Harness 并通过本机健康检查')
    const state = await runtime.restart()
    if (state.status === 'running' && state.port !== null) {
      complete('runtime', 'fixed', `官方 Harness 已恢复：127.0.0.1:${state.port}`)
    } else {
      complete('runtime', 'failed', `运行时未完全恢复（当前状态：${state.status}），自动恢复会继续尝试`, 'Harness 未通过健康检查')
    }
  } catch (error) {
    complete('runtime', 'failed', message(error), 'Harness 健康重启失败')
  }

  const report = snapshot(new Date().toISOString())
  void diagnostics.log(`Harness 运行时维修结束：${report.fixedCount} 项修复，${report.checks.filter(check => check.status === 'failed').length} 项失败`)
  return report
}

function registerIpc(): void {
  ipcMain.handle('desktop:get-snapshot', async (): Promise<RuntimeDiagnostics> => diagnostics.snapshot())
  ipcMain.handle('desktop:open-diagnostics', async (): Promise<void> => openDiagnosticsWindow())
  ipcMain.handle('desktop:open-repair-window', async (): Promise<void> => openRepairWindow())
  ipcMain.handle('desktop:close-repair-window', async (): Promise<void> => {
    if (repairWindow !== null && !repairWindow.isDestroyed()) repairWindow.close()
  })
  ipcMain.handle('desktop:set-shell-overlay-visible', async (_event, visible: boolean): Promise<void> => {
    if (harnessView === null || harnessView.webContents.isDestroyed()) return
    if (visible) {
      harnessView.setVisible(false)
      return
    }
    const current = runtime?.getState()
    if (current?.status === 'running' && current.url !== null) harnessView.setVisible(true)
  })
  ipcMain.handle('desktop:set-status-panel-expanded', async (_event, expanded: boolean): Promise<void> => {
    statusPanelExpanded = expanded
    resizeHarnessView()
  })
  ipcMain.handle('desktop:get-status-panel-expanded', async (): Promise<boolean> => statusPanelExpanded)
  ipcMain.handle('desktop:repair-runtime', async (): Promise<RepairReport> => queueMaintenance(() => runRepairPipeline()))
  ipcMain.handle('desktop:restart-desktop', async (): Promise<DesktopRestartResult> => {
    const confirmation = mainWindow !== null && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '重启 DeepSeek Harness',
        message: '确认重启桌面端吗？',
        detail: '当前窗口会关闭，运行时停止后将自动重新打开。',
        buttons: ['取消', '确认重启'],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
      })
      : await dialog.showMessageBox({
        type: 'warning',
        title: '重启 DeepSeek Harness',
        message: '确认重启桌面端吗？',
        detail: '当前窗口会关闭，运行时停止后将自动重新打开。',
        buttons: ['取消', '确认重启'],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
      })
    if (!shouldProceedWithDesktopRestart(confirmation.response)) return { restarted: false, report: null }
    const result = await restartDesktop({
      verifyBeforeStop: async () => {
        if (sessionDurability === null) throw new Error('会话持久化守卫尚未初始化')
        return sessionDurability.verifyForRestart()
      },
      stop: () => runtime.stop(),
      verifyAfterStop: async () => {
        if (sessionDurability === null) throw new Error('会话持久化守卫尚未初始化')
        return sessionDurability.verifyForRestart()
      },
      resumeAfterBlockedStop: async () => { await startRuntime() },
      relaunch: scheduleDesktopRelaunch,
      // Exit only after the runtime is stopped and the detached helper is
      // waiting. This releases the single-instance lock before relaunching.
      exit: code => {
        quitApproved = true
        mainWindow?.hide()
        app.exit(code)
      },
      onStopError: error => void diagnostics.log(`桌面重启前停止 Harness 失败，已取消重启：${error instanceof Error ? error.message : String(error)}`),
    })
    if (!result.restarted && result.report !== null) {
      for (const blocker of result.report.blockers) {
        void diagnostics.log(`已取消桌面重启：会话 ${blocker.sessionId} 尚未完整保存（${blocker.reason}）`)
      }
    }
    return result
  })
}

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === null || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    // Deny everything by default, but the official Web UI needs clipboard
    // write access for its copy buttons; a blanket denial silently breaks them.
    const allowedPermissions = new Set(['clipboard-write', 'clipboard-sanitized-write'])
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(allowedPermissions.has(permission))
    })
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => allowedPermissions.has(permission))
    await createServices()
    registerIpc()
    await createWindow()
    installTray(app.getAppPath())
    installStatusPanelMenu()
    await startAfterProfilePreparation(profilePreparation, startRuntime).catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      void diagnostics.log(`启动失败：${message}`)
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        title: 'DeepSeek Harness Desktop',
        message: '官方 Harness 运行时启动失败',
        detail: `${message}\n\n自动恢复会继续在后台尝试；可点击右上角「重启」或打开诊断窗口查看详情。`,
        buttons: ['好的'],
        noLink: true,
      }
      if (mainWindow !== null && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, options)
      else void dialog.showMessageBox(options)
    })
  }).catch(error => {
    // whenReady chain must never reject silently: surface the failure so the
    // user sees a dialog instead of an unresponsive black window.
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    if (diagnostics !== undefined) void diagnostics.log(`初始化失败：${message}`)
    void dialog.showErrorBox('DeepSeek Harness Desktop 初始化失败', message)
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (process.platform !== 'darwin') return
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    showMainWindow()
    return
  }
  void createWindow()
})

app.on('before-quit', event => {
  if (quitApproved || runtime === undefined) return
  event.preventDefault()
  void requestSafeDesktopExit()
})
