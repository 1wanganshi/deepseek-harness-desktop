export type DesktopPlatform = 'win32' | 'darwin' | 'linux' | string

export function shouldHideOnClose(options: { platform: DesktopPlatform; quitting: boolean }): boolean {
  // Windows keeps the tray-resident promise; macOS follows the platform
  // convention that closing all windows still keeps the app alive.
  return (options.platform === 'win32' || options.platform === 'darwin') && !options.quitting
}

export function shouldHideOnMinimize(platform: DesktopPlatform): boolean {
  return false
}

/** The slice of `BrowserWindow` this module needs; kept structural for tests. */
export interface TopmostCapableWindow {
  isDestroyed(): boolean
  isAlwaysOnTop(): boolean
  setAlwaysOnTop(value: boolean): void
}

/**
 * Keep the main window a normal, non-topmost window.
 *
 * Nothing in this shell asks for an always-on-top window, but the flag is a
 * persistent Win32 window style: once any process sets `WS_EX_TOPMOST` on our
 * HWND — an automation helper calling `SetWindowPos(HWND_TOPMOST)` is enough —
 * it sticks for the lifetime of the window and the app appears to float above
 * every other application. Re-assert the normal state whenever the window is
 * shown so it can never get stuck on top.
 */
export function ensureMainWindowIsNotTopmost(window: TopmostCapableWindow | null): void {
  if (window === null || window.isDestroyed()) return
  if (window.isAlwaysOnTop()) window.setAlwaysOnTop(false)
}
