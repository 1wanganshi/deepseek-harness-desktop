import { describe, expect, it, vi } from 'vitest'
import { createHarnessMountRecovery, evaluateHarnessMount } from '../src/main/harness-mount-recovery.js'

const url = 'http://127.0.0.1:3080/'

/** A manually pumped timer so the tests never wait on wall-clock time. */
function createTimers() {
  const queued: Array<() => void> = []
  return {
    setTimeoutImpl: (callback: () => void) => {
      queued.push(callback)
      return queued.length
    },
    flush() {
      for (const callback of queued.splice(0)) callback()
    },
  }
}

function createRecovery(overrides: Partial<Parameters<typeof createHarnessMountRecovery>[0]> = {}) {
  const reload = vi.fn<(target: string) => void>()
  const onAbandoned = vi.fn<(reason: string) => void>()
  const timers = createTimers()
  const recovery = createHarnessMountRecovery({
    maxAttempts: 2,
    retryDelayMs: 700,
    setTimeoutImpl: timers.setTimeoutImpl,
    getCurrentUrl: () => url,
    reload,
    onAbandoned,
    ...overrides,
  })
  return { recovery, reload, onAbandoned, timers }
}

describe('harness mount verdict', () => {
  it('only treats the runtime boot flag as a successful mount', () => {
    // The static chrome is painted before a long transcript is replayed, so the
    // document having text proves nothing.
    expect(evaluateHarnessMount({ bodyText: '探索未至之境 选择工作区', rootChildren: 4 })).toEqual({
      state: 'pending',
      reason: expect.any(String),
    })
    expect(evaluateHarnessMount({ bootReady: true, bodyText: '' })).toEqual({ state: 'mounted' })
  })

  it('reports an explicit plugin failure ahead of the boot flag', () => {
    const verdict = evaluateHarnessMount({ bodyText: 'Failed to load plugins: preset "x"', bootReady: true })
    expect(verdict.state).toBe('plugin-failure')
  })
})

describe('harness mount recovery', () => {
  it('spends the budget on distinct loads, not on repeated probes of one load', () => {
    const { recovery, reload, timers } = createRecovery()

    // Every `did-finish-load` probe of the same stuck load must not consume a
    // second slot: the ceiling then becomes unreachable, which is exactly the
    // reload loop the user saw while typing in a long session.
    recovery.schedule('页面加载完成但未挂载', url)
    recovery.schedule('页面加载完成但未挂载', url)
    recovery.schedule('页面加载完成但未挂载', url)

    expect(recovery.attemptCount()).toBe(1)
    expect(recovery.abandoned()).toBe(false)

    timers.flush()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('abandons the page after the retry budget and never reloads again', () => {
    const { recovery, reload, onAbandoned, timers } = createRecovery()

    recovery.schedule('第一次未挂载', url)
    timers.flush()
    recovery.schedule('第二次未挂载', url)
    timers.flush()
    expect(recovery.attemptCount()).toBe(2)
    expect(reload).toHaveBeenCalledTimes(2)

    recovery.schedule('第三次未挂载', url)

    expect(recovery.abandoned()).toBe(true)
    expect(onAbandoned).toHaveBeenCalledWith('第三次未挂载')
    // The page is left exactly as it is: the user keeps a usable window.
    expect(reload).toHaveBeenCalledTimes(2)
    timers.flush()
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('clears the streak only when the page is observably mounted', () => {
    const { recovery, reload, timers } = createRecovery()

    recovery.schedule('未挂载', url)
    timers.flush()
    expect(recovery.attemptCount()).toBe(1)

    recovery.markMounted()
    expect(recovery.attemptCount()).toBe(0)

    // Since the streak is clear, a later failure gets the full budget again.
    recovery.schedule('换了 URL 之后又没挂上', url)
    expect(recovery.attemptCount()).toBe(1)
    timers.flush()
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('ignores a queued retry once the runtime URL has changed', () => {
    let currentUrl: string | null = url
    const { recovery, reload, timers } = createRecovery({ getCurrentUrl: () => currentUrl })

    recovery.schedule('未挂载', url)
    currentUrl = 'http://127.0.0.1:3099/'
    timers.flush()

    expect(reload).not.toHaveBeenCalled()
  })
})
