import { access, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { mitigateIncompatibleTaskBoard, normalizeProfilePatchFile } from '../src/main/incompatible-plugins.js'

describe('incompatible community plugins', () => {
  it('disables the aggregate doctor supervisor so it cannot install a background Windows task', async () => {
    const profilePath = await createWebAllProfile('0.1.2')

    await mitigateIncompatibleTaskBoard({ profilePath, runtimeVersion: '0.1.2' })

    const patch = await readFile(join(profilePath, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('id: web-ui-doctor')
    expect(patch).toContain('disabled: true')
  })

  it('disables only the task-board row for a runtime older than its declared engine', async () => {
    const profilePath = await createWebAllProfile('0.1.1-rc.2')
    const result = await mitigateIncompatibleTaskBoard({ profilePath, runtimeVersion: '0.1.1-rc.2' })

    expect(result).toEqual({ changed: true, taskBoardDisabled: true })
    await expect(readFile(join(profilePath, 'cordis.patch.yml'), 'utf8')).resolves.toContain('id: web-ui-task-board')
    await expect(readFile(join(profilePath, 'cordis.patch.yml'), 'utf8')).resolves.toContain('disabled: true')
  })

  it('keeps task-board disabled for the 0.1.2 release candidate that lacks its session/list API', async () => {
    const profilePath = await createWebAllProfile('0.1.2-rc.1')

    await expect(mitigateIncompatibleTaskBoard({ profilePath, runtimeVersion: '0.1.2-rc.1' }))
      .resolves.toEqual({ changed: true, taskBoardDisabled: true })
    await expect(readFile(join(profilePath, 'cordis.patch.yml'), 'utf8')).resolves.toContain('id: web-ui-task-board')
  })

  it('disables only known incompatible community entries for the 0.1.2 release candidate', async () => {
    const profilePath = await createWebAllProfile('0.1.2-rc.1', [
      '@linxin666/dsh-web-all',
      'dsh-vision-router',
      'dsh-browser-computer-use',
    ])

    await mitigateIncompatibleTaskBoard({ profilePath, runtimeVersion: '0.1.2-rc.1' })

    const patch = await readFile(join(profilePath, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('id: web-ui-task-board')
    expect(patch).toContain('id: vision-router')
    expect(patch).toContain('id: browser-computer-use')
    expect(patch.match(/disabled: true/g)).toHaveLength(4)
  })

  it('keeps user patch rows and removes its temporary task-board override when the runtime reaches 0.1.2 stable', async () => {
    const profilePath = await createWebAllProfile('0.1.2')
    const patchPath = join(profilePath, 'cordis.patch.yml')
    await writeFile(patchPath, [
      '- id: user-plugin',
      '  config:',
      '    enabled: true',
      '# deepseek-harness-desktop: incompatible task-board disabled',
      '- id: web-ui-task-board',
      '  disabled: true',
      '# deepseek-harness-desktop: end incompatible task-board disabled',
      '',
    ].join('\n'))

    const result = await mitigateIncompatibleTaskBoard({ profilePath, runtimeVersion: '0.1.2' })

    expect(result).toEqual({ changed: true, taskBoardDisabled: false })
    const patch = await readFile(patchPath, 'utf8')
    expect(patch).toContain('id: user-plugin')
    expect(patch).not.toContain('web-ui-task-board')
  })

  it('does not alter profiles that do not use the aggregate web plugin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-mitigation-none-'))
    const profilePath = join(root, 'profiles', 'web')
    await mkdir(profilePath, { recursive: true })
    await writeFile(join(profilePath, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dshmarket'] } } }))
    await writeFile(join(profilePath, 'cordis.patch.yml'), '[]\n')

    await expect(mitigateIncompatibleTaskBoard({ profilePath, runtimeVersion: '0.1.1-rc.2' }))
      .resolves.toEqual({ changed: false, taskBoardDisabled: false })
    await expect(readFile(join(profilePath, 'cordis.patch.yml'), 'utf8')).resolves.toBe('[]\n')
  })

  it('repairs a comment-only empty patch into a valid empty array', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-mitigation-comment-only-'))
    const profilePath = join(root, 'profiles', 'web')
    const patchPath = join(profilePath, 'cordis.patch.yml')
    await mkdir(profilePath, { recursive: true })
    await writeFile(join(profilePath, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dshmarket'] } } }))
    await writeFile(patchPath, '# empty desktop overlay\n')

    await expect(mitigateIncompatibleTaskBoard({ profilePath, runtimeVersion: '0.1.2-rc.1' }))
      .resolves.toEqual({ changed: true, taskBoardDisabled: false })
    await expect(readFile(patchPath, 'utf8')).resolves.toBe('[]\n')
  })

  it('keeps a comment-only empty patch valid YAML when adding the override', async () => {
    const profilePath = await createWebAllProfile('0.1.1-rc.2')
    await writeFile(join(profilePath, 'cordis.patch.yml'), [
      '# profile overlay',
      '[]',
      '',
    ].join('\n'))

    await mitigateIncompatibleTaskBoard({ profilePath, runtimeVersion: '0.1.1-rc.2' })

    const patch = YAML.parse(await readFile(join(profilePath, 'cordis.patch.yml'), 'utf8')) as unknown
    expect(patch).toEqual([
      { id: 'web-ui-doctor', disabled: true },
      { id: 'web-ui-task-board', disabled: true },
    ])
  })

  it('normalizes a missing profile patch before the first runtime boot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-missing-patch-'))
    const profilePath = join(root, 'profiles', 'web')
    await mkdir(profilePath, { recursive: true })

    await expect(normalizeProfilePatchFile(profilePath)).resolves.toEqual({
      changed: true,
      path: join(profilePath, 'cordis.patch.yml'),
    })
    await expect(readFile(join(profilePath, 'cordis.patch.yml'), 'utf8')).resolves.toBe('[]\n')
  })

  it('wraps a legacy single-object patch in the required top-level array', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-object-patch-'))
    const profilePath = join(root, 'profiles', 'web')
    const patchPath = join(profilePath, 'cordis.patch.yml')
    await mkdir(profilePath, { recursive: true })
    await writeFile(patchPath, 'id: user-plugin\ndisabled: true\n')

    await expect(normalizeProfilePatchFile(profilePath)).resolves.toEqual({ changed: true, path: patchPath })
    expect(YAML.parse(await readFile(patchPath, 'utf8'))).toEqual([{ id: 'user-plugin', disabled: true }])
  })

  it('normalizes a comment-only patch before dependency preparation can fail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-preflight-patch-'))
    const profilePath = join(root, 'profiles', 'web')
    const patchPath = join(profilePath, 'cordis.patch.yml')
    await mkdir(profilePath, { recursive: true })
    await writeFile(patchPath, '# created by an older desktop build\n')

    await normalizeProfilePatchFile(profilePath)
    await expect(readFile(patchPath, 'utf8')).resolves.toBe('[]\n')
  })

  it('serializes concurrent profile patch writes without concatenating YAML rows', async () => {
    const profilePath = await createWebAllProfile('0.1.1-rc.2')

    await Promise.all([
      normalizeProfilePatchFile(profilePath),
      mitigateIncompatibleTaskBoard({ profilePath, runtimeVersion: '0.1.1-rc.2' }),
      mitigateIncompatibleTaskBoard({ profilePath, runtimeVersion: '0.1.1-rc.2' }),
    ])

    const patch = await readFile(join(profilePath, 'cordis.patch.yml'), 'utf8')
    expect(patch).not.toContain('false- id')
    expect(YAML.parse(patch)).toEqual([
      { id: 'web-ui-doctor', disabled: true },
      { id: 'web-ui-task-board', disabled: true },
    ])
  })

  it('backs up an invalid overlay before replacing it with a valid empty layer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-corrupt-patch-'))
    const profilePath = join(root, 'profiles', 'web')
    const patchPath = join(profilePath, 'cordis.patch.yml')
    await mkdir(profilePath, { recursive: true })
    const original = '- id: user-plugin\n  disabled: false- id: broken\n'
    await writeFile(patchPath, original)

    await normalizeProfilePatchFile(profilePath)

    await expect(readFile(patchPath, 'utf8')).resolves.toBe('[]\n')
    const entries = await readdir(profilePath)
    const backups = entries.filter(name => name.startsWith('cordis.patch.yml.corrupt-'))
    expect(backups).toHaveLength(1)
    await expect(readFile(join(profilePath, backups[0]), 'utf8')).resolves.toBe(original)
    await expect(access(join(profilePath, `${backups[0]}`))).resolves.toBeUndefined()
  })
})

async function createWebAllProfile(runtimeVersion: string, bundles = ['@linxin666/dsh-web-all']): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-mitigation-'))
  const profilePath = join(root, 'profiles', 'web')
  await mkdir(profilePath, { recursive: true })
  await writeFile(join(profilePath, 'package.json'), JSON.stringify({
    dependencies: { '@linxin666/dsh-web-all': '^0.3.10' },
    dsh: { profile: { bundles } },
  }))
  await writeFile(join(profilePath, 'cordis.patch.yml'), '[]\n')
  return profilePath
}
