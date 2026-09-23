import { describe, expect, it, vi } from 'vitest'
import { ensureMainWindowIsNotTopmost, shouldHideOnClose, shouldHideOnMinimize } from '../src/main/desktop-shell.js'

describe('desktop shell window lifecycle', () => {
  it('keeps a Windows app alive when the user closes its last window', () => {
    expect(shouldHideOnClose({ platform: 'win32', quitting: false })).toBe(true)
    expect(shouldHideOnClose({ platform: 'win32', quitting: true })).toBe(false)
  })

  it('keeps the macOS app alive when the user closes its last window', () => {
    expect(shouldHideOnClose({ platform: 'darwin', quitting: false })).toBe(true)
    expect(shouldHideOnClose({ platform: 'darwin', quitting: true })).toBe(false)
  })

  it('keeps the window on the taskbar when minimized', () => {
    expect(shouldHideOnMinimize('win32')).toBe(false)
    expect(shouldHideOnMinimize('darwin')).toBe(false)
  })
})

/**
 * `WS_EX_TOPMOST` is a persistent window style: once any process sets it on our
 * HWND, the app floats above every other window until something clears it.
 * Nothing in the shell asks for it, so the invariant is simply that a topmost
 * window must never stay topmost.
 */
describe('main window always-on-top guard', () => {
  it('clears an always-on-top window', () => {
    const setAlwaysOnTop = vi.fn()
    ensureMainWindowIsNotTopmost({
      isDestroyed: () => false,
      isAlwaysOnTop: () => true,
      setAlwaysOnTop,
    })
    expect(setAlwaysOnTop).toHaveBeenCalledWith(false)
  })

  it('leaves a normal window alone', () => {
    const setAlwaysOnTop = vi.fn()
    ensureMainWindowIsNotTopmost({
      isDestroyed: () => false,
      isAlwaysOnTop: () => false,
      setAlwaysOnTop,
    })
    expect(setAlwaysOnTop).not.toHaveBeenCalled()
  })

  it('never touches a destroyed or missing window', () => {
    const setAlwaysOnTop = vi.fn()
    ensureMainWindowIsNotTopmost({
      isDestroyed: () => true,
      isAlwaysOnTop: () => true,
      setAlwaysOnTop,
    })
    ensureMainWindowIsNotTopmost(null)
    expect(setAlwaysOnTop).not.toHaveBeenCalled()
  })
})
