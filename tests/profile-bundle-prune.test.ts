import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pruneUnresolvableBundles } from '../src/main/profile-preparation.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function setupProfile(options: {
  bundles: string[]
  dependencies?: Record<string, string>
  installed?: string[]
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prune-bundles-'))
  roots.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: options.dependencies ?? {},
    dsh: { profile: { bundles: options.bundles, patchReload: 'live' } },
  }, null, 2), 'utf8')
  for (const name of options.installed ?? []) {
    const dir = join(root, 'node_modules', ...name.split('/'))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }), 'utf8')
  }
  return root
}

async function readManifest(root: string): Promise<{ dependencies: Record<string, string>; bundles: string[] }> {
  const parsed = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  return { dependencies: parsed.dependencies ?? {}, bundles: parsed.dsh?.profile?.bundles ?? [] }
}

/**
 * A plugin installer that copies a package into `.vendor/` and adds its manifest
 * entry, then fails at `pnpm install` (for example when `pnpm` is not on PATH),
 * leaves a bundle name that resolves nowhere. DSH aborts the entire boot on that
 * one name, so the app could never start again — this is the half-installed
 * state that has to degrade to "plugin disabled" instead.
 */
describe('pruneUnresolvableBundles', () => {
  it('removes a bundle whose package is not installed, and keeps it resolvable afterwards', async () => {
    const root = await setupProfile({
      bundles: ['@deepseek-ai/dsh-base', 'dsh-internet-positioning'],
      dependencies: { 'dsh-internet-positioning': 'file:./.vendor/dsh-internet-positioning' },
      installed: ['@deepseek-ai/dsh-base'],
    })

    const result = await pruneUnresolvableBundles(root)

    expect(result.changed).toBe(true)
    expect(result.pruned).toEqual(['dsh-internet-positioning'])
    const manifest = await readManifest(root)
    expect(manifest.bundles).toEqual(['@deepseek-ai/dsh-base'])
    // A `file:` dependency whose directory is gone also breaks pnpm install
    // outright (ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND), so it must go too.
    expect(manifest.dependencies['dsh-internet-positioning']).toBeUndefined()
  })

  it('keeps a resolvable third-party bundle untouched', async () => {
    const root = await setupProfile({
      bundles: ['@deepseek-ai/dsh-base', 'dsh-champion-brain'],
      installed: ['@deepseek-ai/dsh-base', 'dsh-champion-brain'],
    })

    const result = await pruneUnresolvableBundles(root)

    expect(result.changed).toBe(false)
    expect(result.pruned).toEqual([])
    expect((await readManifest(root)).bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-champion-brain'])
  })

  it('never prunes official bundles, which resolve from the DSH installation', async () => {
    const root = await setupProfile({
      // No profile directory exists for the official bundles, yet they are the
      // core of the app and must survive.
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      installed: [],
    })

    const result = await pruneUnresolvableBundles(root)

    expect(result.changed).toBe(false)
    expect((await readManifest(root)).bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  })

  it('keeps a versioned dependency spec so a later install can restore the bundle', async () => {
    const root = await setupProfile({
      bundles: ['dsh-vision-router'],
      dependencies: { 'dsh-vision-router': '^2.2.0' },
      installed: [],
    })

    await pruneUnresolvableBundles(root)

    const manifest = await readManifest(root)
    expect(manifest.bundles).toEqual([])
    // A registry spec is not broken by the missing directory; the next install
    // can still resolve it, so dropping it would lose the user's declaration.
    expect(manifest.dependencies['dsh-vision-router']).toBe('^2.2.0')
  })
})
