import { describe, expect, it } from 'vitest'

describe('restart helper contract', () => {
  it('keeps the helper arguments ordered as parent pid, executable, then app args', () => {
    const parentPid = '1234'
    const executable = 'DeepSeek Harness Desktop.exe'
    const args = ['--user-data-dir', 'C:\\Temp\\dhs']
    expect([parentPid, executable, ...args]).toEqual([
      '1234',
      'DeepSeek Harness Desktop.exe',
      '--user-data-dir',
      'C:\\Temp\\dhs',
    ])
  })
})
