import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeController } from '../src/main/runtime-controller.js'
import type { RuntimeState } from '../src/shared/types.js'

const roots: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function setupRuntimeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dhs-heartbeat-busy-'))
  roots.push(root)
  const bin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'bin.js'), '// stub\n', 'utf8')
  return root
}

function createStubChild() {
  return Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    killed: false,
    pid: 4242,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  })
}

type HeartbeatInternals = {
  child: ReturnType<typeof createStubChild> | null
  state: RuntimeState
  fetchImpl: typeof fetch
  checkHeartbeat: (port: number) => Promise<void>
}

/**
 * The Harness is single-threaded: while it replays a multi-megabyte transcript
 * it cannot answer `/` at all. The shell must treat that as "busy", never as
 * "dead" — the old 2s heartbeat timeout killed a healthy runtime the moment a
 * user sent a message to a long conversation, and the restarted runtime had
 * already lost the conversation, so the app appeared to reboot on every message.
 */
describe('heartbeat tolerance for a busy runtime', () => {
  it('keeps the child alive while its probes time out but it has not exited', async () => {
    const root = await setupRuntimeRoot()
    const states: RuntimeState[] = []
    const controller = new RuntimeController({
      resolveRuntime: async () => ({ root, version: '0.1.5-rc.2', source: 'bundled' }) as never,
      dshHome: root,
      log: () => undefined,
      heartbeatIntervalMs: 0,
      heartbeatFailureLimit: 3,
      onState: state => { states.push(state) },
    })

    const internals = controller as unknown as HeartbeatInternals
    const child = createStubChild()
    internals.child = child
    internals.state.status = 'running'
    // Every probe times out, exactly as it would while the runtime grinds
    // through a long transcript. The child never exits.
    internals.fetchImpl = (async () => {
      throw new Error('The operation was aborted due to timeout')
    }) as never

    for (let tick = 0; tick < 12; tick += 1) await internals.checkHeartbeat(12345)

    // Still the same child: never killed, never replaced, never "recovering".
    expect(child.kill).not.toHaveBeenCalled()
    expect(internals.child).toBe(child)
    expect(states.some(state => state.status === 'recovering')).toBe(false)
  })

  it('restarts once the child has actually exited', async () => {
    const root = await setupRuntimeRoot()
    const states: RuntimeState[] = []
    const controller = new RuntimeController({
      resolveRuntime: async () => ({ root, version: '0.1.5-rc.2', source: 'bundled' }) as never,
      dshHome: root,
      log: () => undefined,
      heartbeatIntervalMs: 0,
      heartbeatFailureLimit: 3,
      onState: state => { states.push(state) },
    })

    const internals = controller as unknown as HeartbeatInternals
    const child = createStubChild()
    internals.child = child
    internals.state.status = 'running'
    // A dead child: probes time out AND the process is gone.
    child.exitCode = 1
    internals.fetchImpl = (async () => {
      throw new Error('The operation was aborted due to timeout')
    }) as never

    for (let tick = 0; tick < 12; tick += 1) await internals.checkHeartbeat(12345)

    // The liveness check must not shield a genuinely dead runtime.
    expect(internals.child).not.toBe(child)
  })
})
