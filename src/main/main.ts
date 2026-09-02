import { app, BrowserWindow, dialog, WebContentsView, ipcMain, session } from 'electron'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundledPnpmScript, runCommand } from './command.js'
import { DiagnosticsStore } from './diagnostics.js'
import { migrateLegacyDsh, type LegacyMigrationStatus } from './migration.js'
import { OfficialUpdateService, readInstalledDshVersion } from './official-updates.js'
import { isLocalUrl } from './ports.js'
import { PluginManager } from './plugin-manager.js'
import { prepareOfficialWebProfile } from './profile-preparation.js'
import { synchronizeInstalledClientStoreCompatibility } from './compatibility.js'
import { mitigateIncompatibleTaskBoard } from './incompatible-plugins.js'
import { RuntimeController } from './runtime-controller.js'
import { validateDshRuntime } from './runtime-health.js'
import { createRuntimePaths, ensureRuntimeDirectories, resolveActiveRuntime, type ResolvedRuntime } from './runtime-paths.js'
import { cleanupStaleProcessLock, isWindowsProcessAlive } from './stale-locks.js'
import { startAfterProfilePreparation } from './startup-sequence.js'
import type { RuntimeDiagnostics, RuntimeState, UpdateStatus } from '../shared/types.js'

const nodeExecutable = process.platform === 'win32'
  ? join(process.resourcesPath, 'node', 'node.exe')
  : process.execPath
const hasSingleInstanceLock = app.requestSingleInstanceLock()

let mainWindow: BrowserWindow | null = null
let harnessView: WebContentsView | null = null
let currentUrl: string | null = null
let runtime: RuntimeController
let updateService: OfficialUpdateService
let pluginManager: PluginManager
let diagnostics: DiagnosticsStore
let activeRuntime: ResolvedRuntime
let diagnosticsWindow: BrowserWindow | null = null
let statusPanelExpanded = false
let maintenanceQueue = Promise.resolve()
let updateTimer: ReturnType<typeof setInterval> | null = null
let profilePreparation: Promise<void> = Promise.resolve()
let prepareActiveProfile: () => Promise<void> = async () => undefined
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

function bundledVersion(appRoot: string): Promise<string> {
  return readInstalledDshVersion(appRoot)
}

function resolveNodeExecutable(): string {
  return existsSync(nodeExecutable) ? nodeExecutable : 'node'
}

async function createServices(): Promise<void> {
  const appRoot = app.getAppPath()
  const paths = createRuntimePaths(appRoot, app.getPath('userData'))
  await ensureRuntimeDirectories(paths)
  const initialVersion = await bundledVersion(appRoot)
  activeRuntime = await resolveActiveRuntime(paths, initialVersion)

  const log = async (line: string) => diagnostics?.log(line)
  runtime = new RuntimeController({
    resolveRuntime: async () => {
      activeRuntime = await resolveActiveRuntime(paths, initialVersion)
      return activeRuntime
    },
    dshHome: paths.dshHome,
    nodeExecutable: resolveNodeExecutable(),
    log: line => { void log(line) },
    onState: state => {
      mainWindow?.webContents.send('desktop:runtime-state', state)
      if (state.status === 'running' && state.url !== null) void loadHarness(state.url)
      if (state.status !== 'running') {
        currentUrl = null
        harnessView?.setVisible(false)
      }
    },
  })

  const pnpmScript = bundledPnpmScript(appRoot)
  const runPnpm = (cwd: string, args: string[]) => runCommand(
    resolveNodeExecutable(),
    [pnpmScript, ...args],
    cwd,
    { ...process.env, DSH_HOME: paths.dshHome },
    { timeoutMs: 600_000 },
  )
  updateService = new OfficialUpdateService({
    paths,
    currentVersion: async () => readInstalledDshVersion(activeRuntime.root),
    runPnpm,
    healthValidate: candidateRoot => validateDshRuntime({
      runtimeRoot: candidateRoot,
      nodeExecutable: resolveNodeExecutable(),
      dshHome: paths.dshHome,
    }),
  })
  pluginManager = new PluginManager({ dshHome: paths.dshHome, runPnpm })
  diagnostics = new DiagnosticsStore({
    userDataPath: app.getPath('userData'),
    getRuntimeRoot: () => activeRuntime.root,
    dshHome: paths.dshHome,
    getState: () => runtime.getState(),
    getUpdate: () => updateService.getStatus(),
    getMigration: () => migration,
  })

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

  const taskBoardLock = join(paths.dshHome, 'task-board', 'ledger-v2.lock')
  if (await cleanupStaleProcessLock(taskBoardLock, isWindowsProcessAlive)) {
    void diagnostics.log('已清理任务板陈旧进程锁，原进程已不存在')
  }

  const profilePath = join(paths.dshHome, 'profiles', 'web')
  const profileNodeModules = join(profilePath, 'node_modules')
  const profilePackagePath = join(profilePath, 'package.json')
  if (existsSync(profilePackagePath)) {
    // Preparation can rebuild the profile dependency tree. Keep it separate
    // from window creation, but never let the Harness boot while pnpm is
    // changing files that the Harness will load.
    prepareActiveProfile = async () => {
      activeRuntime = await resolveActiveRuntime(paths, initialVersion)
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
  try {
    const lockfile = join(profilePath, 'pnpm-lock.yaml')
    const compatibilityPackagePath = join(profileNodeModules, '@deepseek-ai', 'dsh-client-store', 'package.json')
    const compatibilityPatchPath = join(profileNodeModules, '@deepseek-ai', 'dsh-client-store', 'cordis.patch.yml')
    const compatibilityClientPath = join(profileNodeModules, '@deepseek-ai', 'dsh-client-store', 'client.js')
    const preparation = await prepareOfficialWebProfile({
      dshHome: paths.dshHome,
      profilePath,
      packagePath: profilePackagePath,
      nodeModulesPresent: existsSync(profileNodeModules),
      dependencyInstallRequired: migrationStatus === 'migrated'
        || !existsSync(compatibilityPackagePath)
        || !existsSync(compatibilityPatchPath)
        || !existsSync(compatibilityClientPath),
      lockfilePresent: existsSync(lockfile),
      install: args => runPnpm(profilePath, args),
    })
    if (await synchronizeInstalledClientStoreCompatibility({ dshHome: paths.dshHome, profilePath })) {
      void diagnostics.log('已同步旧版 Web 插件兼容包文件')
    }
    if (preparation.compatibilityChanged) void diagnostics.log('已启用旧版 Web 插件兼容层：dsh-client-store → 官方 dsh-client-runtime')
    if (preparation.rebuiltDependencies) void diagnostics.log('已为官方 Web profile 重建插件依赖')
    const mitigation = await mitigateIncompatibleTaskBoard({ profilePath, runtimeVersion })
    if (mitigation.taskBoardDisabled) {
      void diagnostics.log('当前官方 Harness 版本低于任务板插件要求，已只禁用任务板入口；插件文件和配置仍保留')
    } else if (mitigation.changed) {
      void diagnostics.log('官方 Harness 已满足任务板插件版本要求，已移除临时兼容覆盖')
    }
  } catch (error) {
    void diagnostics.log(`插件兼容层或依赖重建暂未完成，可在诊断窗口手动同步：${error instanceof Error ? error.message : String(error)}`)
  }
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
      preload: fileURLToPath(new URL('../preload.js', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('resize', () => resizeHarnessView())
  mainWindow.on('closed', () => {
    mainWindow = null
    harnessView = null
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
  harnessView.webContents.on('render-process-gone', () => {
    void diagnostics.log('官方 Web UI 渲染进程退出，开始重新连接')
    void startAfterProfilePreparation(profilePreparation, () => runtime.restart()).catch(() => undefined)
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl !== undefined) await mainWindow.loadURL(devUrl)
  else await mainWindow.loadFile(join(appRoot, 'dist', 'index.html'))
  // BrowserWindow's own WebContentsView is created while loading the shell.
  // Add the official Harness view afterwards so the shell background cannot
  // cover it in Chromium's view compositor.
  mainWindow.contentView.addChildView(harnessView)
  harnessView.setVisible(false)
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
      preload: fileURLToPath(new URL('../preload.js', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  diagnosticsWindow.on('closed', () => { diagnosticsWindow = null })
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl !== undefined) await diagnosticsWindow.loadURL(`${devUrl}?diagnostics=1`)
  else await diagnosticsWindow.loadFile(join(appRoot, 'dist', 'index.html'), { query: { diagnostics: '1' } })
}

function resizeHarnessView(): void {
  if (mainWindow === null || harnessView === null) return
  const [width, height] = mainWindow.getContentSize()
  // Keep a slim native-shell strip for the compact status launcher. The full
  // control bar only reserves its height while explicitly expanded.
  const topInset = statusPanelExpanded ? 76 : 48
  harnessView.setBounds({ x: 0, y: topInset, width, height: Math.max(0, height - topInset) })
}

async function loadHarness(url: string): Promise<void> {
  if (harnessView === null || currentUrl === url) return
  harnessView.setVisible(true)
  try {
    await harnessView.webContents.loadURL(url)
    currentUrl = url
  } catch (error) {
    // A failed load (server restarted under us, transient race) must not pin
    // currentUrl, or later recovery would consider the view already loaded and
    // leave a black WebContentsView forever.
    currentUrl = null
    void diagnostics.log(`官方 Web UI 加载失败，将在恢复后重试：${error instanceof Error ? error.message : String(error)}`)
  }
}

function queueMaintenance<T>(operation: () => Promise<T>): Promise<T> {
  const next = maintenanceQueue.then(operation, operation)
  maintenanceQueue = next.then(() => undefined, () => undefined)
  return next
}

async function checkForUpdateAndBroadcast(): Promise<UpdateStatus> {
  const status = await updateService.check()
  mainWindow?.webContents.send('desktop:update-status', status)
  return status
}

function registerIpc(): void {
  ipcMain.handle('desktop:get-snapshot', async (): Promise<RuntimeDiagnostics> => diagnostics.snapshot())
  ipcMain.handle('desktop:open-diagnostics', async (): Promise<void> => openDiagnosticsWindow())
  ipcMain.handle('desktop:set-status-panel-expanded', async (_event, expanded: boolean): Promise<void> => {
    statusPanelExpanded = expanded
    resizeHarnessView()
  })
  ipcMain.handle('desktop:repair-runtime', async (): Promise<RuntimeState> => queueMaintenance(async () => {
    void diagnostics.log('开始手动维修 Harness 运行时')
    await startAfterProfilePreparation(profilePreparation, prepareActiveProfile)
    const state = await runtime.restart()
    void diagnostics.log('Harness 运行时维修完成')
    return state
  }))
  ipcMain.handle('desktop:restart-desktop', async (): Promise<void> => {
    await runtime.stop()
    app.relaunch()
    app.exit(0)
  })
  ipcMain.handle('desktop:check-update', async (): Promise<UpdateStatus> => checkForUpdateAndBroadcast())
  ipcMain.handle('desktop:install-update', async (): Promise<UpdateStatus> => queueMaintenance(async () => {
    const status = await updateService.install()
    mainWindow?.webContents.send('desktop:update-status', status)
    profilePreparation = prepareActiveProfile()
    await profilePreparation
    await runtime.restart()
    return status
  }))
  ipcMain.handle('desktop:sync-plugins', async () => queueMaintenance(async () => {
    await runtime.stop()
    try {
      const status = await pluginManager.sync()
      profilePreparation = prepareActiveProfile()
      await profilePreparation
      await runtime.start()
      return status
    } catch (error) {
      await startAfterProfilePreparation(profilePreparation, () => runtime.start()).catch(startError => diagnostics.log(`插件同步后恢复 Harness 失败：${startError instanceof Error ? startError.message : String(startError)}`))
      throw error
    }
  }))
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
    void checkForUpdateAndBroadcast()
    updateTimer = setInterval(() => { void checkForUpdateAndBroadcast() }, 24 * 60 * 60 * 1_000)
    await startAfterProfilePreparation(profilePreparation, () => runtime.start()).catch(error => {
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

let quitting = false
app.on('before-quit', event => {
  if (quitting || runtime === undefined) return
  event.preventDefault()
  quitting = true
  if (updateTimer !== null) clearInterval(updateTimer)
  void runtime.stop().finally(() => app.quit())
})
