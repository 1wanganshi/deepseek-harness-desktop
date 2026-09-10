import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { repairVisionCapabilities } from '../src/main/vision-capability.js'

const roots: string[] = []

async function setup(settings: string, credentials?: string) {
  const root = await mkdtemp(join(tmpdir(), 'dhs-vision-'))
  roots.push(root)
  await writeFile(join(root, 'settings.yaml'), settings, 'utf8')
  if (credentials !== undefined) await writeFile(join(root, '.credentials.yaml'), credentials, 'utf8')
  return root
}

function settingsWith(models: Array<{ id: string, input?: string[] }>): string {
  const lines = [
    'llm-pi-ai:',
    '  providers:',
    '    demo:',
    '      displayName: Demo',
    '      api: openai-completions',
    '      baseURL: https://example.test/v1',
    '      apiKeyEnv: DEMO_API_KEY',
    '      models:',
  ]
  for (const model of models) {
    lines.push(`        - id: ${model.id}`)
    if (model.input !== undefined) {
      lines.push('          input:')
      for (const capability of model.input) lines.push(`            - ${capability}`)
    }
  }
  return `${lines.join('\n')}\n`
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('vision capability calibration', () => {
  it('adds image input for a model the provider confirmed accepts images', async () => {
    const root = await setup(settingsWith([{ id: 'has-vision', input: ['text'] }]))
    const result = await repairVisionCapabilities(root, {
      // A probe stub: the real implementation performs an image round-trip.
      probe: async () => ({ verdicts: new Map([['has-vision', true]]), explicitlyDenied: new Set<string>() }),
    })

    expect(result.changed).toBe(true)
    expect(result.added).toEqual(['demo/has-vision'])
    const written = await readFile(join(root, 'settings.yaml'), 'utf8')
    expect(written).toContain('image')
  })

  it('leaves a genuinely text-only model untouched when the image was dropped', async () => {
    const root = await setup(settingsWith([{ id: 'text-only', input: ['text'] }]))
    const result = await repairVisionCapabilities(root, {
      probe: async () => ({ verdicts: new Map([['text-only', false]]), explicitlyDenied: new Set<string>() }),
    })

    expect(result.changed).toBe(false)
    expect(result.added).toEqual([])
  })

  it('removes an image claim the provider explicitly rejects', async () => {
    const root = await setup(settingsWith([{ id: 'mislabelled', input: ['text', 'image'] }]))
    const result = await repairVisionCapabilities(root, {
      probe: async () => ({ verdicts: new Map(), explicitlyDenied: new Set(['mislabelled']) }),
    })

    expect(result.changed).toBe(true)
    expect(result.removed).toEqual(['demo/mislabelled'])
    const written = await readFile(join(root, 'settings.yaml'), 'utf8')
    expect(written).not.toContain('image')
  })

  it('never touches models that could not be reached', async () => {
    const root = await setup(settingsWith([{ id: 'unreachable', input: ['text'] }]))
    const result = await repairVisionCapabilities(root, {
      probe: async () => ({ verdicts: new Map(), explicitlyDenied: new Set<string>() }),
    })

    expect(result.changed).toBe(false)
    expect(result.undetermined).toEqual(['demo/unreachable'])
  })

  it('reuses cached verdicts instead of probing every launch', async () => {
    const root = await setup(settingsWith([{ id: 'cached-model', input: ['text'] }]))
    await writeFile(join(root, 'vision-probe-cache.json'), JSON.stringify({ 'cached-model': true }), 'utf8')

    let probeCalls = 0
    const result = await repairVisionCapabilities(root, {
      probe: async () => {
        probeCalls += 1
        return { verdicts: new Map(), explicitlyDenied: new Set<string>() }
      },
    })

    expect(probeCalls).toBe(0)
    expect(result.added).toEqual(['demo/cached-model'])
  })

  it('keeps every unrelated settings section intact', async () => {
    const root = await setup(`${settingsWith([{ id: 'vision-model', input: ['text'] }])}ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\n`)
    await repairVisionCapabilities(root, {
      probe: async () => ({ verdicts: new Map([['vision-model', true]]), explicitlyDenied: new Set<string>() }),
    })

    const written = await readFile(join(root, 'settings.yaml'), 'utf8')
    expect(written).toContain('welcomeNoticeVersion')
    expect(written).toContain('2026-08-13.1')
  })
})
