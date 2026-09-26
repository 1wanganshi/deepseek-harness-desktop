import { describe, expect, it, vi } from 'vitest'
import { createRendererUnresponsiveRecovery, pingRenderer } from '../src/main/renderer-unresponsive-recovery.js'

/**
 * A client plugin can wedge the renderer in a synchronous loop (the
 * `@dickpy/dsh-imagegen` sidebar entry observes `document.body` and mutates the
 * DOM from the same callback). The page never crashes and no request fails, so
 * only Electron's `unresponsive` event reports it. Reloading the view is the
 * remedy; the runtime and the user's sessions must never be touched.
 */
describe('renderer unresponsive recovery', () => {
  it('requests a reload while the budget allows', () => {
    const onReload = vi.fn()
    const guard = createRendererUnresponsiveRecovery({ maxReloads: 3, windowMs: 60_000, now: () => 0, onReload })

    expect(guard.recover()).toBe(true)
    expect(guard.recover()).toBe(true)
    expect(guard.recover()).toBe(true)
    expect(onReload).toHaveBeenCalledTimes(3)
    expect(guard.latched()).toBe(false)
  })

  it('latches instead of reloading forever when the page re-wedges', () => {
    const onLatched = vi.fn()
    const guard = createRendererUnresponsiveRecovery({ maxReloads: 2, windowMs: 60_000, now: () => 0, onLatched })

    expect(guard.recover()).toBe(true)
    expect(guard.recover()).toBe(true)
    // Every reload leads straight back into the wedge: stop touching the page.
    expect(guard.recover()).toBe(false)
    expect(guard.latched()).toBe(true)
    expect(onLatched).toHaveBeenCalledWith({ reloadsInWindow: 2, windowMs: 60_000 })
  })

  it('refills the budget when the renderer answers again', () => {
    let clock = 0
    const guard = createRendererUnresponsiveRecovery({ maxReloads: 1, windowMs: 60_000, now: () => clock })

    expect(guard.recover()).toBe(true)
    expect(guard.recover()).toBe(false)
    expect(guard.latched()).toBe(true)

    // The page recovered on its own, so the guard must forgive it completely.
    guard.markResponsive()
    expect(guard.latched()).toBe(false)
    expect(guard.recover()).toBe(true)
  })

  it('reopens the window once enough time has passed', () => {
    let clock = 0
    const guard = createRendererUnresponsiveRecovery({ maxReloads: 2, windowMs: 60_000, now: () => clock })

    expect(guard.recover()).toBe(true)
    expect(guard.recover()).toBe(true)
    expect(guard.recover()).toBe(false)

    clock = 60_001
    expect(guard.latched()).toBe(false)
    expect(guard.recover()).toBe(true)
  })

  /**
   * A wedged renderer never processes a navigation, so the recovery tears the
   * process down and lets `render-process-gone` load the page in a new one. The
   * crash handler must be able to tell that deliberate teardown from an ordinary
   * crash, otherwise it spends the *mount* retry budget that a page which never
   * mounted still needs.
   */
  it('reports a rebuild as in flight until the teardown is observed', () => {
    const guard = createRendererUnresponsiveRecovery({ maxReloads: 3, windowMs: 60_000, now: () => 0 })

    expect(guard.rebuildInFlight()).toBe(false)
    expect(guard.recover()).toBe(true)
    expect(guard.rebuildInFlight()).toBe(true)

    guard.rebuildScheduled()
    expect(guard.rebuildInFlight()).toBe(false)
  })
})

/**
 * Electron's `unresponsive` event did NOT fire for the observed plugin wedge
 * (renderer pegged at 100% CPU for over a minute, zero events delivered), so the
 * shell detects the freeze itself. `executeJavaScript` resolves only once the
 * renderer has run the script, which makes a missed response the wedge signal.
 */
describe('renderer liveness ping', () => {
  it('reports alive when the page answers', async () => {
    await expect(pingRenderer({ timeoutMs: 1000, ping: async () => 1 })).resolves.toBe(true)
  })

  it('reports not alive when the page never answers', async () => {
    // A wedged renderer never settles the promise.
    await expect(pingRenderer({ timeoutMs: 10, ping: () => new Promise(() => {}) })).resolves.toBe(false)
  })

  it('treats a failed ping as not alive rather than throwing', async () => {
    // A gone renderer rejects; the crash handler owns that path, so the watchdog
    // must simply not double-handle it.
    await expect(pingRenderer({ timeoutMs: 1000, ping: async () => { throw new Error('gone') } })).resolves.toBe(false)
  })
})
