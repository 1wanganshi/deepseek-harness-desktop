import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

describe('Windows desktop distribution metadata', () => {
  it('identifies a real installable app and creates user entry points', async () => {
    const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
      version: string
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

    expect(manifest.version).toBe('0.2.3')
    expect(manifest.build.appId).toBe('com.deepseek.harness.desktop')
    expect(manifest.build.productName).toBe('DeepSeek Harness Desktop')
    expect(manifest.build.win.icon).toBe('resources/icon.ico')
    expect(manifest.build.win.target).toContain('nsis')
    expect(manifest.build.nsis.createDesktopShortcut).toBe(true)
    expect(manifest.build.nsis.createStartMenuShortcut).toBe(true)
    expect(manifest.build.nsis.perMachine).toBe(true)
    expect(manifest.build.extraResources).toContainEqual({ from: 'resources/icon.ico', to: 'icon.ico' })
    expect(manifest.build.directories.output).toBe('release')
    expect(manifest.build.files).toContain('dist-renderer/**')
  })
})
