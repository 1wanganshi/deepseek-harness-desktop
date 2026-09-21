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

  it('reconciles newly added legacy models and plugins after the initial migration without overwriting desktop choices', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-migration-marker-'))
    const legacyHome = join(root, 'legacy')
    const targetHome = join(root, 'target')
    const legacyProfile = join(legacyHome, 'profiles', 'web')
    await mkdir(legacyProfile, { recursive: true })
    await writeFile(join(legacyHome, 'settings.yaml'), [
      'agent-default-model:',
      '  provider: legacy-provider',
      '  model: first',
      'llm-pi-ai:',
      '  providers:',
      '    legacy-provider:',
      '      models:',
      '        - id: first',
      '',
    ].join('\n'))
    await writeFile(join(legacyProfile, 'package.json'), JSON.stringify({
      dependencies: { 'legacy-plugin': '1.0.0' },
      dsh: { profile: { bundles: ['legacy-plugin'] } },
    }))

    const first = await migrateLegacyDsh({ legacyHome, targetHome, backupRoot: join(root, 'backups') })
    await writeFile(join(targetHome, 'settings.yaml'), [
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
    await writeFile(join(legacyHome, 'settings.yaml'), [
      'agent-default-model:',
      '  provider: legacy-provider',
      '  model: second',
      'llm-pi-ai:',
      '  providers:',
      '    legacy-provider:',
      '      models:',
      '        - id: first',
      '        - id: second',
      '',
    ].join('\n'))
    await writeFile(join(legacyProfile, 'package.json'), JSON.stringify({
      dependencies: { 'legacy-plugin': '1.0.0', 'browser-plugin': 'file:C:/plugins/browser' },
      dsh: { profile: { bundles: ['legacy-plugin', 'browser-plugin'] } },
    }))
    const second = await migrateLegacyDsh({ legacyHome, targetHome, backupRoot: join(root, 'backups') })

    expect(first.status).toBe('migrated')
    expect(second.status).toBe('synchronized')
    const settings = await readFile(join(targetHome, 'settings.yaml'), 'utf8')
    expect(settings).toContain('desktop-model')
    expect(settings).toContain('legacy-provider')
    expect(settings).toContain('id: second')
    const profile = JSON.parse(await readFile(join(targetHome, 'profiles', 'web', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(profile.dependencies).toMatchObject({ 'legacy-plugin': '1.0.0', 'browser-plugin': 'file:C:/plugins/browser' })
    expect(profile.dsh.profile.bundles).toEqual(expect.arrayContaining(['legacy-plugin', 'browser-plugin']))
  })

  it('adopts sessions created in the legacy home after the one-time import', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-migration-sessions-'))
    const legacyHome = join(root, 'legacy')
    const targetHome = join(root, 'target')
    const backupRoot = join(root, 'backups')
    const legacySessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const desktopSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

    await mkdir(join(legacyHome, 'profiles', 'web'), { recursive: true })
    await writeFile(join(legacyHome, 'settings.yaml'), 'agent-default-model:\n  model: first\n')
    await writeFile(join(legacyHome, '.credentials.yaml'), 'providers:\n  legacy: credential\n')
    const first = await migrateLegacyDsh({ legacyHome, targetHome, backupRoot })
    expect(first.status).toBe('migrated')

    // Both homes now receive a session; only the legacy-only one may be adopted,
    // and the desktop copy of the shared id must survive untouched.
    const transcript = (dshHome: string, id: string, text: string) => writeFile(
      join(dshHome, 'sessions', '--D-vibecoding-DHS1--', `session-${id}`, 'session.v3.jsonl.zstd'),
      text,
    )
    await mkdir(join(legacyHome, 'sessions', '--D-vibecoding-DHS1--', `session-${legacySessionId}`), { recursive: true })
    await mkdir(join(legacyHome, 'sessions', '--D-vibecoding-DHS1--', `session-${desktopSessionId}`), { recursive: true })
    await mkdir(join(targetHome, 'sessions', '--D-vibecoding-DHS1--', `session-${desktopSessionId}`), { recursive: true })
    await transcript(legacyHome, legacySessionId, 'legacy-only')
    await transcript(legacyHome, desktopSessionId, 'legacy-stale')
    await transcript(targetHome, desktopSessionId, 'desktop-newer')
    await mkdir(join(legacyHome, 'storages', 'session_projcache', 'sessions'), { recursive: true })
    await writeFile(
      join(legacyHome, 'storages', 'session_projcache', 'sessions', `session-${legacySessionId}.json`),
      JSON.stringify({ version: 4, record: { identity: { cwd: 'D:\\vibecoding\\DHS1' } } }),
    )
    await writeFile(join(legacyHome, 'storages', 'session_projcache.json'), JSON.stringify({
      unit: { name: 'session_projcache', version: 4 },
      tables: { sessions: { [`session-${legacySessionId}`]: { record: {} } } },
    }))

    const second = await migrateLegacyDsh({ legacyHome, targetHome, backupRoot })

    expect(second.status).toBe('synchronized')
    await expect(readFile(join(targetHome, 'sessions', '--D-vibecoding-DHS1--', `session-${legacySessionId}`, 'session.v3.jsonl.zstd'), 'utf8')).resolves.toBe('legacy-only')
    await expect(readFile(join(targetHome, 'sessions', '--D-vibecoding-DHS1--', `session-${desktopSessionId}`, 'session.v3.jsonl.zstd'), 'utf8')).resolves.toBe('desktop-newer')
    await expect(access(join(targetHome, 'storages', 'session_projcache', 'sessions', `session-${legacySessionId}.json`))).resolves.toBeUndefined()
    const aggregate = JSON.parse(await readFile(join(targetHome, 'storages', 'session_projcache.json'), 'utf8')) as { tables: { sessions: Record<string, unknown> } }
    expect(Object.keys(aggregate.tables.sessions)).toContain(`session-${legacySessionId}`)
    expect(second.copiedPaths.some(path => path.includes(legacySessionId))).toBe(true)
    // Credentials must never be touched by the session drain.
    await expect(readFile(join(targetHome, '.credentials.yaml'), 'utf8')).resolves.toContain('legacy: credential')

    const third = await migrateLegacyDsh({ legacyHome, targetHome, backupRoot })
    expect(third.status).toBe('already-migrated')
  })
})
