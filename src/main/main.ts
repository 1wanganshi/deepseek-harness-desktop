import { app, BrowserWindow, dialog, Menu, WebContentsView, Tray, nativeImage, ipcMain, session } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundledNpmDepsPath, bundledNpmScript, bundledPnpmScript, runCommand } from './command.js'
import { DiagnosticsStore } from './diagnostics.js'
import { migrateLegacyDsh, type LegacyMigrationStatus } from './migration.js'
import { ConfigurationDurabilityGuard } from './configuration-durability.js'
import { mergeLegacyProjectSessions, type ProjectSessionMergeStatus } from './session-merge.js'
import { SessionDurabilityGuard, recoverMissingSessionIndexes, repairWorkspaceLinks } from './session-durability.js'
import { readInstalledDshVersion } from './official-updates.js'
import { isLocalUrl } from './ports.js'
import { hasMissingProfileDependencies, prepareOfficialWebProfile } from './profile-preparation.js'
import { ensureClientStoreCompatibility, ensureVisionRouterCompatibility, synchronizeInstalledClientStoreCompatibility } from './compatibility.js'
import { mitigateIncompatibleTaskBoard, normalizeProfilePatchFile, migratePersonaPresetSchema } from './incompatible-plugins.js'
import { RuntimeController } from './runtime-controller.js'
import { createRuntimePaths, ensureRuntimeDirectories, resolveBundledRuntime, type ResolvedRuntime } from './runtime-paths.js'
import { cleanupStaleProcessLock, isWindowsDshProcessAlive, isWindowsProcessAlive } from './stale-locks.js'
import { removeLegacyDoctorSupervisor } from './doctor-supervisor.js'
import { startAfterProfilePreparation } from './startup-sequence.js'
import { buildRestartHelperArgs, restartDesktop, shutdownDesktop, shouldProceedWithDesktopRestart, type DesktopRestartResult } from './desktop-restart.js'
import { repairBundledDependencies } from './bundled-dependencies.js'
import { repairOpenAiProviderCompatibility } from './provider-compatibility.js'
import { shouldHideOnClose, shouldHideOnMinimize } from './desktop-shell.js'
import { createHarnessLoader, type HarnessLoader } from './harness-loader.js'
import { repairWindowOptions } from './repair-window.js'
import { buildStatusPanelMenu } from './status-panel-menu.js'
import { desktopWebPreferences } from './desktop-web-preferences.js'
import type { RepairCheck, RepairCheckStatus, RepairReport, RuntimeDiagnostics, RuntimeState } from '../shared/types.js'
import { REPAIR_PLAN } from '../shared/repair-plan.js'
import { createRepairChecks, updateRepairCheck } from '../shared/repair-progress.js'

const nodeExecutable = process.platform === 'win32'
  ? join(process.resourcesPath, 'node', 'node.exe')
  : process.execPath
const hasSingleInstanceLock = app.requestSingleInstanceLock()

let mainWindow: BrowserWindow | null = null
let harnessView: WebContentsView | null = null
let harnessLoader: HarnessLoader | null = null
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
let configurationDurability: ConfigurationDurabilityGuard | null = null
let authenticatedHarnessAdvertisedUrl: string | null = null
let authenticatedHarnessTargetUrl: string | null = null
let harnessMountRecoveryAttempts = 0
let harnessMountRecoveryInFlight = false
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
let projectSessionMerge: ProjectSessionMergeStatus = {
  status: 'not-found',
  projectCwd: 'D:\\vibecoding\\DHS1',
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

const DHS1_PROJECT_CWD = 'D:\\vibecoding\\DHS1'

const APP_USER_MODEL_ID = 'com.deepseek.harness.desktop'
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID)

const STATUS_PANEL_HEIGHT = 76
const MAX_HARNESS_MOUNT_RECOVERY_ATTEMPTS = 2
// When collapsed the official Web UI owns the full content area. The status
// control is available from the native application menu, so no black strip is
// reserved behind it.
const STATUS_LAUNCHER_HEIGHT = 0

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

  const log = async (line: string) => diagnostics?.log(line)
  runtime = new RuntimeController({
    resolveRuntime: async () => {
      activeRuntime = resolveBundledRuntime(paths, initialVersion)
      return activeRuntime
    },
    dshHome: paths.dshHome,
    nodeExecutable: resolveNodeExecutable(),
    log: line => { void log(line) },
    onState: state => {
      sendDesktopEvent('desktop:runtime-state', state)
      if (state.status === 'running' && state.url !== null) void loadHarness(state.url)
      if (state.status !== 'running') {
        authenticatedHarnessAdvertisedUrl = null
        authenticatedHarnessTargetUrl = null
        harnessLoader?.setDesiredUrl(null)
        harnessLoader?.clearLoadedUrl()
        harnessView?.setVisible(false)
      }
    },
  })
  sessionDurability = new SessionDurabilityGuard({
    dshHome: paths.dshHome,
    backupRoot: join(app.getPath('userData'), 'session-durability-backups'),
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
  const packagedNpmScript = bundledNpmScript(appRoot, process.resourcesPath)
  const npmScript = existsSync(packagedNpmScript) ? packagedNpmScript : bundledNpmScript(appRoot)
  const packagedNpmDeps = bundledNpmDepsPath(process.resourcesPath)
  const npmNodePath = existsSync(packagedNpmDeps)
    ? packagedNpmDeps
    : process.env.NODE_PATH
  const npmLoader = join(process.resourcesPath, 'npm-loader.cjs')
  const npmOptions = existsSync(npmLoader)
    ? [process.env.NODE_OPTIONS, `--require=${npmLoader}`].filter((value): value is string => Boolean(value)).join(' ')
    : process.env.NODE_OPTIONS
  const runNpm = (cwd: string, args: string[]) => runCommand(
    resolveNodeExecutable(),
    [npmScript, ...args],
    cwd,
    {
      ...process.env,
      DSH_HOME: paths.dshHome,
      ...(npmNodePath === undefined ? {} : { NODE_PATH: npmNodePath }),
      ...(npmOptions === undefined ? {} : { NODE_OPTIONS: npmOptions }),
      DSH_NPM_DEPS: npmNodePath ?? '',
    },
    { timeoutMs: 600_000 },
  )
  repairBundledAppDependencies = async () => {
    const workerPath = join(appRoot, 'node_modules', '@deepseek-ai', 'dsh-workflow-worker-thread')
    const workflowPath = join(appRoot, 'node_modules', '@deepseek-ai', 'dsh-workflow')
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
    // Never launch Harness against a partially rebuilt profile. Keeping the
    // rejection lets the startup gate show the real failure and leaves the
    // existing profile backup available for the repair flow.
    void diagnostics.log(`插件兼容层或依赖重建失败，已阻止启动：${detail}`)
    throw error
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
  const linked = await repairWorkspaceLinks(runtimePaths.dshHome, join(app.getPath('userData'), 'session-durability-backups'))
  if (recovered.length > 0) {
    void diagnostics.log(`已从持久化转录恢复 ${recovered.length} 个会话索引`)
  }
  if (linked.length > 0) void diagnostics.log(`已将 ${linked.length} 个会话重新挂回所属工作区`)
  const state = await runtime.start()
  await sessionDurability?.captureBaseline()
  return state
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
  mainWindow.once('ready-to-show', () => mainWindow?.show())
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
        try {
          const status = JSON.parse(rawStatus) as { rootChildren?: number; bodyText?: string; bootReady?: boolean }
          const bodyText = (status.bodyText ?? '').trim()
          if (bodyText.includes('Failed to load plugins')) {
            void diagnostics.log(`官方 Web UI 插件加载失败：${bodyText}`)
            return
          }
          if ((status.rootChildren ?? 0) > 0 || status.bootReady === true || bodyText !== '') {
            harnessMountRecoveryAttempts = 0
            harnessMountRecoveryInFlight = false
            return
          }
          scheduleHarnessMountRecovery('页面加载完成但未挂载', runtime.getState().url)
        } catch (error) {
          void diagnostics.log(`官方 Web UI 挂载状态解析失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }).catch(error => {
        void diagnostics.log(`官方 Web UI 挂载检查失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }
  })
  harnessView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    void diagnostics.log(`官方 Web UI 加载失败：code=${errorCode} ${errorDescription} url=${validatedURL} mainFrame=${isMainFrame}`)
    if (isMainFrame) scheduleHarnessMountRecovery(`加载失败 ${errorCode}`, runtime.getState().url)
  })
  harnessView.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    void diagnostics.log(`官方 Web UI 控制台：level=${level} ${message} (${sourceId}:${line})`)
  })
  harnessView.webContents.on('render-process-gone', () => {
    harnessMountRecoveryAttempts = 0
    harnessMountRecoveryInFlight = false
    authenticatedHarnessAdvertisedUrl = null
    authenticatedHarnessTargetUrl = null
    harnessLoader?.clearLoadedUrl()
    harnessLoader?.setDesiredUrl(null)
    harnessView?.setVisible(false)
    void diagnostics.log('官方 Web UI 渲染进程退出，开始重新连接')
    void startAfterProfilePreparation(profilePreparation, () => runtime.restart()).catch(() => undefined)
  })

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
  // The official Web UI fills the content area while collapsed. The shell
  // reserves space only for the fully expanded status bar.
  const topInset = statusPanelExpanded ? STATUS_PANEL_HEIGHT : STATUS_LAUNCHER_HEIGHT
  const bounds = { x: 0, y: topInset, width, height: Math.max(0, height - topInset) }
  harnessView.setBounds(bounds)
  void diagnostics?.log(`状态栏视图边界：${statusPanelExpanded ? '展开' : '隐藏'} y=${bounds.y} h=${bounds.height}`)
  // WebContentsView compositing can apply a stale bound for one frame while
  // the shell renderer is committing the panel state. Re-apply on the next
  // turn for both directions so a collapsed panel cannot leave a black strip.
  setTimeout(() => {
    if (mainWindow === null || harnessView === null) return
    const [nextWidth, nextHeight] = mainWindow.getContentSize()
    const nextInset = statusPanelExpanded ? STATUS_PANEL_HEIGHT : STATUS_LAUNCHER_HEIGHT
    harnessView.setBounds({ x: 0, y: nextInset, width: nextWidth, height: Math.max(0, nextHeight - nextInset) })
  }, 0)
}

function toggleStatusPanelFromMenu(): void {
  statusPanelExpanded = !statusPanelExpanded
  void diagnostics?.log(`状态栏菜单已切换：${statusPanelExpanded ? '展开' : '隐藏'}`)
  resizeHarnessView()
  sendDesktopEvent('desktop:status-panel-expanded', statusPanelExpanded)
}

function showMainWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
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
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        title: 'DeepSeek Harness Desktop',
        message: '为保护会话记录，桌面端未退出。',
        detail,
        buttons: ['知道了'],
        noLink: true,
      }
      if (mainWindow !== null && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, options)
      else void dialog.showMessageBox(options)
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
      detail,
      buttons: ['知道了'],
      noLink: true,
    }
    if (mainWindow !== null && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, options)
    else void dialog.showMessageBox(options)
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

function scheduleHarnessMountRecovery(reason: string, url: string | null): void {
  if (url === null || harnessView === null || harnessLoader === null || harnessMountRecoveryInFlight) return
  if (harnessMountRecoveryAttempts >= MAX_HARNESS_MOUNT_RECOVERY_ATTEMPTS) {
    void diagnostics.log(`官方 Web UI 连续挂载失败，已停止自动重试：${reason}`)
    harnessLoader.setDesiredUrl(null)
    harnessLoader.clearLoadedUrl()
    harnessView.setVisible(false)
    return
  }
  harnessMountRecoveryAttempts += 1
  harnessMountRecoveryInFlight = true
  authenticatedHarnessAdvertisedUrl = null
  authenticatedHarnessTargetUrl = null
  harnessLoader.setDesiredUrl(null)
  harnessLoader.clearLoadedUrl()
  void diagnostics.log(`官方 Web UI ${reason}，准备第 ${harnessMountRecoveryAttempts} 次自动重试`)
  setTimeout(() => {
    harnessMountRecoveryInFlight = false
    if (runtime.getState().url === url) void loadHarness(url)
  }, 300)
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
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
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

app.on('before-quit', event => {
  if (quitApproved || runtime === undefined) return
  event.preventDefault()
  void requestSafeDesktopExit()
})
