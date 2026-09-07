import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { repairOpenAiProviderCompatibility } from '../src/main/provider-compatibility.js'

describe('OpenAI provider compatibility repair', () => {
  it('does nothing when the settings file is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-provider-compat-missing-'))

    await expect(repairOpenAiProviderCompatibility(join(root, 'settings.yaml'))).resolves.toEqual({
      changed: false,
      providerIds: [],
    })
  })

  it('adds the developer-role compatibility switch without removing reasoning efforts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-provider-compat-'))
    const settingsPath = join(root, 'settings.yaml')
    await writeFile(settingsPath, [
      'llm-pi-ai:',
      '  providers:',
      '    reasoning-provider:',
      '      api: openai-completions',
      '      baseURL: https://provider.example/v1',
      '      models:',
      '        - id: reasoning-model',
      '          reasoningEfforts:',
      '            off: null',
      '            high: high',
      '            max: max',
      '    regular-provider:',
      '      api: openai-completions',
      '      models:',
      '        - id: regular-model',
      '',
    ].join('\n'), 'utf8')

    const result = await repairOpenAiProviderCompatibility(settingsPath)

    expect(result).toEqual({ changed: true, providerIds: ['reasoning-provider'] })
    const settings = YAML.parse(await readFile(settingsPath, 'utf8')) as {
      'llm-pi-ai': { providers: Record<string, Record<string, any>> }
    }
    expect(settings['llm-pi-ai'].providers['reasoning-provider'].compat).toEqual({ supportsDeveloperRole: false })
    expect(settings['llm-pi-ai'].providers['reasoning-provider'].models[0].reasoningEfforts).toEqual({
      off: null,
      high: 'high',
      max: 'max',
    })
    expect(settings['llm-pi-ai'].providers['regular-provider'].compat).toBeUndefined()
  })

  it('is idempotent and changes an existing opt-in compatibility flag to false', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-provider-compat-idempotent-'))
    const settingsPath = join(root, 'settings.yaml')
    await writeFile(settingsPath, [
      'llm-pi-ai:',
      '  providers:',
      '    provider:',
      '      api: openai-completions',
      '      compat:',
      '        supportsDeveloperRole: true',
      '        supportsImages: true',
      '      models:',
      '        - id: reasoning-model',
      '          reasoningEfforts: { off: null, high: high }',
      '',
    ].join('\n'), 'utf8')

    const first = await repairOpenAiProviderCompatibility(settingsPath)
    const second = await repairOpenAiProviderCompatibility(settingsPath)

    expect(first).toEqual({ changed: true, providerIds: ['provider'] })
    expect(second).toEqual({ changed: false, providerIds: [] })
    const settings = YAML.parse(await readFile(settingsPath, 'utf8')) as {
      'llm-pi-ai': { providers: Record<string, Record<string, any>> }
    }
    expect(settings['llm-pi-ai'].providers.provider.compat).toEqual({
      supportsDeveloperRole: false,
      supportsImages: true,
    })
  })
})
