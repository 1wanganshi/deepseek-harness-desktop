import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { mitigateIncompatibleTaskBoard } from '../src/main/incompatible-plugins.js'

describe('incompatible community plugins', () => {
  it('disables only the task-board row for a runtime older than its declared engine', async () => {
    const profilePath = await createWebAllProfile('0.1.1-rc.2')
    const result = await mitigateIncompatibleTaskBoard({ profilePath, runtimeVersion: '0.1.1-rc.2' })

    expect(result).toEqual({ changed: true, taskBoardDisabled: true })
    await expect(readFile(join(profilePath, 'cordis.patch.yml'), 'utf8')).resolves.toContain('id: web-ui-task-board')
    await expect(readFile(join(profilePath, 'cordis.patch.yml'), 'utf8')).resolves.toContain('disabled: true')
  })

  it('keeps user patch rows and removes its temporary task-board override when the runtime catches up', async () => {
    const profilePath = await createWebAllProfile('0.1.2-alpha.5')
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

    const result = await mitigateIncompatibleTaskBoard({ profilePath, runtimeVersion: '0.1.2-alpha.5' })

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

  it('keeps a comment-only empty patch valid YAML when adding the override', async () => {
    const profilePath = await createWebAllProfile('0.1.1-rc.2')
    await writeFile(join(profilePath, 'cordis.patch.yml'), [
      '# profile overlay',
      '[]',
      '',
    ].join('\n'))

    await mitigateIncompatibleTaskBoard({ profilePath, runtimeVersion: '0.1.1-rc.2' })

    const patch = YAML.parse(await readFile(join(profilePath, 'cordis.patch.yml'), 'utf8')) as unknown
    expect(patch).toEqual([{ id: 'web-ui-task-board', disabled: true }])
  })
})

async function createWebAllProfile(runtimeVersion: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-mitigation-'))
  const profilePath = join(root, 'profiles', 'web')
  await mkdir(profilePath, { recursive: true })
  await writeFile(join(profilePath, 'package.json'), JSON.stringify({
    dependencies: { '@linxin666/dsh-web-all': '^0.3.10' },
    dsh: { profile: { bundles: ['@linxin666/dsh-web-all'] } },
  }))
  await writeFile(join(profilePath, 'cordis.patch.yml'), '[]\n')
  return profilePath
}
