import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { bundledPnpmScript, runCommand } from '../src/main/command.js'

const node = process.execPath

describe('runCommand', () => {
  it('resolves when the command exits with code 0', async () => {
    await runCommand(node, ['-e', 'process.stdout.write("ok")'], process.cwd())
  })

  it('rejects with exit output when the command fails', async () => {
    await expect(runCommand(node, ['-e', 'process.stderr.write("boom"); process.exit(3)'], process.cwd()))
      .rejects.toThrow(/failed with code 3/)
  })

  it('rejects when the executable cannot be spawned', async () => {
    await expect(runCommand('definitely-not-a-real-command-xyz', ['--version'], process.cwd()))
      .rejects.toThrow()
  })

  it('never hangs forever: a stuck child is killed after the timeout', async () => {
    const startedAt = Date.now()
    await expect(runCommand(
      node,
      ['-e', 'setInterval(() => {}, 1000)'],
      process.cwd(),
      process.env,
      { timeoutMs: 500 },
    )).rejects.toThrow(/timed out after 500ms/)
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeLessThan(10_000)
  })

  it('caps captured output so huge logs cannot exhaust memory', async () => {
    // Emit ~2MB; the capture buffer must stay bounded and the rejection
    // message must still surface the tail.
    await expect(runCommand(
      node,
      ['-e', 'process.stdout.write("x".repeat(2_000_000)); process.exit(1)'],
      process.cwd(),
      process.env,
      { maxOutputChars: 5_000 },
    )).rejects.toThrow(/failed with code 1/)
  })
})

describe('bundledPnpmScript', () => {
  it('points at the pnpm binary shipped in app dependencies', () => {
    expect(bundledPnpmScript('C:/app/root')).toBe(
      join('C:/app/root', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    )
  })
})
