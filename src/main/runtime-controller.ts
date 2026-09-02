import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findAvailablePort } from './ports.js'
import { clearProfileFallbackLinks } from './profile-fallback.js'
import { RecoveryController } from './recovery.js'
import type { ResolvedRuntime } from './runtime-paths.js'
import type { RuntimeState } from '../shared/types.js'

const HEALTH_TIMEOUT_MS = 30_000
const HEALTH_POLL_MS = 250

export interface RuntimeControllerOptions {
  resolveRuntime: () => Promise<ResolvedRuntime>
  dshHome: string
  nodeExecutable?: string
  log?: (line: string) => void
  onState?: (state: RuntimeState) => void
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  heartbeatIntervalMs?: number
  heartbeatFailureLimit?: number
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function buildDshLaunchArgs(dshBin: string, port: number): string[] {
  return [
    '--expose-internals',
    dshBin,
    'web',
    '--no-open',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ]
}

export class RuntimeController {
  private readonly options: RuntimeControllerOptions
  private readonly recovery = new RecoveryController({
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0.1,
    maxAttempts: 8,
  })
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly heartbeatIntervalMs: number
  private readonly heartbeatFailureLimit: number
  private child: ChildProcess | null = null
  private runtime: ResolvedRuntime | null = null
  private stoppedByUser = false
  private recovering = false
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatFailures = 0
  private state: RuntimeState = {
    status: 'stopped',
    version: 'unknown',
    port: null,
    url: null,
    recoveryAttempt: 0,
    lastError: null,
    lastHealthyAt: null,
  }

  constructor(options: RuntimeControllerOptions) {
    this.options = options
    this.fetchImpl = options.fetchImpl ?? fetch
    this.sleep = options.sleep ?? wait
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000
    this.heartbeatFailureLimit = options.heartbeatFailureLimit ?? 3
  }

  getState(): RuntimeState {
    return { ...this.state }
  }

  async start(): Promise<RuntimeState> {
    this.stoppedByUser = false
    this.recovering = false
    this.recovery.markHealthy()
    this.clearHeartbeat()
    this.setState({ status: 'starting', lastError: null, recoveryAttempt: 0 })
    try {
      await this.boot()
      return this.getState()
    } catch (error) {
      this.setState({ status: 'recovering', lastError: this.safeMessage(error) })
      this.scheduleRecovery()
      throw error
    }
  }

  async restart(): Promise<RuntimeState> {
    await this.stop()
    return this.start()
  }

  async stop(): Promise<void> {
    this.stoppedByUser = true
    this.recovering = false
    this.clearHeartbeat()
    const child = this.child
    this.child = null
    if (child !== null && child.exitCode === null && !child.killed) {
      await this.terminateChild(child)
    }
    this.setState({ status: 'stopped', port: null, url: null, recoveryAttempt: 0 })
  }

  private async boot(): Promise<void> {
    this.runtime = await this.options.resolveRuntime()
    const fallbackRoot = join(this.options.dshHome, 'profiles', 'node_modules')
    const removedFallbackLinks = await clearProfileFallbackLinks(fallbackRoot)
    if (removedFallbackLinks > 0) {
      this.options.log?.(`Cleared ${removedFallbackLinks} stale official profile fallback links before boot`)
    }
    const port = await findAvailablePort()
    const dshBin = join(this.runtime.root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    await access(dshBin)
    const node = this.options.nodeExecutable ?? process.env.DSH_NODE_PATH ?? 'node'
    const child = spawn(node, buildDshLaunchArgs(dshBin, port), {
      cwd: this.runtime.root,
      env: {
        ...process.env,
        DSH_HOME: this.options.dshHome,
        DSH_DESKTOP_SUPERVISED: '1',
        DSH_DESKTOP_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    child.stdout?.on('data', chunk => this.captureLog(chunk.toString()))
    child.stderr?.on('data', chunk => this.captureLog(chunk.toString()))
    child.once('error', error => {
      this.captureLog(`process error: ${this.safeMessage(error)}`)
    })
    child.once('exit', (code, signal) => {
      const isCurrentChild = this.child === child
      if (isCurrentChild) this.child = null
      if (isCurrentChild && !this.stoppedByUser) {
        this.setState({
          status: 'recovering',
          lastError: `Harness 进程已退出（code=${code ?? 'none'}, signal=${signal ?? 'none'}）`,
          port: null,
          url: null,
        })
        this.scheduleRecovery()
      }
    })

    try {
      await this.waitForHealthy(port)
      if (this.child !== child || child.exitCode !== null) throw new Error('Harness 在健康检查完成后退出')
    } catch (error) {
      if (this.child === child) this.child = null
      await this.terminateChild(child)
      throw error
    }
    this.recovery.markHealthy()
    this.recovering = false
    this.setState({
      status: 'running',
      version: this.runtime.version,
      port,
      url: `http://127.0.0.1:${port}`,
      recoveryAttempt: 0,
      lastError: null,
      lastHealthyAt: new Date().toISOString(),
    })
    this.startHeartbeat(port)
  }

  private async waitForHealthy(port: number): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    const url = `http://127.0.0.1:${port}/`
    while (Date.now() < deadline) {
      if (this.child === null || this.child.exitCode !== null) throw new Error('Harness 在健康检查完成前退出')
      try {
        const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(2_000) })
        if (response.ok) return
      } catch {
        // The process may need a few seconds to mount the official plugin tree.
      }
      await this.sleep(HEALTH_POLL_MS)
    }
    throw new Error('Harness 健康检查超时')
  }

  private startHeartbeat(port: number): void {
    this.clearHeartbeat()
    this.heartbeatFailures = 0
    this.heartbeatTimer = setInterval(() => {
      void this.checkHeartbeat(port)
    }, this.heartbeatIntervalMs)
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    this.heartbeatFailures = 0
  }

  private async checkHeartbeat(port: number): Promise<void> {
    if (this.stoppedByUser || this.recovering || this.state.status !== 'running') return
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) {
        this.heartbeatFailures = 0
        this.setState({ lastHealthyAt: new Date().toISOString() })
        return
      }
    } catch {
      // Count consecutive probe failures before restarting to avoid reacting to one transient packet loss.
    }
    this.heartbeatFailures += 1
    if (this.heartbeatFailures >= this.heartbeatFailureLimit) {
      await this.recoverFromHealthFailure(`Harness 连续 ${this.heartbeatFailures} 次健康检查失败`)
    }
  }

  private async recoverFromHealthFailure(reason: string): Promise<void> {
    if (this.stoppedByUser || this.recovering || this.state.status !== 'running') return
    this.recovering = true
    this.clearHeartbeat()
    this.setState({ status: 'recovering', lastError: reason, port: null, url: null })
    const child = this.child
    this.child = null
    if (child !== null) await this.terminateChild(child)
    this.recovering = false
    this.scheduleRecovery()
  }

  private scheduleRecovery(): void {
    if (this.stoppedByUser || this.recovering) return
    const delay = this.recovery.nextDelay()
    if (delay === null) {
      this.setState({ status: 'error', recoveryAttempt: this.recovery.attemptCount })
      return
    }
    this.recovering = true
    this.setState({ status: 'recovering', recoveryAttempt: this.recovery.attemptCount })
    void this.sleep(delay).then(async () => {
      if (this.stoppedByUser) return
      try {
        await this.boot()
      } catch (error) {
        this.recovering = false
        this.setState({ status: 'recovering', lastError: this.safeMessage(error) })
        this.scheduleRecovery()
      }
    })
  }

  private captureLog(raw: string): void {
    for (const line of raw.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
      this.options.log?.(line.slice(0, 2000))
    }
  }

  private async terminateChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.killed) return
    child.kill()
    if (process.platform === 'win32' && child.pid !== undefined) {
      await new Promise<void>(resolve => {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve())
      })
    }
    await this.sleep(100)
  }

  private safeMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private setState(update: Partial<RuntimeState>): void {
    this.state = { ...this.state, ...update }
    this.options.onState?.(this.getState())
  }
}
