import { describe, expect, it, vi } from 'vitest'
import { restartDesktop } from '../src/main/desktop-restart.js'

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
