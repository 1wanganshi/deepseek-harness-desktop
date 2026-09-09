export type DesktopPlatform = 'win32' | 'darwin' | 'linux' | string

export function shouldHideOnClose(options: { platform: DesktopPlatform; quitting: boolean }): boolean {
  // Windows keeps the tray-resident promise; macOS follows the platform
  // convention that closing all windows still keeps the app alive.
  return (options.platform === 'win32' || options.platform === 'darwin') && !options.quitting
}

export function shouldHideOnMinimize(platform: DesktopPlatform): boolean {
  return false
}
