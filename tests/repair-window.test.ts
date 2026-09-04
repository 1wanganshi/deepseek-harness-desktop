import { describe, expect, it } from 'vitest'
import { repairWindowOptions } from '../src/main/repair-window.js'
import { shouldAutoStartRepair } from '../src/renderer/repair-flow.js'

describe('repair window options', () => {
  it('creates a normal-sized child window independent of the Harness view', () => {
    expect(repairWindowOptions()).toMatchObject({
      width: 540,
      height: 650,
      minWidth: 480,
      minHeight: 560,
      title: 'DeepSeek Harness 维修',
      modal: false,
      show: false,
    })
  })
})

describe('repair window flow', () => {
  it('auto-starts only when the desktop opens a fresh repair session', () => {
    expect(shouldAutoStartRepair('?repair=1&auto=1')).toBe(true)
    expect(shouldAutoStartRepair('?repair=1')).toBe(false)
    expect(shouldAutoStartRepair('?diagnostics=1&auto=1')).toBe(false)
  })
})
