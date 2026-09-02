import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanupStaleProcessLock } from '../src/main/stale-locks.js'

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
})
