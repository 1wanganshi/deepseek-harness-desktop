import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Activity, ArrowUpCircle, Check, ChevronUp, CircleAlert, CircleCheck, CircleX, Cpu, ExternalLink, ListChecks, RefreshCw, Wrench, X } from 'lucide-react'
import type { DesktopApi, PluginStatus, RepairCheck, RepairReport, RuntimeDiagnostics, RuntimeState, UpdateStatus } from '../shared/types.js'
import { REPAIR_PLAN } from '../shared/repair-plan.js'
import { repairStatusLabel } from '../shared/repair-progress.js'
import { createStatusPanelTransition } from './status-panel-transition.js'
import { updateBadgeLabel } from './status-copy.js'
import { getUpdateDialogKind } from './update-flow.js'
import { shouldAutoStartRepair } from './repair-flow.js'
import './styles.css'

const fallbackState: RuntimeState = {
  status: 'starting',
  version: 'unknown',
  port: null,
  url: null,
  recoveryAttempt: 0,
  lastError: null,
  lastHealthyAt: null,
}

const previewDiagnostics: RuntimeDiagnostics = {
  state: { ...fallbackState, status: 'running', version: '0.1.1-rc.2', port: 3080, url: 'http://127.0.0.1:3080' },
  desktopVersion: '0.2.3',
  runtimeRoot: 'Preview mode — Electron runtime path appears here in the desktop app',
  dshHome: 'Preview mode — isolated DSH_HOME appears here in the desktop app',
  recentLogs: [],
  pluginCount: 0,
  pluginNames: [],
  latestVersion: null,
  updateAvailable: false,
  migration: {
    status: 'not-found',
    legacyHome: '',
    targetHome: '',
    backupPath: null,
    migratedAt: null,
    pluginNames: [],
    copiedPaths: [],
    error: null,
  },
  projectSessionMerge: {
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
  },
}

const previewRepairReport: RepairReport = {
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  knownErrors: [],
  checks: [],
  fixedCount: 0,
  state: previewDiagnostics.state,
}

const previewApi: DesktopApi = {
  getSnapshot: async () => previewDiagnostics,
  openDiagnostics: async () => undefined,
  openRepairWindow: async () => undefined,
  closeRepairWindow: async () => undefined,
  setShellOverlayVisible: async () => undefined,
  setStatusPanelExpanded: async () => undefined,
  getStatusPanelExpanded: async () => false,
  repairRuntime: async () => previewRepairReport,
  restartDesktop: async () => false,
  checkForUpdate: async () => ({ currentVersion: '0.1.1-rc.2', latestVersion: null, updateAvailable: false, checkedAt: new Date().toISOString(), error: null }),
  installUpdate: async () => ({ currentVersion: '0.1.1-rc.2', latestVersion: '0.1.1-rc.2', updateAvailable: false, checkedAt: new Date().toISOString(), error: null }),
  syncPlugins: async () => ({ profilePath: previewDiagnostics.dshHome, names: [], canSync: true, lastSyncedAt: new Date().toISOString(), error: null }),
  onRuntimeState: () => () => undefined,
  onUpdateState: () => () => undefined,
  onStatusPanelExpanded: () => () => undefined,
  onRepairProgress: () => () => undefined,
}

const desktopApi = window.desktopApi ?? previewApi

type UpdateDialogProps = {
  open: boolean
  status: UpdateStatus | null
  busy: boolean
  onClose: () => void
  onRetry: () => void
  onInstall: () => void
}

function UpdateDialog({ open, status, busy, onClose, onRetry, onInstall }: UpdateDialogProps): ReactElement | null {
  if (!open) return null
  const kind = getUpdateDialogKind(status)
  const canInstall = kind === 'available' && !busy
  const title = kind === 'checking'
    ? '正在检查官方更新'
    : kind === 'available'
      ? '发现新版本'
      : kind === 'error'
        ? '更新检查失败'
        : '当前已经是最新版本'
  const detail = kind === 'checking'
    ? '正在调用 DHS 官方公开版本接口，请稍候。'
    : kind === 'available'
      ? `当前版本 v${status?.currentVersion ?? 'unknown'}，可更新到 v${status?.latestVersion ?? 'unknown'}。`
      : kind === 'error'
        ? status?.error ?? '无法连接官方版本接口。'
        : `当前版本 v${status?.currentVersion ?? 'unknown'}${status?.latestVersion ? `，官方最新版本为 v${status.latestVersion}` : ''}。`

  return <div className="modal-backdrop" role="presentation">
    <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title">
      <div className="confirm-dialog-heading">
        <div className={`confirm-dialog-icon ${kind === 'error' ? 'danger' : kind === 'available' ? 'attention' : ''}`}>
          {kind === 'checking' ? <RefreshCw size={18} className="spin" /> : kind === 'error' ? <CircleAlert size={18} /> : kind === 'available' ? <ArrowUpCircle size={18} /> : <CircleCheck size={18} />}
        </div>
        <button className="icon-button" onClick={onClose} disabled={busy} title="关闭" aria-label="关闭更新窗口"><X size={15} /></button>
      </div>
      <h2 id="update-dialog-title">{title}</h2>
      <p>{detail}</p>
      {kind === 'available' && <div className="update-dialog-method"><span>更新内容</span><strong>下载官方 DHS 运行时，完成健康检查后重新连接</strong></div>}
      {kind === 'checking' && <div className="update-dialog-progress"><RefreshCw size={14} className="spin" /> 正在读取版本信息</div>}
      {kind === 'error' && <button className="text-button" onClick={onRetry} disabled={busy}><RefreshCw size={13} /> 重新检查</button>}
      <div className="confirm-dialog-actions">
        {kind === 'available' && <button className="secondary-button" onClick={onClose} disabled={busy}>稍后更新</button>}
        {kind === 'available' && <button className="primary-button" onClick={onInstall} disabled={!canInstall}><ArrowUpCircle size={14} /> 立即更新</button>}
        {kind === 'latest' && <button className="primary-button" onClick={onClose}><Check size={14} /> 知道了</button>}
        {kind === 'error' && <button className="secondary-button" onClick={onClose}>关闭</button>}
        {kind === 'checking' && <button className="secondary-button" onClick={onClose} disabled={busy}>取消</button>}
      </div>
    </section>
  </div>
}

function statusLabel(state: RuntimeState): string {
  if (state.status === 'running') return '稳定运行中'
  if (state.status === 'recovering') return '正在自动恢复'
  if (state.status === 'starting') return '正在启动'
  if (state.status === 'error') return '需要诊断'
  return '已停止'
}

function statusTone(state: RuntimeState): string {
  if (state.status === 'running') return 'healthy'
  if (state.status === 'error') return 'danger'
  return 'warming'
}

function ControlBar(): ReactElement {
  const [state, setState] = useState<RuntimeState>(fallbackState)
  const [desktopVersion, setDesktopVersion] = useState('unknown')
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [updateDialogStatus, setUpdateDialogStatus] = useState<UpdateStatus | null>(null)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const [updateDialogBusy, setUpdateDialogBusy] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const panelTransition = useRef<ReturnType<typeof createStatusPanelTransition> | null>(null)

  if (panelTransition.current === null) {
    panelTransition.current = createStatusPanelTransition(
      nextExpanded => desktopApi.setStatusPanelExpanded(nextExpanded),
      () => undefined,
    )
  }

  const requestExpanded = (nextExpanded: boolean): void => {
    const transition = panelTransition.current
    if (transition === null) return
    void transition(nextExpanded).catch(error => {
      setNotice(error instanceof Error ? error.message : String(error))
    })
  }

  const closeUpdateDialog = (): void => {
    setUpdateDialogOpen(false)
    void desktopApi.setShellOverlayVisible(false)
  }

  useEffect(() => {
    void desktopApi.getSnapshot().then(snapshot => {
      setState(snapshot.state)
      setDesktopVersion(snapshot.desktopVersion)
      setUpdate({
        currentVersion: snapshot.state.version,
        latestVersion: snapshot.latestVersion,
        updateAvailable: snapshot.updateAvailable,
        checkedAt: null,
        error: null,
      })
    }).catch(() => setNotice('控制面暂时无法读取运行状态'))
    const unsubscribeRuntime = desktopApi.onRuntimeState(nextState => {
      setState(nextState)
    })
    const unsubscribePanel = desktopApi.onStatusPanelExpanded(() => undefined)
    return () => {
      unsubscribeRuntime()
      unsubscribePanel()
    }
  }, [])
  useEffect(() => desktopApi.onUpdateState(setUpdate), [])

  const refreshUpdateDialog = async (): Promise<void> => {
    setUpdateDialogBusy(true)
    try {
      const result = await desktopApi.checkForUpdate()
      setUpdate(result)
      setUpdateDialogStatus(result)
    } catch (error) {
      setUpdateDialogStatus({
        currentVersion: update?.currentVersion ?? state.version,
        latestVersion: null,
        updateAvailable: false,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setUpdateDialogBusy(false)
    }
  }

  const openUpdateDialog = (): void => {
    void desktopApi.setShellOverlayVisible(true).then(() => {
      setUpdateDialogOpen(true)
      setUpdateDialogStatus(update)
      if (update === null || update.checkedAt === null) void refreshUpdateDialog()
    }).catch(error => setNotice(error instanceof Error ? error.message : String(error)))
  }

  const installUpdate = async (): Promise<void> => {
    setUpdateDialogBusy(true)
    try {
      const result = await desktopApi.installUpdate()
      setUpdate(result)
      setUpdateDialogStatus(result)
      closeUpdateDialog()
      setNotice(`已更新到 v${result.currentVersion}，正在重新连接`)
    } catch (error) {
      setUpdateDialogStatus({
        ...(updateDialogStatus ?? update ?? { currentVersion: state.version, latestVersion: null, updateAvailable: false, checkedAt: null, error: null }),
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setUpdateDialogBusy(false)
    }
  }

  const runAction = async (key: string, action: () => Promise<unknown>, message: string) => {
    setBusy(key)
    setNotice(null)
    try {
      await action()
      setNotice(message)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const restartDesktop = async (): Promise<void> => {
    setBusy('desktop')
    setNotice(null)
    try {
      const confirmed = await desktopApi.restartDesktop()
      if (!confirmed) setNotice('已取消重启')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  return <>
    {/*
     * The native WebContentsView controls whether this mounted bar is visible:
     * it covers the shell from y=0 while collapsed and starts below the bar
     * when expanded. Keeping the bar mounted avoids a React/IPC race where a
     * native menu click could reveal the strip before React rendered it.
     */}
    <header className="control-bar" role="status">
      <div className="brand-lockup">
        <div className="brand-mark"><Cpu size={13} strokeWidth={2.4} /></div>
        <div>
          <div className="brand-name">DeepSeek Harness <span className="version">桌面端 v{desktopVersion}</span></div>
          <div className="brand-subtitle">官方 DHS v{state.version}</div>
        </div>
      </div>
      <div className="runtime-indicator">
        <span className={`status-dot ${statusTone(state)}`} />
        <span>{statusLabel(state)}</span>
        {state.recoveryAttempt > 0 && <span className="attempt">第 {state.recoveryAttempt} 次</span>}
      </div>
      <div className="bar-spacer" />
      {notice !== null && <div className="top-notice" title={notice}>{notice}</div>}
      <button className={`update-chip ${update?.updateAvailable ? 'has-update' : ''}`} onClick={openUpdateDialog} disabled={busy !== null || updateDialogBusy} title={update?.latestVersion ? `${updateBadgeLabel(update)}：v${update.latestVersion}` : '检查官方更新'}>
        <span className="update-chip-icon"><ArrowUpCircle size={13} />{update?.updateAvailable && <span className="update-dot" />}</span> 更新
      </button>
      <button className="icon-button" onClick={() => void runAction('diagnostics', () => desktopApi.openDiagnostics(), '诊断窗口已打开')} title="打开诊断">
        <Activity size={17} />
      </button>
      <button className="secondary-button repair-button" onClick={() => void runAction('repair-window', () => desktopApi.openRepairWindow(), '维修窗口已打开')} disabled={busy !== null} title="查看维修计划">
        <Wrench size={14} /> 维修
      </button>
      <button className="primary-button" onClick={() => void restartDesktop()} disabled={busy !== null}>
        <RefreshCw size={15} className={busy === 'desktop' ? 'spin' : ''} /> 重启
      </button>
      <button className="icon-button" onClick={() => requestExpanded(false)} title="隐藏状态栏" aria-label="隐藏状态栏">
        <ChevronUp size={17} />
      </button>
    </header>
    <UpdateDialog open={updateDialogOpen} status={updateDialogStatus} busy={updateDialogBusy} onClose={closeUpdateDialog} onRetry={() => void refreshUpdateDialog()} onInstall={() => void installUpdate()} />
    {state.status !== 'running' && <main className="runtime-placeholder">
      <div className="runtime-placeholder-card">
        <div className={`placeholder-icon ${statusTone(state)}`}><RefreshCw size={22} className={state.status === 'recovering' || state.status === 'starting' ? 'spin' : ''} /></div>
        <h1>{statusLabel(state)}</h1>
        <p>{state.status === 'error'
          ? '官方 Harness 暂时无法启动。你的模型、凭据和会话仍保存在本机。'
          : '正在重新建立本机连接，官方页面会在服务恢复后自动打开。'}</p>
        {state.lastError && <code>{state.lastError}</code>}
        <div className="placeholder-actions">
          <button className="secondary-button" onClick={() => void runAction('repair-window', () => desktopApi.openRepairWindow(), '维修窗口已打开')} disabled={busy !== null}>
            <Wrench size={15} className={busy === 'repair' ? 'spin' : ''} /> 立即维修
          </button>
          <button className="icon-button" onClick={() => void runAction('diagnostics', () => desktopApi.openDiagnostics(), '诊断窗口已打开')} title="打开诊断">
            <Wrench size={17} />
          </button>
        </div>
      </div>
    </main>}
  </>
}

function RepairPage(): ReactElement {
  const [report, setReport] = useState<RepairReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const startRepair = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    setReport(null)
    try {
      const result = await desktopApi.repairRuntime()
      setReport(result)
      setNotice(`维修完成：${result.fixedCount} 项已处理`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const statusFor = (id: string): RepairCheck['status'] => report?.checks.find(check => check.id === id)?.status ?? 'pending'
  const checkFor = (id: string): RepairCheck | undefined => report?.checks.find(check => check.id === id)
  const completedCount = report?.checks.filter(check => ['ok', 'fixed', 'failed', 'skipped'].includes(check.status)).length ?? 0
  const failedCount = report?.checks.filter(check => check.status === 'failed').length ?? 0
  const activeCheck = report?.checks.find(check => check.status === 'checking' || check.status === 'repairing')
  const finished = report?.finishedAt !== null && report?.finishedAt !== undefined
  const headline = busy
    ? activeCheck?.status === 'repairing' ? '正在修复发现的问题' : '正在逐项检查'
    : finished
      ? failedCount > 0 ? '维修结束，仍有项目失败' : '维修完成'
      : `准备执行 ${REPAIR_PLAN.length} 项检查`

  const confirmRepair = (): void => {
    if (finished && !busy) void desktopApi.closeRepairWindow()
    else void startRepair()
  }

  useEffect(() => {
    const unsubscribe = desktopApi.onRepairProgress(setReport)
    if (shouldAutoStartRepair(window.location.search)) void startRepair()
    return unsubscribe
  }, [])

  return <main className="repair-window-page">
    <section className="repair-plan-panel" role="dialog" aria-label="维修计划">
      <div className="repair-plan-heading">
        <div><div className="repair-plan-kicker"><ListChecks size={14} /> 维修计划</div><strong>{headline}</strong></div>
        <button className="icon-button" onClick={() => void desktopApi.closeRepairWindow()} title="关闭维修计划" aria-label="关闭维修计划"><X size={15} /></button>
      </div>
      <div className="repair-progress-summary">
        <div><span>当前状态</span><strong>{activeCheck ? `${activeCheck.status === 'checking' ? '检查' : '修复'}：${activeCheck.label}` : finished ? failedCount > 0 ? '需要人工处理' : '全部完成' : '等待开始'}</strong></div>
        <div><span>进度</span><strong>{completedCount} / {REPAIR_PLAN.length}</strong></div>
      </div>
      {report?.knownErrors.length ? <div className="repair-known-errors"><CircleAlert size={13} /><span>已知问题：{report.knownErrors.join('；')}</span></div> : null}
      <ol className="repair-plan-list">
        {REPAIR_PLAN.map((step, index) => {
          const status = statusFor(step.id)
          const check = checkFor(step.id)
          const detail = check?.detail
          return <li key={step.id} className={`repair-plan-item ${status}`}>
            <span className="repair-plan-icon">{status === 'pending' ? <span className="repair-plan-number">{index + 1}</span> : status === 'checking' || status === 'repairing' ? <RefreshCw size={14} className="spin" /> : status === 'failed' ? <CircleX size={15} /> : <Check size={15} />}</span>
            <span className="repair-plan-copy"><strong>{step.label}</strong><small>检查：{step.description}</small><small>维修：{step.repairMethod}</small>{check?.problem && <small className="repair-problem">问题：{check.problem}</small>}{detail && <small className="repair-detail">{detail}</small>}</span>
            <span className="repair-plan-status">{repairStatusLabel(status)}</span>
          </li>
        })}
      </ol>
      <div className="repair-plan-footer"><span>{notice ?? (finished ? `${report?.fixedCount ?? 0} 项已修复${failedCount > 0 ? `，${failedCount} 项失败` : ''}` : '不会删除会话、凭据或插件配置')}</span><button className="secondary-button repair-button" onClick={confirmRepair} disabled={busy}>{busy ? <RefreshCw size={13} className="spin" /> : finished ? <Check size={13} /> : <Wrench size={13} />} {busy ? '执行中' : finished ? '确认' : '开始维修'}</button></div>
    </section>
  </main>
}

function DiagnosticsPage(): ReactElement {
  const [snapshot, setSnapshot] = useState<RuntimeDiagnostics | null>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [plugins, setPlugins] = useState<PluginStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const refresh = async () => {
    const next = await desktopApi.getSnapshot()
    setSnapshot(next)
    setPlugins({ profilePath: next.dshHome, names: next.pluginNames, canSync: true, lastSyncedAt: null, error: null })
  }
  useEffect(() => { void refresh() }, [])

  const checkUpdate = async () => {
    setBusy(true)
    try { setUpdate(await desktopApi.checkForUpdate()); setMessage('已完成官方版本检查') }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const syncPlugins = async () => {
    setBusy(true)
    try { setPlugins(await desktopApi.syncPlugins()); setMessage('插件同步流程已执行'); await refresh() }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const repairRuntime = async () => {
    setBusy(true)
    try {
      await desktopApi.repairRuntime()
      setMessage('运行时维修已启动')
      await refresh()
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  if (snapshot === null) return <main className="diagnostics-page"><div className="loading"><Activity className="spin" /> 正在读取诊断信息…</div></main>
  const migrationLabel = snapshot.migration.status === 'migrated'
    ? '已从旧 DHS_HOME 迁移'
    : snapshot.migration.status === 'already-migrated'
      ? '已完成迁移'
      : snapshot.migration.status === 'failed'
        ? '迁移失败，已回滚'
        : '未发现旧 DHS_HOME'
  const projectMerge = snapshot.projectSessionMerge
  const projectMergeLabel = projectMerge.status === 'merged'
    ? `已统一 DHS1：新增 ${projectMerge.copiedSessionIds.length} 条会话${projectMerge.workspaceUpdated ? `，工作区已恢复` : ''}`
    : projectMerge.status === 'already-merged'
      ? `DHS1 已统一：${projectMerge.sourceSessionIds.length} 条会话，工作区已就绪`
      : projectMerge.status === 'failed'
        ? 'DHS1 会话统一失败（源数据保留）'
        : '未发现需要统一的 DHS1 会话'
  return <main className="diagnostics-page">
    <div className="diagnostics-heading">
      <div><div className="eyebrow">本机可靠性控制台</div><h1>运行状态与同步</h1><p>桌面壳与官方 Harness 分离运行，诊断不会打断当前窗口。</p></div>
      <button className="icon-button" onClick={() => void refresh()} title="刷新"><RefreshCw size={17} /></button>
    </div>
    <section className="diagnostic-grid">
      <div className="diagnostic-card prominent"><div className="card-label"><CircleCheck size={15} /> 运行时状态</div><strong>{statusLabel(snapshot.state)}</strong><span>桌面端 v{snapshot.desktopVersion} · 官方 DSH v{snapshot.state.version} · {snapshot.state.port ? `127.0.0.1:${snapshot.state.port}` : '尚未监听端口'}</span>{snapshot.state.lastError && <div className="error-line"><CircleAlert size={14} /> {snapshot.state.lastError}</div>}{snapshot.state.status !== 'running' && <button className="text-button repair-link" onClick={() => void repairRuntime()} disabled={busy}><Wrench size={13} /> 维修运行时</button>}</div>
      <div className="diagnostic-card"><div className="card-label"><ArrowUpCircle size={15} /> 官方更新</div><strong>{update?.latestVersion ?? snapshot.latestVersion ?? '未检查'}</strong><span>{snapshot.updateAvailable ? '有新版本可安装' : '当前没有待安装更新'}</span><button className="text-button" onClick={() => void checkUpdate()} disabled={busy}>检查 npm 官方版本 <ExternalLink size={13} /></button></div>
      <div className="diagnostic-card"><div className="card-label"><Wrench size={15} /> 插件生态</div><strong>{plugins?.names.length ?? snapshot.pluginCount} 个插件</strong><span>配置与凭据保留在独立 DSH_HOME</span><button className="text-button" onClick={() => void syncPlugins()} disabled={busy}>同步社区插件 <RefreshCw size={13} /></button></div>
    </section>
    <section className="migration-card"><div><span className="card-label">配置迁移</span><strong>{migrationLabel}</strong><span>模型、凭据、插件清单、会话与用户数据均不改动旧目录</span></div>{snapshot.migration.backupPath && <code>备份：{snapshot.migration.backupPath}</code>}{snapshot.migration.error && <div className="error-line"><CircleAlert size={14} /> {snapshot.migration.error}</div>}</section>
    <section className="migration-card"><div><span className="card-label">DHS1 会话库</span><strong>{projectMergeLabel}</strong><span>只处理 D:\vibecoding\DHS1 的历史记录，不合并其他项目</span></div>{projectMerge.backupPath && <code>备份：{projectMerge.backupPath}</code>}{projectMerge.error && <div className="error-line"><CircleAlert size={14} /> {projectMerge.error}</div>}</section>
    <section className="path-card"><div><span>运行时目录</span><code>{snapshot.runtimeRoot}</code></div><div><span>DSH_HOME</span><code>{snapshot.dshHome}</code></div></section>
    <section className="log-card"><div className="log-heading"><span>最近运行日志</span><span>{snapshot.recentLogs.length} 条</span></div><pre>{snapshot.recentLogs.length ? snapshot.recentLogs.join('\n') : '暂无日志。官方服务启动后，关键生命周期事件会显示在这里。'}</pre></section>
    {message && <div className="footer-message">{message}</div>}
  </main>
}

function App(): ReactElement {
  const page = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('diagnostics') === '1' ? 'diagnostics' : params.get('repair') === '1' ? 'repair' : 'control'
  }, [])
  return page === 'diagnostics' ? <DiagnosticsPage /> : page === 'repair' ? <RepairPage /> : <ControlBar />
}

createRoot(document.getElementById('root')!).render(<App />)
