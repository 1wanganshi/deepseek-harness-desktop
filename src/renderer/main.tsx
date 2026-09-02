import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Activity, ArrowUpCircle, ChevronUp, CircleAlert, CircleCheck, Cpu, ExternalLink, RefreshCw, Wrench } from 'lucide-react'
import type { DesktopApi, PluginStatus, RuntimeDiagnostics, RuntimeState, UpdateStatus } from '../shared/types.js'
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
}

const previewApi: DesktopApi = {
  getSnapshot: async () => previewDiagnostics,
  openDiagnostics: async () => undefined,
  setStatusPanelExpanded: async () => undefined,
  repairRuntime: async () => previewDiagnostics.state,
  restartDesktop: async () => undefined,
  checkForUpdate: async () => ({ currentVersion: '0.1.1-rc.2', latestVersion: null, updateAvailable: false, checkedAt: new Date().toISOString(), error: null }),
  installUpdate: async () => ({ currentVersion: '0.1.1-rc.2', latestVersion: '0.1.1-rc.2', updateAvailable: false, checkedAt: new Date().toISOString(), error: null }),
  syncPlugins: async () => ({ profilePath: previewDiagnostics.dshHome, names: [], canSync: true, lastSyncedAt: new Date().toISOString(), error: null }),
  onRuntimeState: () => () => undefined,
  onUpdateState: () => () => undefined,
}

const desktopApi = window.desktopApi ?? previewApi

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
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    void desktopApi.getSnapshot().then(snapshot => {
      setState(snapshot.state)
      setExpanded(snapshot.state.status !== 'running')
      setUpdate({
        currentVersion: snapshot.state.version,
        latestVersion: snapshot.latestVersion,
        updateAvailable: snapshot.updateAvailable,
        checkedAt: null,
        error: null,
      })
    }).catch(() => setNotice('控制面暂时无法读取运行状态'))
    return desktopApi.onRuntimeState(nextState => {
      setState(nextState)
      if (nextState.status !== 'running') setExpanded(true)
    })
  }, [])
  useEffect(() => desktopApi.onUpdateState(setUpdate), [])
  useEffect(() => { void desktopApi.setStatusPanelExpanded(expanded) }, [expanded])

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

  const hasProblem = state.status === 'error' || state.status === 'recovering'
  const toggleLabel = expanded ? '隐藏运行状态' : '查看运行状态'
  return <>
    {!expanded && <button className={`status-launcher ${statusTone(state)} ${hasProblem ? 'attention' : ''}`} onClick={() => setExpanded(true)} aria-expanded={expanded} aria-label={toggleLabel} title={toggleLabel}>
      <span className={`status-dot ${statusTone(state)}`} />
      <span className="launcher-label">{hasProblem ? '需要处理' : '运行中'}</span>
    </button>}
    {expanded && <header className="control-bar" role="status">
      <div className="brand-lockup">
        <div className="brand-mark"><Cpu size={18} strokeWidth={2.4} /></div>
        <div>
          <div className="brand-name">DeepSeek Harness</div>
          <div className="brand-subtitle">DESKTOP RUNTIME</div>
        </div>
      </div>
      <div className="runtime-indicator">
        <span className={`status-dot ${statusTone(state)}`} />
        <span>{statusLabel(state)}</span>
        {state.recoveryAttempt > 0 && <span className="attempt">第 {state.recoveryAttempt} 次</span>}
      </div>
      <div className="bar-spacer" />
      {notice !== null && <div className="top-notice" title={notice}>{notice}</div>}
      {update?.updateAvailable && <button className="update-chip" onClick={() => void runAction('update', async () => {
        const result = await desktopApi.installUpdate()
        setUpdate(result)
      }, '官方运行时已更新，正在重新连接')} disabled={busy !== null}>
        <ArrowUpCircle size={15} /> 更新到 {update.latestVersion}
      </button>}
      <div className="version">v{state.version}</div>
      <button className="icon-button" onClick={() => void runAction('diagnostics', () => desktopApi.openDiagnostics(), '诊断窗口已打开')} title="打开诊断">
        <Wrench size={17} />
      </button>
      {hasProblem && <button className="secondary-button repair-button" onClick={() => void runAction('repair', () => desktopApi.repairRuntime(), '运行时维修已启动')} disabled={busy !== null}>
        <Wrench size={15} className={busy === 'repair' ? 'spin' : ''} /> 维修运行时
      </button>}
      <button className="primary-button" onClick={() => void runAction('desktop', () => desktopApi.restartDesktop(), '正在重启桌面端')} disabled={busy !== null}>
        <RefreshCw size={15} className={busy === 'desktop' ? 'spin' : ''} /> 重启
      </button>
      <button className="icon-button" onClick={() => setExpanded(false)} title="隐藏运行状态" aria-label="隐藏运行状态">
        <ChevronUp size={17} />
      </button>
    </header>}
    {state.status !== 'running' && <main className="runtime-placeholder">
      <div className="runtime-placeholder-card">
        <div className={`placeholder-icon ${statusTone(state)}`}><RefreshCw size={22} className={state.status === 'recovering' || state.status === 'starting' ? 'spin' : ''} /></div>
        <h1>{statusLabel(state)}</h1>
        <p>{state.status === 'error'
          ? '官方 Harness 暂时无法启动。你的模型、凭据和会话仍保存在本机。'
          : '正在重新建立本机连接，官方页面会在服务恢复后自动打开。'}</p>
        {state.lastError && <code>{state.lastError}</code>}
        <div className="placeholder-actions">
          <button className="secondary-button" onClick={() => void runAction('repair', () => desktopApi.repairRuntime(), '运行时维修已启动')} disabled={busy !== null}>
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
  return <main className="diagnostics-page">
    <div className="diagnostics-heading">
      <div><div className="eyebrow">LOCAL RELIABILITY CONSOLE</div><h1>运行状态与同步</h1><p>桌面壳与官方 Harness 分离运行，诊断不会打断当前窗口。</p></div>
      <button className="icon-button" onClick={() => void refresh()} title="刷新"><RefreshCw size={17} /></button>
    </div>
    <section className="diagnostic-grid">
      <div className="diagnostic-card prominent"><div className="card-label"><CircleCheck size={15} /> 运行时状态</div><strong>{statusLabel(snapshot.state)}</strong><span>官方 DSH v{snapshot.state.version} · {snapshot.state.port ? `127.0.0.1:${snapshot.state.port}` : '尚未监听端口'}</span>{snapshot.state.lastError && <div className="error-line"><CircleAlert size={14} /> {snapshot.state.lastError}</div>}{snapshot.state.status !== 'running' && <button className="text-button repair-link" onClick={() => void repairRuntime()} disabled={busy}><Wrench size={13} /> 维修运行时</button>}</div>
      <div className="diagnostic-card"><div className="card-label"><ArrowUpCircle size={15} /> 官方更新</div><strong>{update?.latestVersion ?? snapshot.latestVersion ?? '未检查'}</strong><span>{snapshot.updateAvailable ? '有新版本可安装' : '当前没有待安装更新'}</span><button className="text-button" onClick={() => void checkUpdate()} disabled={busy}>检查 npm 官方版本 <ExternalLink size={13} /></button></div>
      <div className="diagnostic-card"><div className="card-label"><Wrench size={15} /> 插件生态</div><strong>{plugins?.names.length ?? snapshot.pluginCount} 个插件</strong><span>配置与凭据保留在独立 DSH_HOME</span><button className="text-button" onClick={() => void syncPlugins()} disabled={busy}>同步社区插件 <RefreshCw size={13} /></button></div>
    </section>
    <section className="migration-card"><div><span className="card-label">配置迁移</span><strong>{migrationLabel}</strong><span>模型、凭据、插件清单、会话与用户数据均不改动旧目录</span></div>{snapshot.migration.backupPath && <code>备份：{snapshot.migration.backupPath}</code>}{snapshot.migration.error && <div className="error-line"><CircleAlert size={14} /> {snapshot.migration.error}</div>}</section>
    <section className="path-card"><div><span>运行时目录</span><code>{snapshot.runtimeRoot}</code></div><div><span>DSH_HOME</span><code>{snapshot.dshHome}</code></div></section>
    <section className="log-card"><div className="log-heading"><span>最近运行日志</span><span>{snapshot.recentLogs.length} 条</span></div><pre>{snapshot.recentLogs.length ? snapshot.recentLogs.join('\n') : '暂无日志。官方服务启动后，关键生命周期事件会显示在这里。'}</pre></section>
    {message && <div className="footer-message">{message}</div>}
  </main>
}

function App(): ReactElement {
  const diagnostics = useMemo(() => new URLSearchParams(window.location.search).get('diagnostics') === '1', [])
  return diagnostics ? <DiagnosticsPage /> : <ControlBar />
}

createRoot(document.getElementById('root')!).render(<App />)
