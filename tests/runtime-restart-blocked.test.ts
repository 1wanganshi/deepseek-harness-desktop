import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeController, RuntimeRestartBudget } from '../src/main/runtime-controller.js'
import type { RuntimeState } from '../src/shared/types.js'

const roots: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A runtime root complete enough for `boot()` to reach `spawn`. */
async function setupRuntimeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dhs-runtime-restart-'))
  roots.push(root)
  const bin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'bin.js'), '// stub\n', 'utf8')
  return root
}

describe('runtime restart budget', () => {
  it('stops auto-restarting and reports an error once the budget latches', async () => {
    const root = await setupRuntimeRoot()
    const children: Array<ReturnType<typeof createStubChild>> = []
    const states: RuntimeState[] = []
    const blocked: string[] = []
    let now = 0

    const controller = new RuntimeController({
      resolveRuntime: async () => ({ root, version: '0.1.5-rc.2', source: 'bundled' }) as never,
      dshHome: root,
      log: () => undefined,
      // A Harness that answers nothing has proven nothing, so every boot fails
      // at the post-start probe and the controller recovers.
      fetchImpl: async () => ({ ok: false, status: 500 }) as never,
      sleep: async () => undefined,
      restartBudget: new RuntimeRestartBudget({ now: () => now, maxConsecutiveFailures: 3 }),
      onState: state => { states.push(state) },
      onRestartBlocked: reason => { blocked.push(reason) },
      spawnImpl: (() => {
        // Every launch dies within seconds of starting. That is the signature of
        // a long session that kills the Harness while it replays: the runtime
        // comes up, is probed, and is dead again before it is ever stable.
        now += 20_000
        const child = createStubChild()
        children.push(child)
        // The runtime dies the instant it is launched: the signature of a
        // session that kills the Harness on load.
        queueMicrotask(() => {
          child.exitCode = 1
          child.emit('exit', 1, null)
        })
        return child
      }) as never,
    })

    await controller.start().catch(() => undefined)
    // The recovery delay is zero and every stub child exits on a microtask, so
    // the recovery cascade is a chain of resolved promises. Each link still
    // needs a macrotask turn to settle (`sleep(delay).then(...)` plus the
    // serialized lifecycle queue), so drain both queues until the budget latches.
    for (let tick = 0; tick < 200; tick += 1) {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    expect(blocked.length).toBeGreaterThan(0)
    expect(blocked.at(-1)).toContain('3 次')
    expect(states.at(-1)).toMatchObject({ status: 'error', restartPaused: true })
    // The ceiling is the point: the shell must stop spawning children rather
    // than rebooting the runtime forever.
    expect(children.length).toBeLessThanOrEqual(4)
  })
})

function createStubChild() {
  return Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    killed: false,
    pid: 1234,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  })
}
