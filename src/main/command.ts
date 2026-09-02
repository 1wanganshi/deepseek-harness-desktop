import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

export function bundledPnpmScript(appRoot: string): string {
  return join(appRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
}

export interface RunCommandOptions {
  /** Milliseconds after which the child is killed and the promise rejects. */
  timeoutMs?: number
  /** Upper bound of captured output kept for error reporting. */
  maxOutputChars?: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_CHARS = 20_000

function terminateProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return
  child.kill()
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  }
}

/**
 * Runs a child process to completion. Unlike a bare spawn, it can never hang
 * forever: the optional timeout kills the whole process tree and rejects, so a
 * stuck package manager can never block app startup.
 */
export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  options: RunCommandOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
  return new Promise((resolve, reject) => {
    let settled = false
    let output = ''
    let timedOut = false

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    })

    const capture = (chunk: Buffer) => {
      output += chunk.toString()
      if (output.length > maxOutputChars * 2) output = output.slice(-maxOutputChars)
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)

    const timer = setTimeout(() => {
      timedOut = true
      terminateProcessTree(child)
    }, timeoutMs)
    timer.unref?.()

    const settle = (error: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === null) resolve()
      else reject(error)
    }

    child.once('error', error => settle(error))
    child.once('exit', code => {
      if (timedOut) {
        settle(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms${output ? `; last output: ${output.slice(-1000)}` : ''}`))
        return
      }
      if (code === 0) settle(null)
      else settle(new Error(`${command} ${args.join(' ')} failed with code ${code ?? 'unknown'}${output ? `: ${output.slice(-1000)}` : ''}`))
    })
  })
}
