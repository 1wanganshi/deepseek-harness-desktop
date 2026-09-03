export interface DesktopRestartOptions {
  stop: () => Promise<void>
  relaunch: () => void
  exit: (code: number) => void
  stopTimeoutMs?: number
  onStopError?: (error: unknown) => void
}

export async function restartDesktop(options: DesktopRestartOptions): Promise<void> {
  const timeoutMs = options.stopTimeoutMs ?? 5_000
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      options.stop(),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } catch (error) {
    options.onStopError?.(error)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    options.relaunch()
    options.exit(0)
  }
}
