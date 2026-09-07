export type DesktopPlatform = 'win32' | 'darwin' | 'linux' | string

export function shouldHideOnClose(options: { platform: DesktopPlatform; quitting: boolean }): boolean {
  return options.platform === 'win32' && !options.quitting
}

export function shouldHideOnMinimize(platform: DesktopPlatform): boolean {
  return platform === 'win32'
}
