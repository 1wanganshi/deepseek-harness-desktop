import { describe, expect, it } from 'vitest'
import type { RuntimeState } from '../src/shared/types.js'
import { placeholderMessage, placeholderTitle, shouldShowPlaceholder, shouldShowStatusLauncher } from '../src/renderer/status-copy.js'

function state(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    status: 'running',
    version: '0.1.5-rc.2',
    port: 3080,
    url: 'http://127.0.0.1:3080/',
    recoveryAttempt: 0,
    lastError: null,
    lastHealthyAt: null,
    restartPaused: false,
    harnessAttention: false,
    ...overrides,
  }
}

describe('runtime placeholder takeover', () => {
  it('never covers a running or recovering runtime', () => {
    expect(shouldShowPlaceholder(state({ status: 'running' }))).toBe(false)
    // A transient recovery must not be amplified into "the app restarted": the
    // official page stays exactly where it is.
    expect(shouldShowPlaceholder(state({ status: 'recovering', recoveryAttempt: 2 }))).toBe(false)
  })

  it('takes over once the runtime cannot come back on its own', () => {
    expect(shouldShowPlaceholder(state({ status: 'error', restartPaused: true }))).toBe(true)
    expect(shouldShowPlaceholder(state({ status: 'stopped' }))).toBe(true)
  })

  it('keeps the page during a silent boot but covers it when the user is waiting', () => {
    expect(shouldShowPlaceholder(state({ status: 'starting', harnessAttention: false }))).toBe(false)
    expect(shouldShowPlaceholder(state({ status: 'starting', harnessAttention: true }))).toBe(true)
  })
})

describe('status launcher', () => {
  it('is the only status surface while the bar is collapsed', () => {
    expect(shouldShowStatusLauncher(state(), false)).toBe(true)
  })

  it('appears over an expanded bar only when the runtime needs attention', () => {
    expect(shouldShowStatusLauncher(state(), true)).toBe(false)
    expect(shouldShowStatusLauncher(state({ status: 'error', harnessAttention: true }), true)).toBe(true)
  })
})

describe('placeholder copy', () => {
  it('names the paused state instead of promising a retry that will not happen', () => {
    const paused = state({ status: 'error', restartPaused: true })
    expect(placeholderTitle(paused)).toBe('需要诊断')
    expect(placeholderMessage(paused)).toContain('自动重试已暂停')
    expect(placeholderMessage(paused)).toContain('维修')
  })

  it('says nothing about a paused retry while the shell is still trying', () => {
    const retrying = state({ status: 'error', restartPaused: false })
    expect(placeholderTitle(retrying)).toBe('运行时未启动')
    expect(placeholderMessage(retrying)).not.toContain('自动重试已暂停')
  })

  it('reassures that local data survives a stopped runtime', () => {
    const stopped = state({ status: 'stopped' })
    expect(placeholderTitle(stopped)).toBe('运行时已停止')
    expect(placeholderMessage(stopped)).toContain('会话')
  })
})
