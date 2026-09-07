import { describe, expect, it } from 'vitest'
import { shouldHideOnClose, shouldHideOnMinimize } from '../src/main/desktop-shell.js'

describe('desktop shell window lifecycle', () => {
  it('keeps a Windows app alive when the user closes its last window', () => {
    expect(shouldHideOnClose({ platform: 'win32', quitting: false })).toBe(true)
    expect(shouldHideOnClose({ platform: 'win32', quitting: true })).toBe(false)
  })

  it('does not apply the tray close behavior to macOS', () => {
    expect(shouldHideOnClose({ platform: 'darwin', quitting: false })).toBe(false)
  })

  it('keeps the window on the taskbar when minimized', () => {
    expect(shouldHideOnMinimize('win32')).toBe(false)
    expect(shouldHideOnMinimize('darwin')).toBe(false)
  })
})
