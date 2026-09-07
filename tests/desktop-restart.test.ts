import { describe, expect, it, vi } from 'vitest'
import { buildDesktopRelaunchOptions, buildRestartHelperArgs, restartDesktop, shutdownDesktop, shouldProceedWithDesktopRestart } from '../src/main/desktop-restart.js'
import type { SessionDurabilityReport } from '../src/main/session-durability.js'

const incompleteSessionReport: SessionDurabilityReport = {
  safe: false,
  checkedSessionIds: ['11111111-1111-4111-8111-111111111111'],
  repairedSessionIds: [],
  blockers: [{ sessionId: '11111111-1111-4111-8111-111111111111', reason: 'missing-index' }],
  backupPath: null,
}

describe('desktop restart confirmation', () => {
  it('only proceeds for the explicit confirm button', () => {
    expect(shouldProceedWithDesktopRestart(1)).toBe(true)
    expect(shouldProceedWithDesktopRestart(0)).toBe(false)
    expect(shouldProceedWithDesktopRestart(-1)).toBe(false)
  })
})

describe('desktop relaunch options', () => {
  it('preserves the current executable and startup arguments', () => {
    expect(buildDesktopRelaunchOptions('C:/DHS/Desktop.exe', [
      'C:/DHS/Desktop.exe',
      '--user-data-dir',
      'D:/DHS/.test-user-data',
    ])).toEqual({
      execPath: 'C:/DHS/Desktop.exe',
      args: ['--user-data-dir', 'D:/DHS/.test-user-data'],
    })
  })

  it('builds helper arguments that wait for this process before relaunching', () => {
    expect(buildRestartHelperArgs('C:/DHS/restart-helper.js', 4321, 'C:/DHS/Desktop.exe', [
      'C:/DHS/Desktop.exe',
      '--user-data-dir',
      'D:/DHS/.test-user-data',
    ])).toEqual([
      'C:/DHS/restart-helper.js',
      '4321',
      'C:/DHS/Desktop.exe',
      '--user-data-dir',
      'D:/DHS/.test-user-data',
    ])
  })
})

describe('desktop restart', () => {
  it('keeps the desktop and Harness running when a new session is incomplete', async () => {
    const stop = vi.fn(async () => undefined)
    const relaunch = vi.fn()
    const exit = vi.fn()

    const result = await restartDesktop({
      verifyBeforeStop: async () => incompleteSessionReport,
      stop,
      relaunch,
      exit,
    })

    expect(result).toEqual({ restarted: false, report: incompleteSessionReport })
    expect(stop).not.toHaveBeenCalled()
    expect(relaunch).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('relaunches and exits after stopping the runtime', async () => {
    const events: string[] = []
    await restartDesktop({
      stop: async () => { events.push('stop') },
      relaunch: () => { events.push('relaunch') },
      exit: code => { events.push(`exit:${code}`) },
    })
    expect(events).toEqual(['stop', 'relaunch', 'exit:0'])
  })

  it('keeps the desktop open when runtime shutdown fails', async () => {
    const relaunch = vi.fn()
    const exit = vi.fn()
    await restartDesktop({
      stop: async () => { throw new Error('shutdown failed') },
      relaunch,
      exit,
    })
    expect(relaunch).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('does not relaunch when the runtime cannot stop in time', async () => {
    const relaunch = vi.fn()
    const exit = vi.fn()
    await restartDesktop({
      stop: () => new Promise<void>(() => undefined),
      relaunch,
      exit,
      stopTimeoutMs: 1,
    })
    expect(relaunch).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })
})

describe('desktop shutdown durability', () => {
  it('checks session durability again after the Harness has stopped', async () => {
    const events: string[] = []
    const result = await shutdownDesktop({
      verifyBeforeStop: async () => {
        events.push('verify-before')
        return { ...incompleteSessionReport, safe: true, blockers: [] }
      },
      stop: async () => { events.push('stop') },
      verifyAfterStop: async () => {
        events.push('verify-after')
        return { ...incompleteSessionReport, safe: true, blockers: [] }
      },
      resumeAfterBlockedStop: async () => { events.push('resume') },
    })

    expect(result.stopped).toBe(true)
    expect(events).toEqual(['verify-before', 'stop', 'verify-after'])
  })

  it('cancels exit and resumes Harness when data is incomplete after shutdown', async () => {
    const events: string[] = []
    const result = await shutdownDesktop({
      verifyBeforeStop: async () => ({ ...incompleteSessionReport, safe: true, blockers: [] }),
      stop: async () => { events.push('stop') },
      verifyAfterStop: async () => incompleteSessionReport,
      resumeAfterBlockedStop: async () => { events.push('resume') },
    })

    expect(result).toEqual({ stopped: false, report: incompleteSessionReport })
    expect(events).toEqual(['stop', 'resume'])
  })
})
