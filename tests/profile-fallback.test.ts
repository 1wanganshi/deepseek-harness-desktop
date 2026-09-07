import { access, lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { clearProfileFallbackLinks } from '../src/main/profile-fallback.js'

describe('profile fallback links', () => {
  it('removes managed symlinks without removing real profile directories', async () => {
    const root = join(tmpdir(), `dsh-profile-fallback-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const modules = join(root, 'profiles', 'node_modules', '@deepseek-ai')
    const target = join(root, 'installation', 'dsh-skill')
    const link = join(modules, 'dsh-skill')
    const realDirectory = join(modules, 'user-plugin')
    await mkdir(target, { recursive: true })
    await mkdir(realDirectory, { recursive: true })
    await symlink(target, link, 'junction')

    try {
      expect(await clearProfileFallbackLinks(join(root, 'profiles', 'node_modules'))).toBe(1)
      await expect(access(link)).rejects.toThrow()
      await expect(lstat(realDirectory)).resolves.toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
