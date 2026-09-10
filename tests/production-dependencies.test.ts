import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

describe('production DSH dependencies', () => {
  it('declares the runtime packages required by the official loader graph', async () => {
    const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }

    const required = [
      '@deepseek-ai/cordis',
      '@deepseek-ai/cordis-plugin-group',
      '@deepseek-ai/dsh',
      '@deepseek-ai/dsh-app-boot',
      '@deepseek-ai/dsh-atomic-write',
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-compaction-basic',
      '@deepseek-ai/dsh-fs-local',
      '@deepseek-ai/dsh-headless',
      '@deepseek-ai/dsh-home-paths',
      '@deepseek-ai/dsh-jobs-local',
      '@deepseek-ai/dsh-launch-environment',
      '@deepseek-ai/dsh-session-projection',
      '@deepseek-ai/dsh-session-reference',
      '@deepseek-ai/dsh-terminal',
      '@deepseek-ai/dsh-terminal-bash',
      '@deepseek-ai/dsh-tool-bash',
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-subagent',
      '@deepseek-ai/dsh-web-app',
      '@deepseek-ai/dsh-workflow-worker-thread',
    ]

    for (const packageName of required) {
      expect(manifest.dependencies[packageName], packageName).toBeDefined()
    }
  })

  it('pins the 0.1.5 runtime line used by the bundled Harness', async () => {
    const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }

    const runtime = Object.entries(manifest.dependencies)
      .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    expect(runtime.length).toBeGreaterThan(50)
    expect(runtime.every(([, version]) => version === '0.1.5-rc.1')).toBe(true)
  })
})
