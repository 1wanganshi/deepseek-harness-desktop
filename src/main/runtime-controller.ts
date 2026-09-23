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
/**
 * Heartbeat probe timeout.
 *
 * The Harness is a single-threaded Node process: while it decompresses and
 * replays a multi-megabyte session transcript the event loop is blocked and it
 * cannot answer `/` at all. A short timeout therefore turns "busy loading a
 * long conversation" into "unhealthy" and the shell kills a perfectly good
 * runtime — the user sees the app reboot the moment they send a message to an
 * old session, and the restarted runtime no longer has the conversation in
 * memory. Keep this generous; a genuinely dead child is caught by the `exit`
 * event, not by this probe.
 */
const HEARTBEAT_TIMEOUT_MS = 20_000
/**
 * Consecutive probe failures before the shell even *considers* a restart.
 * Paired with `HEARTBEAT_TIMEOUT_MS` this means a runtime must be silent for
 * over a minute before it is treated as unhealthy.
 */
const HEARTBEAT_FAILURE_LIMIT = 4
/** Timeout for the post-start proof probe (`proveHealthy`). */
const PROOF_TIMEOUT_MS = 2_000

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
 * Ask the Windows Harness tree to shut down gracefully. `taskkill` without
 * `/F` posts WM_CLOSE to every window of the tree, which is the only
 * console-less equivalent of SIGTERM Windows offers. The Harness needs that
 * window to flush in-flight transcript frames and rewrite its session index —
 * the previous unconditional `/T /F` destroyed both, which is how a session
 * completed moments before exit vanished from the UI.
 */
export async function requestWindowsRuntimeShutdown(
  pid: number,
  execFileImpl: typeof execFile = execFile,
): Promise<void> {
  await new Promise<void>(resolve => {
    execFileImpl('taskkill', ['/pid', String(pid), '/T'], { windowsHide: true }, () => resolve())
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
  /**
   * Fired after a child has been confirmed down by an explicit stop. This is
   * the only moment another component may safely touch files the running
   * runtime holds (`storages/workspace.json` above all), so the desktop shell
   * uses it to run its session-link repair.
   */
  onStopped?: () => void
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /**
   * How the Harness child is launched. Injectable so a test can drive the
   * controller's recovery loop without starting a real runtime.
   */
  spawnImpl?: typeof spawn
  heartbeatIntervalMs?: number
  heartbeatFailureLimit?: number
  /**
   * Bounds automatic restarts of a runtime that keeps dying shortly after it
   * starts. Injectable for tests; a caller normally only supplies
   * `onRestartBlocked` and lets the controller own the budget.
   */
  restartBudget?: RuntimeRestartBudget
  /** Fired when the budget refuses a further automatic restart. */
  onRestartBlocked?: (reason: string) => void
}

/**
 * How long a start must survive before it counts as evidence that the runtime
 * can actually run.
 */
const STABILITY_WINDOW_MS = 60_000
/** Consecutive unhealthy starts inside `MAX_UNHEALTHY_WINDOW_MS` that latch. */
const MAX_CONSECUTIVE_UNHEALTHY = 3
const MAX_UNHEALTHY_WINDOW_MS = 3 * 60_000
/** Successful health probes that prove a "verified healthy" release. */
const VERIFIED_HEALTHY_PROBES = 2

export interface RuntimeRestartDecision {
  allowed: boolean
  reason?: string
}

/**
 * Bounds how often the shell may restart a runtime that dies right after every
 * start.
 *
 * The old loop had no upper bound at all: `startInternal()` cleared the
 * recovery budget on entry, and the child-exit and heartbeat-failure paths
 * scheduled a new recovery without consuming any budget. A session that made
 * the runtime die on load therefore restarted it forever — the user saw the app
 * reboot every time they typed in a long conversation.
 *
 * Two independent ways out, because they mean different things:
 *
 *  - `observeHealthy()` — a start proved healthy right after it happened, so
 *    the failure streak is genuinely broken.
 *  - `noteVerifiedHealthy()` — the runtime has been answering health probes
 *    for a while and the last death is long past, so a start that has been up
 *    and *observed* healthy may release the latch once, without the shell
 *    needing the user to intervene.
 *
 * Anything else keeps the latch. Only `reset()` — an explicit user action such
 * as the repair window or a desktop restart — clears it unconditionally.
 */
export class RuntimeRestartBudget {
  private readonly now: () => number
  private readonly maxConsecutiveFailures: number
  private lastUnhealthyAt: number | null = null
  private lastUnhealthyDetail: string | null = null
  private consecutiveUnhealthy = 0
  private healthyProbeStreak = 0
  private latched = false
  private windowStartedAt: number | null = null
  private restartsInWindow = 0
  /** Guards against counting one failed start more than once (exit + rejected boot). */
  private attemptAlreadyCounted = false

  constructor(options: { now?: () => number; maxConsecutiveFailures?: number } = {}) {
    this.now = options.now ?? (() => Date.now())
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_UNHEALTHY
  }

  /** A new start attempt is beginning; nothing is proven about it yet. */
  beginAttempt(): void {
    this.healthyProbeStreak = 0
    this.attemptAlreadyCounted = false
  }

  /** The start that just happened is demonstrably healthy. */
  observeHealthy(): void {
    this.consecutiveUnhealthy = 0
    this.windowStartedAt = null
    this.restartsInWindow = 0
    this.latched = false
    this.healthyProbeStreak = 0
    this.attemptAlreadyCounted = false
  }

  /** Record a death the shell did not cause. */
  noteUnhealthy(detail: string): void {
    const timestamp = this.now()
    this.lastUnhealthyAt = timestamp
    this.lastUnhealthyDetail = detail
    this.healthyProbeStreak = 0
    // One failed start can report twice: the child's `exit` handler fires while
    // `boot()` is still awaiting its health probe, and the rejected boot reports
    // again. Count the *start attempt* once, not every report, or the budget
    // latches a start early and the reason overstates how often it failed.
    if (this.attemptAlreadyCounted) return
    this.attemptAlreadyCounted = true
    if (this.windowStartedAt === null || timestamp - this.windowStartedAt >= MAX_UNHEALTHY_WINDOW_MS) {
      this.windowStartedAt = timestamp
      this.restartsInWindow = 0
    }
    this.restartsInWindow += 1
    this.consecutiveUnhealthy = this.restartsInWindow
    if (this.restartsInWindow >= this.maxConsecutiveFailures) {
      this.latched = true
    }
  }

  /** A health probe came back good; enough of them in a row release the latch. */
  noteVerifiedHealthy(): void {
    this.healthyProbeStreak += 1
    if (!this.latched) return
    if (this.healthyProbeStreak < VERIFIED_HEALTHY_PROBES) return
    const lastDeath = this.lastUnhealthyAt
    if (lastDeath !== null && this.now() - lastDeath < STABILITY_WINDOW_MS) return
    this.latched = false
    this.consecutiveUnhealthy = 0
    this.windowStartedAt = null
    this.restartsInWindow = 0
    this.healthyProbeStreak = 0
    this.attemptAlreadyCounted = false
  }

  shouldAttempt(): RuntimeRestartDecision {
    if (this.latched) {
      return { allowed: false, reason: this.blockedReason() }
    }
    // A fresh window (nothing unhealthy for a while) is a fresh budget.
    if (this.windowStartedAt !== null && this.now() - this.windowStartedAt >= MAX_UNHEALTHY_WINDOW_MS) {
      this.windowStartedAt = null
      this.restartsInWindow = 0
    }
    if (this.windowStartedAt !== null && this.restartsInWindow >= this.maxConsecutiveFailures) {
      this.latched = true
      return { allowed: false, reason: this.blockedReason() }
    }
    return { allowed: true }
  }

  /** The user asked explicitly (维修 window / desktop restart): clear everything. */
  reset(): void {
    this.latched = false
    this.consecutiveUnhealthy = 0
    this.windowStartedAt = null
    this.restartsInWindow = 0
    this.healthyProbeStreak = 0
    this.lastUnhealthyAt = null
    this.lastUnhealthyDetail = null
    this.attemptAlreadyCounted = false
  }

  get blocked(): boolean {
    return this.latched
  }

  private blockedReason(): string {
    const detail = this.lastUnhealthyDetail ?? '未知原因'
    return `运行时在 3 分钟内 ${this.consecutiveUnhealthy} 次启动后未能稳定运行（最近一次：${detail}），已暂停自动重启；请点击「维修」或「重启」`
  }
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
  private readonly restartBudget: RuntimeRestartBudget
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
  private heartbeatSuccesses = 0
  private state: RuntimeState = {
    status: 'stopped',
    version: 'unknown',
    port: null,
    url: null,
    recoveryAttempt: 0,
    lastError: null,
    lastHealthyAt: null,
    restartPaused: false,
    harnessAttention: true,
  }

  constructor(options: RuntimeControllerOptions) {
    this.options = options
    this.fetchImpl = options.fetchImpl ?? fetch
    this.sleep = options.sleep ?? wait
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 4_000
    this.heartbeatFailureLimit = options.heartbeatFailureLimit ?? HEARTBEAT_FAILURE_LIMIT
    this.restartBudget = options.restartBudget ?? new RuntimeRestartBudget()
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
    // Deliberately *not* `this.recovery.markHealthy()`. The recovery budget used
    // to be cleared here, which meant the 8-attempt ceiling reset on every start
    // and a session that killed the runtime on load could restart it forever.
    // Only a runtime that has actually answered a health probe clears it now
    // (see `boot()`), and only an explicit `restart()` clears the restart budget.
    this.restartBudget.beginAttempt()
    this.stoppedByUser = false
    this.recovering = false
    this.lifecycleGeneration += 1
    this.clearHeartbeat()
    this.setState({ status: 'starting', lastError: null, recoveryAttempt: 0 })
    try {
      await this.boot()
      return this.getState()
    } catch (error) {
      const message = this.safeMessage(error)
      this.setState({ status: 'recovering', lastError: message })
      this.restartBudget.noteUnhealthy(message)
      this.scheduleRecovery()
      throw error
    }
  }

  async restart(): Promise<RuntimeState> {
    return this.runLifecycle(async () => {
      // An explicit restart is the user's own decision (维修 window, 重启桌面端),
      // so it clears the restart budget rather than being refused by it.
      this.restartBudget.reset()
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
    // The child is confirmed down, so nothing holds DSH_HOME any more: this is
    // the only safe moment for the shell to write session/workspace indexes.
    try {
      this.options.onStopped?.()
    } catch (error) {
      this.options.log?.(`onStopped failed: ${this.safeMessage(error)}`)
    }
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
    const child = (this.options.spawnImpl ?? spawn)(node, buildDshLaunchArgs(dshBin, port), {
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
        const detail = `Harness 进程已退出（code=${code ?? 'none'}, signal=${signal ?? 'none'}）`
        this.restartBudget.noteUnhealthy(detail)
        this.setState({
          status: 'recovering',
          lastError: detail,
          port: null,
          url: null,
        })
        this.scheduleRecovery()
      }
    })

    try {
      bareRootStatus = await this.waitForHealthy(port, () => advertisedUrl)
      // A start is only proven by a fresh probe *after* the health window closed:
      // `waitForHealthy` already saw a good response, but a runtime that dies the
      // instant a session loads must not count as healthy.
      await this.proveHealthy(port, advertisedUrl)
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
    this.restartBudget.observeHealthy()
    this.recovering = false
    this.setState({
      status: 'running',
      version: this.runtime.version,
      port,
      url: advertisedUrl ?? `http://127.0.0.1:${port}/`,
      recoveryAttempt: 0,
      lastError: null,
      lastHealthyAt: new Date().toISOString(),
      restartPaused: false,
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

  /**
   * One extra probe on the URL the shell will actually hand to the page.
   *
   * `waitForHealthy` polls the bare port and may succeed against a runtime that
   * is about to die on the first session load. This second, non-throwing probe
   * is the shell's evidence that the runtime is serving *this* address; it never
   * fails a start (a missing answer just means "not proven yet") so it cannot
   * introduce a new error path.
   */
  private async proveHealthy(port: number, advertisedUrl: string | null): Promise<boolean> {
    try {
      const url = advertisedUrl ?? `http://127.0.0.1:${port}/`
      const response = await this.fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(PROOF_TIMEOUT_MS) })
      return isHealthyHarnessResponse(response)
    } catch {
      return false
    }
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
    this.heartbeatSuccesses = 0
    this.heartbeatTimer = setInterval(() => {
      void this.checkHeartbeat(port)
    }, this.heartbeatIntervalMs)
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    this.heartbeatFailures = 0
    this.heartbeatSuccesses = 0
  }

  private async checkHeartbeat(port: number): Promise<void> {
    if (this.stoppedByUser || this.recovering || this.state.status !== 'running') return
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) })
      if (isHealthyHarnessResponse(response)) {
        this.heartbeatFailures = 0
        this.heartbeatSuccesses += 1
        this.setState({ lastHealthyAt: new Date().toISOString() })
        // Two clean probes in a row, well after the last death, are enough to
        // release a latched restart budget — the runtime obviously runs, so the
        // shell must stop holding a grudge without a user click.
        if (this.heartbeatSuccesses >= VERIFIED_HEALTHY_PROBES) this.restartBudget.noteVerifiedHealthy()
        return
      }
    } catch {
      // A timeout while the runtime replays a long transcript is expected and is
      // *not* evidence of death; the child-liveness check below decides.
    }
    this.heartbeatSuccesses = 0
    this.heartbeatFailures += 1
    if (this.heartbeatFailures < this.heartbeatFailureLimit) return
    // The probe budget is spent, but a probe failure is not proof of death: the
    // Harness is single-threaded and blocks its event loop while it replays a
    // multi-megabyte transcript, so "cannot answer `/`" is exactly what a
    // healthy runtime looks like mid-load. A child that has not exited is
    // therefore left alone — its own `exit` event is the authoritative signal
    // that it is gone. Killing it here is what made the app reboot the instant
    // a user sent a message to a long conversation.
    if (this.childIsAlive()) {
      this.heartbeatFailures = 0
      return
    }
    await this.recoverFromHealthFailure(`Harness 连续 ${this.heartbeatFailures} 次健康检查失败`)
  }

  /** True while the tracked child process has not reported an exit. */
  private childIsAlive(): boolean {
    const child = this.child
    return child !== null && child.exitCode === null && !child.killed
  }

  private async recoverFromHealthFailure(reason: string): Promise<void> {
    return this.runLifecycle(() => this.recoverFromHealthFailureInternal(reason))
  }

  private async recoverFromHealthFailureInternal(reason: string): Promise<void> {
    if (this.stoppedByUser || this.recovering || this.state.status !== 'running') return
    this.recovering = true
    this.clearHeartbeat()
    // A runtime that stopped answering while it was `running` is not a
    // "died right after start" case — unless it died inside the stability
    // window, which is exactly the long-conversation crash signature.
    this.restartBudget.noteUnhealthy(reason)
    this.setState({ status: 'recovering', lastError: reason, port: null, url: null })
    const child = this.child
    this.child = null
    if (child !== null) await this.terminateChild(child)
    this.recovering = false
    this.scheduleRecovery()
  }

  private scheduleRecovery(): void {
    if (this.stoppedByUser || this.recovering) return
    // Two independent ceilings: the bounded backoff inside a single lifecycle,
    // and the cross-lifecycle budget that stops a session from rebooting the
    // runtime forever.
    const allowed = this.restartBudget.shouldAttempt()
    if (!allowed.allowed) {
      const reason = allowed.reason ?? '自动重启已暂停'
      this.recovering = false
      this.setState({ status: 'error', lastError: reason, port: null, url: null, restartPaused: true })
      this.options.log?.(`Automatic runtime restart paused: ${reason}`)
      this.options.onRestartBlocked?.(reason)
      return
    }
    const delay = this.recovery.nextDelay()
    if (delay === null) {
      const reason = this.state.lastError ?? '运行时多次恢复失败'
      this.setState({ status: 'error', recoveryAttempt: this.recovery.attemptCount, restartPaused: true, lastError: reason })
      this.options.onRestartBlocked?.(reason)
      return
    }
    this.recovering = true
    const scheduledGeneration = this.lifecycleGeneration
    this.setState({ status: 'recovering', recoveryAttempt: this.recovery.attemptCount, restartPaused: false })
    void this.sleep(delay).then(async () => {
      if (this.stoppedByUser || scheduledGeneration !== this.lifecycleGeneration) return
      await this.runLifecycle(async () => {
        if (this.stoppedByUser || scheduledGeneration !== this.lifecycleGeneration) return
        // Mark the new attempt so the exit handler and this catch cannot count
        // the same failed start twice against the restart budget.
        this.restartBudget.beginAttempt()
        try {
          await this.boot()
        } catch (error) {
          const message = this.safeMessage(error)
          this.recovering = false
          this.restartBudget.noteUnhealthy(message)
          this.setState({ status: 'recovering', lastError: message })
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
      // Give the Harness a real window to flush its session state before the
      // tree is destroyed. Taskkill must still run before the parent exits: a
      // clean self-exit can detach DHS plugin supervisors, leaving the
      // embedded node.exe running and holding the DSH_HOME lock.
      await requestWindowsRuntimeShutdown(child.pid)
      const exited = await waitForChildExit(child, CHILD_SHUTDOWN_GRACE_MS)
      if (!exited) await terminateWindowsRuntimeTree(child.pid)
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
