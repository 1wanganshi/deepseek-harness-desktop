import { readFile, rm } from 'node:fs/promises'

export type ProcessAlive = (pid: number) => Promise<boolean>

interface ProcessLock {
  pid?: unknown
}

export async function cleanupStaleProcessLock(path: string, isProcessAlive: ProcessAlive): Promise<boolean> {
  let lock: ProcessLock
  try {
    lock = JSON.parse(await readFile(path, 'utf8')) as ProcessLock
  } catch {
    return false
  }
  if (typeof lock.pid !== 'number' || !Number.isInteger(lock.pid) || lock.pid <= 0) return false
  if (await isProcessAlive(lock.pid)) return false
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
