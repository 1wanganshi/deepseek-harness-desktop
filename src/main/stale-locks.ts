import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'

export type ProcessAlive = (pid: number) => Promise<boolean>

interface ProcessLock {
  pid?: unknown
}

function readLockPid(content: string): number | null {
  try {
    const lock = JSON.parse(content) as ProcessLock
    if (typeof lock.pid === 'number' && Number.isInteger(lock.pid) && lock.pid > 0) return lock.pid
  } catch {
    // DHS profile locks are written as a plain PID, unlike the JSON task-board lock.
  }
  const numericPid = content.trim()
  if (!/^\d+$/.test(numericPid)) return null
  const pid = Number(numericPid)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

export async function cleanupStaleProcessLock(path: string, isProcessAlive: ProcessAlive): Promise<boolean> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch {
    return false
  }
  const pid = readLockPid(content)
  if (pid === null || await isProcessAlive(pid)) return false
  await rm(path, { force: true })
  return true
}

export async function isWindowsProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code !== 'ESRCH'
  }
}

/**
 * A numeric DHS lock only records a PID. Windows can reuse that PID for an
 * unrelated process after the original writer exits, so existence alone is
 * not enough to keep the lock.
 */
export function processCommandLineBelongsToDsh(commandLine: string, dshHome: string): boolean {
  const normalized = commandLine.toLowerCase().replaceAll('/', '\\')
  const home = dshHome.toLowerCase().replaceAll('/', '\\').replace(/[\\]+$/, '')
  if (home !== '' && normalized.includes(home)) return true
  return [
    'deepseek harness desktop',
    '@deepseek-ai\\dsh',
    'dsh-app-boot',
    '\\dsh\\lib\\bin.js',
  ].some(marker => normalized.includes(marker))
}

function readWindowsProcessCommandLine(pid: number): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise(resolve => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$process = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"; if ($null -eq $process) { exit 1 }; $process.CommandLine`,
      ],
      { windowsHide: true },
      (error, stdout) => resolve(error === null ? stdout.trim() : null),
    )
  })
}

/** Check that a live PID is the DHS writer expected by this profile lock. */
export async function isWindowsDshProcessAlive(pid: number, dshHome: string): Promise<boolean> {
  if (!await isWindowsProcessAlive(pid)) return false
  const commandLine = await readWindowsProcessCommandLine(pid)
  // If process inspection is unavailable, preserve the lock. Deleting an
  // active writer's lock is more dangerous than waiting for operator repair.
  return commandLine === null || processCommandLineBelongsToDsh(commandLine, dshHome)
}
