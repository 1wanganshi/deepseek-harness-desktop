import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

describe('Windows desktop distribution metadata', () => {
  it('identifies a real installable app and creates user entry points', async () => {
    const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
      version: string
      packageManager: string
      dependencies: Record<string, string>
      build: {
        appId: string
        productName: string
        win: { icon: string; target: string[] }
        nsis: {
          createDesktopShortcut: boolean
          createStartMenuShortcut: boolean
          perMachine: boolean
        }
        directories: { output: string }
        files: string[]
      extraResources: Array<{ from: string; to: string }>
      }
    }

    expect(manifest.version).toBe('0.2.24')
    expect(manifest.packageManager).toBe('pnpm@11.24.0')
    expect(manifest.dependencies.pnpm).toBe('11.24.0')
    expect(manifest.dependencies.npm).toBe('11.16.0')
    expect(Object.entries(manifest.dependencies)
      .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
      .every(([, version]) => version === '0.1.2-rc.1')).toBe(true)
    const rendererSource = await readFile(join(projectRoot, 'src', 'renderer', 'main.tsx'), 'utf8')
    expect(rendererSource).toContain("version: '0.1.2-rc.1'")
    expect(rendererSource).toContain("desktopVersion: '0.2.23'")
    const workspaceConfig = await readFile(join(projectRoot, 'pnpm-workspace.yaml'), 'utf8')
    expect(workspaceConfig).toContain('use-sync-external-store: 1.6.0')
    expect(manifest.build.appId).toBe('com.deepseek.harness.desktop')
    expect(manifest.build.productName).toBe('DeepSeek Harness Desktop')
    expect(manifest.build.win.icon).toBe('resources/icon.ico')
    expect(manifest.build.win.target).toContain('nsis')
    expect(manifest.build.nsis.createDesktopShortcut).toBe(true)
    expect(manifest.build.nsis.createStartMenuShortcut).toBe(true)
    expect(manifest.build.nsis.perMachine).toBe(true)
    expect(manifest.build.extraResources).toContainEqual({ from: 'resources/icon.ico', to: 'icon.ico' })
    expect(manifest.build.extraResources).toContainEqual(expect.objectContaining({ from: 'resources/npm', to: 'npm' }))
    expect(manifest.build.extraResources).toContainEqual({
      from: 'resources/npm-deps',
      to: 'npm-deps',
      filter: ['**/*'],
    })
    expect(manifest.build.directories.output).toBe('release')
    expect(manifest.build.files).toContain('dist-renderer/**')
  })
})
