export function desktopWebPreferences(preload: string) {
  return {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    // The preload is emitted as an ESM module. Electron sandboxed preloads
    // cannot evaluate its import statements, which silently removes desktopApi.
    sandbox: false,
  } as const
}
