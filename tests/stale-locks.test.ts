import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanupStaleProcessLock, processCommandLineBelongsToDsh } from '../src/main/stale-locks.js'

describe('stale process locks', () => {
  it('removes a lock only when its recorded process is no longer alive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lock-'))
    const lockPath = join(root, 'ledger.lock')
    await writeFile(lockPath, JSON.stringify({ pid: 12345, token: 'stale' }))

    const removed = await cleanupStaleProcessLock(lockPath, async pid => pid === 99999)

    expect(removed).toBe(true)
    await expect(access(lockPath)).rejects.toThrow()
  })

  it('keeps a lock when its recorded process is alive or its contents are invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lock-'))
    const activePath = join(root, 'active.lock')
    const invalidPath = join(root, 'invalid.lock')
    await writeFile(activePath, JSON.stringify({ pid: 99999, token: 'active' }))
    await writeFile(invalidPath, 'not-json')

    await expect(cleanupStaleProcessLock(activePath, async pid => pid === 99999)).resolves.toBe(false)
    await expect(cleanupStaleProcessLock(invalidPath, async () => false)).resolves.toBe(false)
    await expect(readFile(activePath, 'utf8')).resolves.toContain('active')
    await expect(readFile(invalidPath, 'utf8')).resolves.toBe('not-json')
  })

  it('removes a stale DHS numeric-PID profile lock but keeps an active one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-numeric-lock-'))
    const stalePath = join(root, 'node_modules.lock')
    const activePath = join(root, 'active-node_modules.lock')
    await writeFile(stalePath, '12345\n')
    await writeFile(activePath, '99999\n')

    await expect(cleanupStaleProcessLock(stalePath, async pid => pid === 99999)).resolves.toBe(true)
    await expect(cleanupStaleProcessLock(activePath, async pid => pid === 99999)).resolves.toBe(false)
    await expect(access(stalePath)).rejects.toThrow()
    await expect(readFile(activePath, 'utf8')).resolves.toBe('99999\n')
  })

  it('recognizes PID reuse when the live process is unrelated to DHS', () => {
    const dshHome = 'C:\\Users\\Lenovo\\AppData\\Roaming\\deepseek-harness-desktop\\dsh-home'
    expect(processCommandLineBelongsToDsh(
      'C:\\Windows\\System32\\fontdrvhost.exe -Embedding',
      dshHome,
    )).toBe(false)
    expect(processCommandLineBelongsToDsh(
      `"D:\\vibecoding\\DHS1\\resources\\node\\node.exe" @deepseek-ai\\dsh\\lib\\bin.js --profile web`,
      dshHome,
    )).toBe(true)
  })

  it('matches macOS-style bundle paths after slash normalization', () => {
    const dshHome = '/Users/demo/Library/Application Support/deepseek-harness-desktop/dsh-home'
    expect(processCommandLineBelongsToDsh(
      '/Applications/DeepSeek Harness Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open',
      dshHome,
    )).toBe(true)
    expect(processCommandLineBelongsToDsh('/usr/sbin/cfprefsd agent mode', dshHome)).toBe(false)
  })
})
