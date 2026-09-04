import { describe, expect, it, vi } from 'vitest'
import { buildDesktopRelaunchOptions, buildRestartHelperArgs, restartDesktop, shouldProceedWithDesktopRestart } from '../src/main/desktop-restart.js'

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
  it('relaunches and exits after stopping the runtime', async () => {
    const events: string[] = []
    await restartDesktop({
      stop: async () => { events.push('stop') },
      relaunch: () => { events.push('relaunch') },
      exit: code => { events.push(`exit:${code}`) },
    })
    expect(events).toEqual(['stop', 'relaunch', 'exit:0'])
  })

  it('still relaunches when runtime shutdown fails', async () => {
    const relaunch = vi.fn()
    const exit = vi.fn()
    await restartDesktop({
      stop: async () => { throw new Error('shutdown failed') },
      relaunch,
      exit,
    })
    expect(relaunch).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('does not wait forever for a stuck runtime process', async () => {
    const relaunch = vi.fn()
    const exit = vi.fn()
    await restartDesktop({
      stop: () => new Promise<void>(() => undefined),
      relaunch,
      exit,
      stopTimeoutMs: 1,
    })
    expect(relaunch).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(0)
  })
})
