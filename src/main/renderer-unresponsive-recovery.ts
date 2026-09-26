/**
 * Recover the official Web UI when its renderer stops answering.
 *
 * A third-party client plugin can wedge the renderer in a synchronous loop:
 * `@dickpy/dsh-imagegen` observes the whole `document.body` and mutates the DOM
 * from that same callback, so opening its sidebar entry spins the renderer at
 * ~100% of a core. Nothing crashes and no request fails, so neither
 * `render-process-gone` nor `did-fail-load` ever fires — the page simply stops
 * painting and the user has to restart the whole app.
 *
 * Electron reports this state directly with the `unresponsive` event. Recovering
 * is a page reload: the Harness server and the user's sessions live in the main
 * process and the on-disk runtime, so reloading the view costs a re-render, not
 * a conversation. The runtime is deliberately never restarted from here, for the
 * same reason the mount recovery never touches it — a frozen *page* says nothing
 * about a healthy server.
 *
 * The budget is separate from the mount-recovery budget on purpose: reloading to
 * escape a wedged plugin is a normal, repeatable remedy, and spending the mount
 * retries here would leave a genuinely unmounted page with no recovery left.
 */
export interface RendererUnresponsiveRecoveryOptions {
  /**
   * Consecutive reloads allowed inside one window before the guard latches.
   * A plugin that wedges the renderer within seconds of every load would
   * otherwise reload forever and the window would never settle.
   */
  maxReloads: number
  /** How long the budget window stays open. */
  windowMs: number
  now?: () => number
  onReload?: (info: { attempt: number; reloadsInWindow: number }) => void
  onLatched?: (info: { reloadsInWindow: number; windowMs: number }) => void
}

export interface RendererUnresponsiveRecovery {
  /**
   * The renderer stopped answering. Returns true when a rebuild was requested,
   * false when the budget is spent or the guard has latched.
   */
  recover(): boolean
  /**
   * True once `recover()` asked for a rebuild but the resulting
   * `render-process-gone` has not been handled yet. Lets the crash handler tell
   * a deliberate teardown from an unrelated crash.
   */
  rebuildInFlight(): boolean
  /** The deliberate teardown has been observed and the page load started. */
  rebuildScheduled(): void
  /** The renderer answered again; drop the latch and refill the budget. */
  markResponsive(): void
  latched(): boolean
}

export function createRendererUnresponsiveRecovery(
  options: RendererUnresponsiveRecoveryOptions,
): RendererUnresponsiveRecovery {
  const now = options.now ?? (() => Date.now())
  let windowStartedAt: number | null = null
  let reloadsInWindow = 0
  let latched = false
  let pendingRebuild = false

  return {
    recover() {
      const timestamp = now()
      // Rolling into a fresh window forgives an earlier latch. Without this the
      // latch would be permanent: a plugin that wedged once would disable
      // auto-recovery for the rest of the session, which is strictly worse than
      // the bounded reloads the latch exists to prevent.
      if (windowStartedAt === null || timestamp - windowStartedAt >= options.windowMs) {
        latched = false
        windowStartedAt = timestamp
        reloadsInWindow = 0
      }
      // Still latched inside the same window: every reload led straight back into
      // the wedge, so stop touching the page.
      if (latched) return false
      if (reloadsInWindow >= options.maxReloads) {
        latched = true
        options.onLatched?.({ reloadsInWindow, windowMs: options.windowMs })
        return false
      }
      reloadsInWindow += 1
      pendingRebuild = true
      options.onReload?.({ attempt: reloadsInWindow, reloadsInWindow })
      return true
    },

    rebuildInFlight() {
      return pendingRebuild
    },

    rebuildScheduled() {
      pendingRebuild = false
    },

    markResponsive() {
      latched = false
      windowStartedAt = null
      reloadsInWindow = 0
      // `pendingRebuild` is deliberately NOT cleared here: a renderer can answer
      // one probe and then wedge again before the teardown lands, and the crash
      // handler must still recognize the deliberate rebuild.
    },

    latched() {
      // A latch only holds for the rest of its window; reporting it after the
      // window rolled over would contradict what `recover()` would do.
      if (!latched) return false
      return windowStartedAt !== null && now() - windowStartedAt < options.windowMs
    },
  }
}
