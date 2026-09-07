import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { ConfigurationDurabilityGuard } from '../src/main/configuration-durability.js'

describe('configuration durability guard', () => {
  it('restores missing providers, plugin declarations, and credentials without overwriting a newer desktop default', async () => {
    const root = await mkdirTemp('dsh-configuration-durability-')
    const dshHome = join(root, 'dsh-home')
    const profile = join(dshHome, 'profiles', 'web')
    const backupRoot = join(root, 'backups')
    await mkdir(profile, { recursive: true })
    await writeFile(join(dshHome, '.credentials.yaml'), 'providers:\n  original: credential-ref\n')
    await writeFile(join(dshHome, 'settings.yaml'), [
      'agent-default-model:',
      '  provider: desktop-provider',
      '  model: desktop-model',
      'llm-pi-ai:',
      '  providers:',
      '    desktop-provider:',
      '      models:',
      '        - id: desktop-model',
      '    original-provider:',
      '      models:',
      '        - id: original-model',
      '',
    ].join('\n'))
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      dependencies: { 'desktop-plugin': '1.0.0', 'original-plugin': '2.0.0' },
      dsh: { profile: { bundles: ['desktop-plugin', 'original-plugin'] } },
    }))

    const guard = new ConfigurationDurabilityGuard({ dshHome, backupRoot })
    await expect(guard.protect()).resolves.toMatchObject({ captured: true, restored: [] })

    await writeFile(join(dshHome, 'settings.yaml'), [
      'agent-default-model:',
      '  provider: desktop-provider',
      '  model: desktop-model',
      'llm-pi-ai:',
      '  providers:',
      '    desktop-provider:',
      '      models:',
      '        - id: desktop-model',
      '',
    ].join('\n'))
    await rm(join(dshHome, '.credentials.yaml'))
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      dependencies: { 'desktop-plugin': '1.0.0' },
      dsh: { profile: { bundles: ['desktop-plugin'] } },
    }))

    const report = await guard.protect()

    expect(report.restored).toEqual(expect.arrayContaining(['credentials', 'models', 'plugins']))
    const settings = YAML.parse(await readFile(join(dshHome, 'settings.yaml'), 'utf8')) as {
      'agent-default-model': { provider: string; model: string }
      'llm-pi-ai': { providers: Record<string, { models: Array<{ id: string }> }> }
    }
    expect(settings['agent-default-model']).toEqual({ provider: 'desktop-provider', model: 'desktop-model' })
    expect(settings['llm-pi-ai'].providers['original-provider'].models).toEqual([{ id: 'original-model' }])
    await expect(readFile(join(dshHome, '.credentials.yaml'), 'utf8')).resolves.toContain('credential-ref')
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dependencies).toMatchObject({ 'desktop-plugin': '1.0.0', 'original-plugin': '2.0.0' })
    expect(manifest.dsh.profile.bundles).toEqual(expect.arrayContaining(['desktop-plugin', 'original-plugin']))
    await expect(access(report.snapshotPath)).resolves.toBeUndefined()
  })
})

async function mkdirTemp(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  return mkdtemp(join(tmpdir(), prefix))
}
