import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OfficialUpdateService } from '../src/main/official-updates.js'

async function createPaths(root: string) {
  const userRuntimeRoot = join(root, 'runtime')
  return {
    bundledRoot: join(root, 'bundled'),
    userRuntimeRoot,
    pointerPath: join(userRuntimeRoot, 'active.json'),
    dshHome: join(root, 'home'),
  }
}

describe('official DSH update service', () => {
  it('reports an npm latest version without installing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-update-check-'))
    const paths = await createPaths(root)
    const service = new OfficialUpdateService({
      paths,
      currentVersion: async () => '0.1.0',
      runNpm: async () => undefined,
      fetchImpl: async () => new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 }),
    })

    await expect(service.check()).resolves.toMatchObject({
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: true,
    })
  })

  it('does not switch the active pointer when candidate runtime health fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-update-fail-'))
    const paths = await createPaths(root)
    await mkdir(paths.userRuntimeRoot, { recursive: true })
    await writeFile(paths.pointerPath, JSON.stringify({ root: 'old-runtime', version: '0.1.0' }))
    const service = new OfficialUpdateService({
      paths,
      currentVersion: async () => '0.1.0',
      runNpm: async (cwd) => {
        await mkdir(join(cwd, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
        await writeFile(join(cwd, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '')
      },
    })

    await expect(service.install('0.2.0', async () => false)).rejects.toThrow('health validation')
    await expect(readFile(paths.pointerPath, 'utf8')).resolves.toContain('old-runtime')
  })

  it('switches the pointer only after candidate runtime health succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-update-success-'))
    const paths = await createPaths(root)
    let candidatePolicy = ''
    const service = new OfficialUpdateService({
      paths,
      currentVersion: async () => '0.1.0',
      runNpm: async (cwd, args) => {
        candidatePolicy = await readFile(join(cwd, 'package.json'), 'utf8')
        expect(args).toEqual(['install', '--no-audit', '--no-fund', '--loglevel=warn'])
        await mkdir(join(cwd, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
        await writeFile(join(cwd, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '')
      },
    })

    await service.install('0.2.0', async (root) => root.endsWith('dsh-0.2.0'))
    expect(candidatePolicy).toContain('dsh-managed-runtime')
    await expect(readFile(join(paths.userRuntimeRoot, 'versions', 'dsh-0.2.0', 'pnpm-workspace.yaml'), 'utf8')).rejects.toThrow()
    await expect(readFile(paths.pointerPath, 'utf8')).resolves.toMatch(/"version": "0.2.0"/)
  })
})
