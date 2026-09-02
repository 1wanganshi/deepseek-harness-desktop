import { access, mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrateLegacyDsh } from '../src/main/migration.js'

describe('legacy DSH migration', () => {
  it('moves credentials, model settings, plugins, and user data while preserving official bundles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-migration-'))
    const legacyHome = join(root, 'legacy')
    const targetHome = join(root, 'target')
    const backupRoot = join(root, 'backups')
    const legacyProfile = join(legacyHome, 'profiles', 'web')

    await mkdir(legacyProfile, { recursive: true })
    await writeFile(join(legacyHome, '.credentials.yaml'), 'providers:\n  example: credential-ref\n')
    await writeFile(join(legacyHome, 'settings.yaml'), [
      'llm-pi-ai:',
      '  providers:',
      '    example-provider:',
      '      displayName: Example',
      'agent-default-model:',
      '  provider: example-provider',
      '  model: example-model',
      '',
    ].join('\n'))
    await mkdir(join(legacyHome, 'sessions'), { recursive: true })
    await writeFile(join(legacyHome, 'sessions', 'old-session.json'), '{"title":"old"}')
    await mkdir(join(legacyHome, 'attachments'), { recursive: true })
    await writeFile(join(legacyHome, 'attachments', 'old.txt'), 'attachment')
    await writeFile(join(legacyProfile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { 'dsh-plugin-example': '^1.2.3' },
      dsh: { profile: { bundles: ['dsh-plugin-example'], patchReload: 'live' } },
    }))
    await writeFile(join(legacyProfile, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    await writeFile(join(legacyProfile, 'cordis.patch.yml'), '[]\n')

    await mkdir(join(targetHome, 'profiles', 'web'), { recursive: true })
    await writeFile(join(targetHome, 'settings.yaml'), 'ui-onboarding:\n  welcomeNoticeVersion: old\n')
    await writeFile(join(targetHome, '.credentials.yaml'), 'providers:\n  target: old\n')
    await writeFile(join(targetHome, 'profiles', 'web', 'package.json'), JSON.stringify({
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }))

    const status = await migrateLegacyDsh({ legacyHome, targetHome, backupRoot })

    expect(status.status).toBe('migrated')
    expect(status.pluginNames).toContain('dsh-plugin-example')
    await expect(readFile(join(targetHome, '.credentials.yaml'), 'utf8')).resolves.toContain('credential-ref')
    await expect(readFile(join(targetHome, 'settings.yaml'), 'utf8')).resolves.toContain('example-model')
    await expect(readFile(join(targetHome, 'sessions', 'old-session.json'), 'utf8')).resolves.toContain('old')
    await expect(readFile(join(targetHome, 'attachments', 'old.txt'), 'utf8')).resolves.toBe('attachment')

    const packageJson = JSON.parse(await readFile(join(targetHome, 'profiles', 'web', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(packageJson.dependencies['dsh-plugin-example']).toBe('^1.2.3')
    expect(packageJson.dsh.profile.bundles).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'dsh-plugin-example',
    ]))
    await expect(access(join(targetHome, 'profiles', 'web', 'node_modules'))).rejects.toThrow()
    await expect(stat(status.backupPath!)).resolves.toBeDefined()
  })

  it('restores the target and leaves the legacy home untouched when migration fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-migration-rollback-'))
    const legacyHome = join(root, 'legacy')
    const targetHome = join(root, 'target')
    const backupRoot = join(root, 'backups')
    await mkdir(legacyHome, { recursive: true })
    await mkdir(targetHome, { recursive: true })
    await writeFile(join(legacyHome, 'settings.yaml'), 'this: [is: invalid\n')
    await writeFile(join(targetHome, 'settings.yaml'), 'ui-onboarding:\n  keep: true\n')

    const status = await migrateLegacyDsh({ legacyHome, targetHome, backupRoot })

    expect(status.status).toBe('failed')
    await expect(readFile(join(targetHome, 'settings.yaml'), 'utf8')).resolves.toContain('keep: true')
    await expect(access(join(targetHome, '.desktop-migration.json'))).rejects.toThrow()
    await expect(readFile(join(legacyHome, 'settings.yaml'), 'utf8')).resolves.toContain('invalid')
    await expect(stat(status.backupPath!)).resolves.toBeDefined()
  })

  it('does not migrate a second time after a successful marker is written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-migration-marker-'))
    const legacyHome = join(root, 'legacy')
    const targetHome = join(root, 'target')
    await mkdir(legacyHome, { recursive: true })
    await writeFile(join(legacyHome, 'settings.yaml'), 'agent-default-model:\n  model: first\n')

    const first = await migrateLegacyDsh({ legacyHome, targetHome, backupRoot: join(root, 'backups') })
    await writeFile(join(legacyHome, 'settings.yaml'), 'agent-default-model:\n  model: second\n')
    const second = await migrateLegacyDsh({ legacyHome, targetHome, backupRoot: join(root, 'backups') })

    expect(first.status).toBe('migrated')
    expect(second.status).toBe('already-migrated')
    await expect(readFile(join(targetHome, 'settings.yaml'), 'utf8')).resolves.toContain('first')
  })
})
