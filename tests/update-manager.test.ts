import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RuntimeUpdateManager } from '../src/main/update-manager.js'

describe('runtime update manager', () => {
  it('only switches to a candidate after it passes health validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-update-'))
    const active = join(root, 'active')
    const candidate = join(root, 'candidate')
    await writeFile(active, 'old')
    await writeFile(candidate, 'new')

    const manager = new RuntimeUpdateManager({ activePath: active, candidatePath: candidate })
    await manager.activateCandidate(async (path) => (await readFile(path, 'utf8')) === 'new')

    await expect(readFile(active, 'utf8')).resolves.toBe('new')
  })

  it('keeps the active version when candidate validation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-update-'))
    const active = join(root, 'active')
    const candidate = join(root, 'candidate')
    await writeFile(active, 'old')
    await writeFile(candidate, 'bad')

    const manager = new RuntimeUpdateManager({ activePath: active, candidatePath: candidate })
    await expect(manager.activateCandidate(async () => false)).rejects.toThrow('health validation')
    await expect(readFile(active, 'utf8')).resolves.toBe('old')
  })
})
