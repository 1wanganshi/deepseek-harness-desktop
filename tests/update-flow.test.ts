import { describe, expect, it } from 'vitest'
import { getUpdateDialogKind } from '../src/renderer/update-flow.js'

describe('update dialog flow', () => {
  it('distinguishes checking, available, latest, and failed checks', () => {
    expect(getUpdateDialogKind(null)).toBe('checking')
    expect(getUpdateDialogKind({ currentVersion: '0.2.2', latestVersion: '0.2.3', updateAvailable: true, checkedAt: new Date().toISOString(), error: null })).toBe('available')
    expect(getUpdateDialogKind({ currentVersion: '0.2.2', latestVersion: '0.2.2', updateAvailable: false, checkedAt: new Date().toISOString(), error: null })).toBe('latest')
    expect(getUpdateDialogKind({ currentVersion: '0.2.2', latestVersion: null, updateAvailable: false, checkedAt: new Date().toISOString(), error: '网络不可用' })).toBe('error')
  })
})
