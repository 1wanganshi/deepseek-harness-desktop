import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PluginManager } from '../src/main/plugin-manager.js'

describe('plugin manager', () => {
  it('updates the official web profile dependencies while retaining a backup on failure', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-plugin-home-'))
    const profile = join(dshHome, 'profiles', 'web')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-plugin-example': '1.0.0' } }))
    const manager = new PluginManager({
      dshHome,
      runPnpm: async () => { throw new Error('simulated registry interruption') },
    })

    const status = await manager.sync()

    expect(status.error).toContain('simulated registry interruption')
    await expect(readFile(`${profile}.backup/package.json`, 'utf8')).resolves.toContain('dsh-plugin-example')
  })

  it('restores the active profile when an update changes files but fails validation', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-plugin-rollback-'))
    const profile = join(dshHome, 'profiles', 'web')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-plugin-example': '1.0.0' } }))
    const manager = new PluginManager({
      dshHome,
      runPnpm: async () => {
        await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-plugin-example': '2.0.0' } }))
      },
      validateProfile: async () => false,
    })

    const status = await manager.sync()

    expect(status.error).toContain('validation')
    await expect(readFile(join(profile, 'package.json'), 'utf8')).resolves.toContain('1.0.0')
    await expect(readFile(`${profile}.backup/package.json`, 'utf8')).resolves.toContain('1.0.0')
  })

  it('coalesces concurrent sync requests into one update operation', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-plugin-lock-'))
    const profile = join(dshHome, 'profiles', 'web')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-plugin-example': '1.0.0' } }))
    let updateCount = 0
    const manager = new PluginManager({
      dshHome,
      runPnpm: async () => {
        updateCount += 1
        await new Promise(resolve => setTimeout(resolve, 10))
      },
    })

    await Promise.all([manager.sync(), manager.sync()])

    expect(updateCount).toBe(1)
  })
})
