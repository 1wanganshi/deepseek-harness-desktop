export interface DesktopRestartOptions {
  stop: () => Promise<void>
  relaunch: () => void
  exit: (code: number) => void
  stopTimeoutMs?: number
  onStopError?: (error: unknown) => void
}

export interface DesktopRelaunchOptions {
  execPath: string
  args: string[]
}

export function buildRestartHelperArgs(
  helperPath: string,
  parentPid: number,
  executable: string,
  argv: string[],
): string[] {
  return [helperPath, String(parentPid), executable, ...argv.slice(1)]
}

export function shouldProceedWithDesktopRestart(response: number): boolean {
  return response === 1
}

export function buildDesktopRelaunchOptions(execPath: string, argv: string[]): DesktopRelaunchOptions {
  return {
    execPath,
    args: argv.slice(1),
  }
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
