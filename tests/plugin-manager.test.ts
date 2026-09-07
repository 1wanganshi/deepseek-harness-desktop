import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginManager } from '../src/main/plugin-manager.js'

const roots: string[] = []

async function setup() {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-plugin-home-'))
  roots.push(dshHome)
  const profile = join(dshHome, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-plugin-example': '1.0.0' } }))
  return { dshHome, profile }
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('plugin manager', () => {
  it('updates only a candidate profile until validation succeeds', async () => {
    const { dshHome, profile } = await setup()
    const updateCwds: string[] = []
    let activeDuringValidation = ''
    const manager = new PluginManager({
      dshHome,
      runPnpm: async cwd => {
        updateCwds.push(cwd)
        await writeFile(join(cwd, 'package.json'), JSON.stringify({ dependencies: { 'dsh-plugin-example': '2.0.0' } }))
      },
      validateCandidate: async candidatePath => {
        activeDuringValidation = await readFile(join(profile, 'package.json'), 'utf8')
        await expect(readFile(join(candidatePath, 'package.json'), 'utf8')).resolves.toContain('2.0.0')
      },
    })

    const status = await manager.sync()

    expect(updateCwds).toHaveLength(1)
    expect(updateCwds[0]).toMatch(/web\.candidate-/)
    expect(activeDuringValidation).toContain('1.0.0')
    expect(status.phase).toBe('validated')
    expect(status.lastKnownGoodProfilePath).toMatch(/web\.last-known-good-/)
    await expect(readFile(join(profile, 'package.json'), 'utf8')).resolves.toContain('2.0.0')
    await expect(readFile(join(status.lastKnownGoodProfilePath as string, 'package.json'), 'utf8')).resolves.toContain('1.0.0')
  })

  it('leaves the active profile intact when candidate validation fails', async () => {
    const { dshHome, profile } = await setup()
    const manager = new PluginManager({
      dshHome,
      runPnpm: async cwd => {
        await writeFile(join(cwd, 'package.json'), JSON.stringify({ dependencies: { 'dsh-plugin-example': '2.0.0' } }))
      },
      validateCandidate: async () => { throw new Error('candidate validation failed') },
    })

    const status = await manager.sync()

    expect(status.phase).toBe('rolled-back')
    expect(status.error).toContain('candidate validation failed')
    await expect(readFile(join(profile, 'package.json'), 'utf8')).resolves.toContain('1.0.0')
    await expect(readdir(join(dshHome, 'profiles'))).resolves.not.toContain(expect.stringMatching(/^web\.candidate-/))
  })

  it('leaves the active profile intact when package download fails', async () => {
    const { dshHome, profile } = await setup()
    const manager = new PluginManager({
      dshHome,
      runPnpm: async () => { throw new Error('simulated registry interruption') },
    })

    const status = await manager.sync()

    expect(status.phase).toBe('rolled-back')
    expect(status.error).toContain('simulated registry interruption')
    await expect(readFile(join(profile, 'package.json'), 'utf8')).resolves.toContain('1.0.0')
  })

  it('coalesces concurrent sync requests into one update operation', async () => {
    const { dshHome } = await setup()
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

  it('can restore the last known-good profile after a post-switch startup failure', async () => {
    const { dshHome, profile } = await setup()
    const manager = new PluginManager({
      dshHome,
      runPnpm: async cwd => {
        await writeFile(join(cwd, 'package.json'), JSON.stringify({ dependencies: { 'dsh-plugin-example': '2.0.0' } }))
      },
    })
    await manager.sync()

    const status = await manager.rollbackLastKnownGood()

    expect(status.phase).toBe('rolled-back')
    await expect(readFile(join(profile, 'package.json'), 'utf8')).resolves.toContain('1.0.0')
  })
})
