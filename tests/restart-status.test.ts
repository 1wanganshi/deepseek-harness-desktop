import { describe, expect, it } from 'vitest'
import { restartNotice } from '../src/shared/restart-status.js'

describe('restart status copy', () => {
  it('explains that restart was cancelled because a session has not finished saving', () => {
    expect(restartNotice({
      restarted: false,
      report: {
        safe: false,
        checkedSessionIds: ['11111111-1111-4111-8111-111111111111'],
        repairedSessionIds: [],
        blockers: [{ sessionId: '11111111-1111-4111-8111-111111111111', reason: 'missing-index' }],
        backupPath: null,
      },
    })).toContain('会话尚未完整保存，已取消重启')
  })

  it('does not confuse an explicit user cancellation with a storage blocker', () => {
    expect(restartNotice({ restarted: false, report: null })).toBe('已取消重启')
  })
})
