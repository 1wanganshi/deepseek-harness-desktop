import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { findAvailablePort } from './ports.js'
import { clearProfileFallbackLinks } from './profile-fallback.js'
import { RecoveryController } from './recovery.js'
import type { ResolvedRuntime } from './runtime-paths.js'
import type { RuntimeState } from '../shared/types.js'

const HEALTH_TIMEOUT_MS = 30_000
const HEALTH_POLL_MS = 250
const ADVERTISED_URL_TIMEOUT_MS = 5_000
const CHILD_SHUTDOWN_GRACE_MS = 4_000

export function parseAdvertisedUrl(output: string, port: number): string | null {
  const match = output.match(new RegExp(`https?://127\\.0\\.0\\.1:${port}\\/?\\?token=[A-Za-z0-9_-]+`))
  return match?.[0] ?? null
}

export function isHealthyHarnessResponse(response: Pick<Response, 'ok' | 'status'>): boolean {
  // Newer DHS returns 303 until a client has an authenticated cookie. A manual
  // redirect response still proves the local runtime is reachable and alive.
  return response.ok || response.status === 303 || response.status === 401
}

export function isUsableBareRootResponse(response: Pick<Response, 'ok' | 'status'>): boolean {
  return response.ok && response.status === 200
}

export function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const onExit = () => finish(true)
    const finish = (exited: boolean) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      child.removeListener('exit', onExit)
      child.removeListener('close', onExit)
      resolve(exited)
    }
    child.once('exit', onExit)
    child.once('close', onExit)
    timer = setTimeout(() => finish(false), timeoutMs)
  })
}

/**
 * Stop the Windows process tree while the Harness parent still exists. DHS
 * plugins can launch supervisor processes which otherwise outlive a graceful
 * parent shutdown and retain the packaged Node executable.
 */
export async function terminateWindowsRuntimeTree(
  pid: number,
  execFileImpl: typeof execFile = execFile,
): Promise<void> {
  await new Promise<void>(resolve => {
    execFileImpl('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
  })
}

/**
 * POSIX counterpart of the Windows tree kill. The child is spawned detached,
 * so the negative PID addresses its whole process group and plugin
 * supervisors cannot outlive the Harness parent.
 */
export function terminatePosixRuntimeGroup(
  pid: number,
  signal: NodeJS.Signals = 'SIGTERM',
  killImpl: (pid: number, signal: NodeJS.Signals) => void = process.kill.bind(process),
): void {
  try {
    killImpl(-pid, signal)
  } catch {
    // The group may already be gone; there is nothing left to terminate.
  }
}

export interface RuntimeControllerOptions {
  resolveRuntime: () => Promise<ResolvedRuntime>
  dshHome: string
  nodeExecutable?: string
  /** Extra environment merged last into the Harness child (platform shims). */
  childEnv?: NodeJS.ProcessEnv
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

/**
 * Serialize lifecycle operations for one desktop host. A rendered-page
 * recovery, a manual repair, and a user restart can otherwise race each
 * other and launch multiple DHS processes against the same DSH_HOME.
 */
export function createSerializedOperationQueue(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve()
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation)
    tail = result.then(() => undefined, () => undefined)
    return result
  }
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
  // Bumped on every explicit start/stop so a stale scheduled recovery from a
  // previous lifecycle can never boot a second child behind an active boot.
  private lifecycleGeneration = 0
  private readonly runLifecycle = createSerializedOperationQueue()
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
    return this.runLifecycle(() => this.startInternal())
  }

  private async startInternal(): Promise<RuntimeState> {
    if (this.child !== null && this.child.exitCode === null && (this.state.status === 'starting' || this.state.status === 'running')) {
      return this.getState()
    }
    this.stoppedByUser = false
    this.recovering = false
    this.recovery.markHealthy()
    this.lifecycleGeneration += 1
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
    return this.runLifecycle(async () => {
      await this.stopInternal()
      return this.startInternal()
    })
  }

  async stop(): Promise<void> {
    return this.runLifecycle(() => this.stopInternal())
  }

  private async stopInternal(): Promise<void> {
    this.stoppedByUser = true
    this.recovering = false
    this.lifecycleGeneration += 1
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
    const profileFallbackRoot = join(this.options.dshHome, 'profiles', 'web', '.dsh-module-fallback', 'node_modules')
    const removedFallbackLinks = (await clearProfileFallbackLinks(fallbackRoot))
      + (await clearProfileFallbackLinks(profileFallbackRoot))
    if (removedFallbackLinks > 0) {
      this.options.log?.(`Cleared ${removedFallbackLinks} stale official profile fallback links before boot`)
    }
    const port = await findAvailablePort()
    const dshBin = join(this.runtime.root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    await access(dshBin)
    const node = this.options.nodeExecutable ?? process.env.DSH_NODE_PATH ?? 'node'
    let advertisedUrl: string | null = null
    let advertisedOutput = ''
    let bareRootStatus: number | null = null
    const child = spawn(node, buildDshLaunchArgs(dshBin, port), {
      cwd: this.runtime.root,
      env: {
        ...process.env,
        DSH_HOME: this.options.dshHome,
        DSH_DESKTOP_SUPERVISED: '1',
        DSH_DESKTOP_PORT: String(port),
        ...(this.options.childEnv ?? {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX: a detached child becomes its own process-group leader so the
      // whole tree (including plugin supervisors) can be signalled via -pid.
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    this.child = child
    child.stdout?.on('data', chunk => {
      const output = chunk.toString()
      advertisedOutput += output
      advertisedUrl = advertisedUrl ?? parseAdvertisedUrl(advertisedOutput, port)
      this.captureLog(output)
    })
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
      bareRootStatus = await this.waitForHealthy(port, () => advertisedUrl)
      // Newer DHS versions print a one-time token URL. Older compatible
      // versions print only the root URL; accept that path only after a real
      // HTTP 200 document response, never a 401/303 auth challenge.
      if (advertisedUrl === null) {
        await this.waitForAdvertisedUrl(() => advertisedUrl)
        if (advertisedUrl === null && !isUsableBareRootResponse({ ok: bareRootStatus === 200, status: bareRootStatus ?? 0 })) {
          throw new Error('Harness 未输出认证地址')
        }
      }
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
      url: advertisedUrl ?? `http://127.0.0.1:${port}/`,
      recoveryAttempt: 0,
      lastError: null,
      lastHealthyAt: new Date().toISOString(),
    })
    this.startHeartbeat(port)
  }

  private async waitForHealthy(port: number, getAdvertisedUrl: () => string | null = () => null): Promise<number> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.child === null || this.child.exitCode !== null) throw new Error('Harness 在健康检查完成前退出')
      try {
        const url = getAdvertisedUrl() ?? `http://127.0.0.1:${port}/`
        const response = await this.fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(2_000) })
        if (isHealthyHarnessResponse(response)) return response.status
      } catch {
        // The process may need a few seconds to mount the official plugin tree.
      }
      await this.sleep(HEALTH_POLL_MS)
    }
    throw new Error('Harness 健康检查超时')
  }

  private async waitForAdvertisedUrl(getAdvertisedUrl: () => string | null): Promise<void> {
    const deadline = Date.now() + ADVERTISED_URL_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (getAdvertisedUrl() !== null) return
      if (this.child === null || this.child.exitCode !== null) throw new Error('Harness 在认证地址输出前退出')
      await this.sleep(HEALTH_POLL_MS)
    }
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
      const response = await this.fetchImpl(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(2_000) })
      if (isHealthyHarnessResponse(response)) {
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
    return this.runLifecycle(() => this.recoverFromHealthFailureInternal(reason))
  }

  private async recoverFromHealthFailureInternal(reason: string): Promise<void> {
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
    const scheduledGeneration = this.lifecycleGeneration
    this.setState({ status: 'recovering', recoveryAttempt: this.recovery.attemptCount })
    void this.sleep(delay).then(async () => {
      if (this.stoppedByUser || scheduledGeneration !== this.lifecycleGeneration) return
      await this.runLifecycle(async () => {
        if (this.stoppedByUser || scheduledGeneration !== this.lifecycleGeneration) return
        try {
          await this.boot()
        } catch (error) {
          this.recovering = false
          this.setState({ status: 'recovering', lastError: this.safeMessage(error) })
          this.scheduleRecovery()
        }
      })
    })
  }

  private captureLog(raw: string): void {
    for (const line of raw.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
      this.options.log?.(line.slice(0, 2000))
    }
  }

  private async terminateChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.killed) return
    if (process.platform === 'win32' && child.pid !== undefined) {
      // Taskkill must run before the parent exits. A graceful exit can detach
      // DHS plugin supervisors, leaving the embedded node.exe running.
      await terminateWindowsRuntimeTree(child.pid)
      await this.sleep(100)
      return
    }
    if (process.platform !== 'win32' && child.pid !== undefined) {
      terminatePosixRuntimeGroup(child.pid, 'SIGTERM')
      const exited = await waitForChildExit(child, CHILD_SHUTDOWN_GRACE_MS)
      if (!exited) terminatePosixRuntimeGroup(child.pid, 'SIGKILL')
      if (!exited) child.kill()
      await this.sleep(100)
      return
    }
    child.kill()
    await waitForChildExit(child, CHILD_SHUTDOWN_GRACE_MS)
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
