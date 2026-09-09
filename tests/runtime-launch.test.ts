import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import * as runtimeController from '../src/main/runtime-controller.js'

const { buildDshLaunchArgs, createSerializedOperationQueue, isHealthyHarnessResponse, isUsableBareRootResponse, parseAdvertisedUrl, waitForChildExit } = runtimeController

describe('official DSH launch', () => {
  it('terminates the complete Windows runtime tree before its parent can exit', async () => {
    const calls: Array<{ command: string; args: string[]; windowsHide: boolean | undefined }> = []
    expect(runtimeController).toHaveProperty('terminateWindowsRuntimeTree')
    const { terminateWindowsRuntimeTree } = runtimeController as unknown as {
      terminateWindowsRuntimeTree: (pid: number, execFileImpl: unknown) => Promise<void>
    }

    await terminateWindowsRuntimeTree(4321, ((command: string, args: string[], options: { windowsHide?: boolean }, callback: () => void) => {
      calls.push({ command, args, windowsHide: options.windowsHide })
      callback()
    }) as never)

    expect(calls).toEqual([{
      command: 'taskkill',
      args: ['/pid', '4321', '/T', '/F'],
      windowsHide: true,
    }])
  })

  it('signals the whole POSIX process group by negative PID', () => {
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const { terminatePosixRuntimeGroup } = runtimeController as unknown as {
      terminatePosixRuntimeGroup: (pid: number, signal?: NodeJS.Signals, killImpl?: unknown) => void
    }

    terminatePosixRuntimeGroup(4321, 'SIGTERM', ((pid: number, signal: NodeJS.Signals) => {
      calls.push({ pid, signal })
    }) as never)
    terminatePosixRuntimeGroup(4321, 'SIGKILL', ((pid: number, signal: NodeJS.Signals) => {
      calls.push({ pid, signal })
    }) as never)

    expect(calls).toEqual([
      { pid: -4321, signal: 'SIGTERM' },
      { pid: -4321, signal: 'SIGKILL' },
    ])
  })

  it('ignores an already-gone POSIX process group', () => {
    const { terminatePosixRuntimeGroup } = runtimeController as unknown as {
      terminatePosixRuntimeGroup: (pid: number, signal?: NodeJS.Signals, killImpl?: unknown) => void
    }

    expect(() => terminatePosixRuntimeGroup(4321, 'SIGTERM', (() => {
      throw new Error('ESRCH')
    }) as never)).not.toThrow()
  })

  it('observes a graceful child exit before forced termination is considered', async () => {
    const child = Object.assign(new EventEmitter(), { exitCode: null })
    const waiting = waitForChildExit(child as never, 100)
    child.emit('exit', 0, null)

    await expect(waiting).resolves.toBe(true)
  })

  it('enables Node internals required by the official HMR plugin', () => {
    expect(buildDshLaunchArgs('C:/runtime/bin.js', 34567)).toEqual([
      '--expose-internals',
      'C:/runtime/bin.js',
      'web',
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      '34567',
    ])
  })

  it('extracts the authenticated local URL printed by newer DHS releases', () => {
    expect(parseAdvertisedUrl('dsh web: http://127.0.0.1:34567/?token=AbC_123-xY', 34567))
      .toBe('http://127.0.0.1:34567/?token=AbC_123-xY')
  })

  it('does not accept a bare unauthenticated URL as the advertised URL', () => {
    expect(parseAdvertisedUrl('dsh web: http://127.0.0.1:34567/', 34567)).toBeNull()
  })

  it('treats the DHS authentication redirect as a live runtime heartbeat', () => {
    expect(isHealthyHarnessResponse({ ok: false, status: 303 })).toBe(true)
  })

  it('treats an unauthenticated local root response as a live runtime heartbeat', () => {
    expect(isHealthyHarnessResponse({ ok: false, status: 401 })).toBe(true)
  })

  it('does not treat an oversized-cookie response as a healthy runtime', () => {
    expect(isHealthyHarnessResponse({ ok: false, status: 431 })).toBe(false)
  })

  it('accepts a bare root only when the runtime serves a complete document', () => {
    expect(isUsableBareRootResponse({ ok: true, status: 200 })).toBe(true)
    expect(isUsableBareRootResponse({ ok: false, status: 401 })).toBe(false)
    expect(isUsableBareRootResponse({ ok: false, status: 303 })).toBe(false)
  })

  it('serializes overlapping runtime lifecycle operations', async () => {
    expect(runtimeController).toHaveProperty('createSerializedOperationQueue')
    const queue = (createSerializedOperationQueue as () => <T>(operation: () => Promise<T>) => Promise<T>)()
    const events: string[] = []
    let releaseFirst!: () => void
    const first = queue(async () => {
      events.push('first:start')
      await new Promise<void>(resolve => { releaseFirst = resolve })
      events.push('first:end')
    })
    const second = queue(async () => {
      events.push('second:start')
      events.push('second:end')
    })

    await Promise.resolve()
    expect(events).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })
})
