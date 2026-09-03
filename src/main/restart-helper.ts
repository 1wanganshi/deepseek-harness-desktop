import { spawn } from 'node:child_process'

const [, , parentPidValue, executable, ...args] = process.argv
const parentPid = Number(parentPidValue)

function parentIsAlive(): boolean {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return false
  try {
    process.kill(parentPid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function launch(): void {
  if (typeof executable !== 'string' || executable.length === 0) process.exit(1)
  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  process.exit(0)
}

const deadline = Date.now() + 30_000
const poll = (): void => {
  if (!parentIsAlive() || Date.now() >= deadline) {
    // Give Windows a short moment to release the single-instance mutex after
    // the parent process disappears before creating the replacement process.
    setTimeout(launch, 150)
    return
  }
  setTimeout(poll, 100)
}

poll()
