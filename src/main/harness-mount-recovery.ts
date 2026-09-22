/**
 * Decide what the desktop shell should conclude from the official Web UI's
 * mount probe.
 *
 * The probe runs after `did-finish-load`, at a moment when the page is still
 * assembling itself. The previous rule treated "the document has any text at
 * all" as proof of a successful mount, but the official UI paints its static
 * chrome ("探索未至之境", "选择工作区", the sidebar) long before it replays a
 * session transcript. A session with a multi-megabyte transcript therefore
 * *always* looked mounted, the recovery counter was reset on every probe, and
 * the retry ceiling could never be reached.
 *
 * Only an explicit mount signal counts as success. Anything else means "keep
 * watching and retry with backoff", never "the document is broken".
 */
export interface HarnessMountProbe {
  rootChildren?: number
  bodyText?: string
  bootReady?: boolean
}

export type HarnessMountVerdict =
  | { state: 'mounted' }
  | { state: 'plugin-failure'; detail: string }
  | { state: 'pending'; reason: string }

const PLUGIN_FAILURE_MARKER = 'Failed to load plugins'

export function evaluateHarnessMount(probe: HarnessMountProbe): HarnessMountVerdict {
  const bodyText = (probe.bodyText ?? '').trim()
  if (bodyText.includes(PLUGIN_FAILURE_MARKER)) {
    return { state: 'plugin-failure', detail: bodyText }
  }
  // The runtime sets an explicit boot flag once the plugin tree has mounted.
  // It is the only non-heuristic signal available to the main process.
  if (probe.bootReady === true) return { state: 'mounted' }
  return { state: 'pending', reason: '官方 Web UI 尚未发出挂载完成信号' }
}

export interface HarnessMountRecoveryOptions {
  maxAttempts: number
  retryDelayMs: number
  /** Injectable timer so tests never wait on wall-clock time. */
  setTimeoutImpl?: (callback: () => void, delayMs: number) => unknown
  onRetry?: (attempt: number, reason: string) => void
  onAbandoned?: (reason: string) => void
  getCurrentUrl: () => string | null
  reload: (url: string) => void
}

export interface HarnessMountRecovery {
  /** A page load came back negative; schedule one bounded retry. */
  schedule(reason: string, url: string | null): void
  /** The page is observably mounted; clear the streak and unlock retrying. */
  markMounted(): void
  /** The runtime URL changed (or went away); retries for the old URL are moot. */
  resetForUrl(url: string | null): void
  attemptCount(): number
  abandoned(): boolean
}

/**
 * Bounded retry controller for the official Web UI's *page*.
 *
 * This is deliberately separate from the runtime lifecycle: a page that has
 * not mounted yet is not evidence that the Harness child process is unhealthy,
 * so nothing here may ever restart the runtime. Once the retry budget is spent
 * the shell stops touching the page, so the user keeps a usable window instead
 * of an endless boot loop.
 */
export function createHarnessMountRecovery(options: HarnessMountRecoveryOptions): HarnessMountRecovery {
  const scheduleTimeout = options.setTimeoutImpl ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  let attempts = 0
  let inFlight = false
  let abandoned = false
  let currentUrl: string | null = null

  return {
    schedule(reason, url) {
      if (url === null || abandoned) return
      // A retry is already queued for this URL; a second probe for the same
      // load must not consume a second slot of the budget.
      if (inFlight && currentUrl === url) return
      if (attempts >= options.maxAttempts) {
        abandoned = true
        currentUrl = null
        inFlight = false
        options.onAbandoned?.(reason)
        return
      }
      attempts += 1
      currentUrl = url
      inFlight = true
      options.onRetry?.(attempts, reason)
      scheduleTimeout(() => {
        inFlight = false
        // An exhausted budget supersedes the retry that queued this callback.
        if (abandoned) return
        if (options.getCurrentUrl() !== url) return
        options.reload(url)
      }, options.retryDelayMs)
    },

    markMounted() {
      attempts = 0
      inFlight = false
      currentUrl = null
      abandoned = false
    },

    resetForUrl(url) {
      attempts = 0
      inFlight = false
      currentUrl = url
      abandoned = false
    },

    attemptCount() {
      return attempts
    },

    abandoned() {
      return abandoned
    },
  }
}

/**
 * Guards Harness process restarts so a repeatedly failing runtime cannot be
 * restarted forever.
 *
 * A session that crashes the runtime on load (a preset referencing a missing
 * plugin, a transcript the runtime cannot parse) used to restart the process on
 * every attempt: the shell restarted it, the runtime died again on the next
 * message, and the user saw the app reboot whenever they typed. The gate allows
 * a bounded number of restarts per window and then latches, leaving the app in
 * a diagnosable state instead of looping.
 */
export interface RuntimeRestartGateOptions {
  /** Restarts allowed inside one window before the gate latches. */
  maxRestarts: number
  windowMs: number
  now?: () => number
  /** Performs the restart; resolves once it has been kicked off. */
  restart: () => Promise<unknown> | unknown
  onLatched?: (info: { restartsInWindow: number; windowMs: number }) => void
}

export interface RuntimeRestartGate {
  /**
   * Restart the runtime if the budget allows. Returns false when the gate has
   * latched and nothing was attempted.
   */
  restart(): Promise<boolean>
  /** Called once the runtime is observably healthy again. */
  markHealthy(): void
  /**
   * Drop the latch and the window count *without* performing a restart.
   *
   * `markHealthy()` is the strong form (prove health, then restart if needed);
   * this is the weak one, used when the runtime is already known to be serving
   * the page again, so the shell must simply stop holding a grudge against it.
   */
  notifyHealthy(): void
  latched(): boolean
}

export function createRuntimeRestartGate(options: RuntimeRestartGateOptions): RuntimeRestartGate {
  const now = options.now ?? (() => Date.now())
  let windowStartedAt: number | null = null
  let restartsInWindow = 0
  let latched = false

  const release = () => {
    latched = false
    windowStartedAt = null
    restartsInWindow = 0
  }

  return {
    async restart() {
      if (latched) return false
      const timestamp = now()
      if (windowStartedAt === null || timestamp - windowStartedAt >= options.windowMs) {
        windowStartedAt = timestamp
        restartsInWindow = 0
      }
      if (restartsInWindow >= options.maxRestarts) {
        latched = true
        options.onLatched?.({ restartsInWindow, windowMs: options.windowMs })
        return false
      }
      restartsInWindow += 1
      await options.restart()
      return true
    },

    markHealthy: release,

    notifyHealthy: release,

    latched() {
      return latched
    },
  }
}