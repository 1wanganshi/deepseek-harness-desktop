import { access, lstat, mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { clearProfileFallbackLinks } from '../src/main/profile-fallback.js'

describe('profile fallback links', () => {
  it('keeps links whose target still exists', async () => {
    const root = join(tmpdir(), `dsh-profile-fallback-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const modules = join(root, 'profiles', 'node_modules', '@deepseek-ai')
    const target = join(root, 'installation', 'dsh-skill')
    const link = join(modules, 'dsh-skill')
    const realDirectory = join(modules, 'user-plugin')
    await mkdir(target, { recursive: true })
    await mkdir(realDirectory, { recursive: true })
    await symlink(target, link, 'junction')

    try {
      // The runtime builds this map on boot and depends on it; only broken
      // links may be swept, otherwise the Harness loses its own packages and
      // the desktop shell restarts it in a loop.
      expect(await clearProfileFallbackLinks(join(root, 'profiles', 'node_modules'))).toBe(0)
      await expect(access(link)).resolves.toBeUndefined()
      await expect(lstat(realDirectory)).resolves.toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes a link whose target no longer exists', async () => {
    const root = join(tmpdir(), `dsh-profile-fallback-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const modules = join(root, 'profiles', 'node_modules', '@deepseek-ai')
    const link = join(modules, 'dsh-removed')
    await mkdir(modules, { recursive: true })
    await symlink(join(root, 'installation', 'dsh-removed'), link, 'junction')

    try {
      expect(await clearProfileFallbackLinks(join(root, 'profiles', 'node_modules'))).toBe(1)
      await expect(access(link)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
