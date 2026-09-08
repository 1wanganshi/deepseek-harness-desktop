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
      '@deepseek-ai/cordis-plugin-group',
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-session-query',
      '@deepseek-ai/dsh-session-query-sqlite',
      '@deepseek-ai/dsh-attachment',
      '@deepseek-ai/dsh-code-runtime',
      '@deepseek-ai/dsh-compaction',
      '@deepseek-ai/dsh-anonymous-user-id',
      '@deepseek-ai/dsh-atomic-write',
      '@deepseek-ai/dsh-fs',
      '@deepseek-ai/dsh-invariants',
      '@deepseek-ai/dsh-llm-deepseek',
      '@deepseek-ai/dsh-output-retention',
      '@deepseek-ai/dsh-sandbox',
      '@deepseek-ai/dsh-scope',
      '@deepseek-ai/dsh-session-persistence',
      '@deepseek-ai/dsh-session-telemetry',
      '@deepseek-ai/dsh-session-title-llm',
      '@deepseek-ai/dsh-shell',
      '@deepseek-ai/dsh-spill',
      '@deepseek-ai/dsh-subagent-in-process-driver',
      '@deepseek-ai/dsh-timeout',
      '@deepseek-ai/dsh-util-time',
      '@deepseek-ai/dsh-workflow',
      '@deepseek-ai/dsh-workflow-worker-thread',
    ]

    for (const packageName of required) {
      expect(manifest.dependencies[packageName], packageName).toBeDefined()
    }
  })

  it('pins the session-query contract used by the history controller', async () => {
    const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }

    expect(manifest.dependencies['@deepseek-ai/dsh-session-query']).toBe('0.1.2-rc.1')
    expect(manifest.dependencies['@deepseek-ai/dsh-session-query-sqlite']).toBe('0.1.2-rc.1')
    expect(manifest.dependencies['@deepseek-ai/dsh-session-persistence']).toBe('0.1.2-rc.1')
  })
})
