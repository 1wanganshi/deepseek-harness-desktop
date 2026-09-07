import type { SessionDurabilityReport } from './session-durability.js'

export interface DesktopRestartOptions {
  verifyBeforeStop?: () => Promise<SessionDurabilityReport>
  verifyAfterStop?: () => Promise<SessionDurabilityReport>
  stop: () => Promise<void>
  resumeAfterBlockedStop?: () => Promise<void>
  relaunch: () => void
  exit: (code: number) => void
  stopTimeoutMs?: number
  onStopError?: (error: unknown) => void
}

export interface DesktopShutdownOptions {
  verifyBeforeStop?: () => Promise<SessionDurabilityReport>
  verifyAfterStop?: () => Promise<SessionDurabilityReport>
  stop: () => Promise<void>
  resumeAfterBlockedStop?: () => Promise<void>
  stopTimeoutMs?: number
  onStopError?: (error: unknown) => void
}

export interface DesktopRelaunchOptions {
  execPath: string
  args: string[]
}

export interface DesktopRestartResult {
  restarted: boolean
  report: SessionDurabilityReport | null
}

export interface DesktopShutdownResult {
  stopped: boolean
  report: SessionDurabilityReport | null
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

async function resumeAfterBlockedStop(options: DesktopShutdownOptions): Promise<void> {
  if (options.resumeAfterBlockedStop === undefined) return
  try {
    await options.resumeAfterBlockedStop()
  } catch (error) {
    options.onStopError?.(error)
  }
}

/**
 * Stop the Harness only after its session store is complete, then verify it
 * once more after the child process has flushed pending writes. A failed
 * verification leaves the desktop open and restores the Harness instead of
 * allowing an unsafe exit or relaunch.
 */
export async function shutdownDesktop(options: DesktopShutdownOptions): Promise<DesktopShutdownResult> {
  const report = options.verifyBeforeStop === undefined ? null : await options.verifyBeforeStop()
  if (report !== null && !report.safe) return { stopped: false, report }
  const timeoutMs = options.stopTimeoutMs ?? 5_000
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const stopped = await Promise.race([
      options.stop(),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ]).then(result => result === undefined)
    if (!stopped) {
      options.onStopError?.(new Error('Harness 停止超时'))
      return { stopped: false, report }
    }
  } catch (error) {
    options.onStopError?.(error)
    await resumeAfterBlockedStop(options)
    return { stopped: false, report }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  const finalReport = options.verifyAfterStop === undefined ? report : await options.verifyAfterStop()
  if (finalReport !== null && !finalReport.safe) {
    await resumeAfterBlockedStop(options)
    return { stopped: false, report: finalReport }
  }
  return { stopped: true, report: finalReport }
}

export async function restartDesktop(options: DesktopRestartOptions): Promise<DesktopRestartResult> {
  const shutdown = await shutdownDesktop(options)
  if (!shutdown.stopped) return { restarted: false, report: shutdown.report }
  options.relaunch()
  options.exit(0)
  return { restarted: true, report: shutdown.report }
}
