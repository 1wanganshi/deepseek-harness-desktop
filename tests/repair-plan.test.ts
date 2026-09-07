import { describe, expect, it } from 'vitest'
import { REPAIR_PLAN } from '../src/shared/repair-plan.js'
import { updateBadgeLabel } from '../src/renderer/status-copy.js'

describe('repair plan', () => {
  it('contains executable checks for dependencies, locks, profile, data, and runtime', () => {
    expect(REPAIR_PLAN.map(step => step.id)).toEqual([
      'deps',
      'locks',
      'profile',
      'provider-compatibility',
      'sessions',
      'data',
      'runtime',
    ])
    expect(new Set(REPAIR_PLAN.map(step => step.id)).size).toBe(REPAIR_PLAN.length)
    expect(REPAIR_PLAN.every(step => step.label.length > 0 && step.description.length > 0 && step.repairMethod.length > 0)).toBe(true)
  })
})

describe('update badge', () => {
  it('only exposes whether an update is available', () => {
    expect(updateBadgeLabel(null)).toBe('检查更新中')
    expect(updateBadgeLabel({ currentVersion: '0.2.2', latestVersion: null, updateAvailable: false, checkedAt: null, error: null })).toBe('已是最新')
    expect(updateBadgeLabel({ currentVersion: '0.2.2', latestVersion: '0.2.3', updateAvailable: true, checkedAt: new Date().toISOString(), error: null })).toBe('有更新')
  })
})
