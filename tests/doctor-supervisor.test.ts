import { describe, expect, it } from 'vitest'
import { removeLegacyDoctorSupervisor } from '../src/main/doctor-supervisor.js'

describe('legacy doctor supervisor cleanup', () => {
  it('unregisters the known Windows login task before the desktop starts DHS', async () => {
    const calls: Array<{ command: string; args: string[]; windowsHide: boolean | undefined }> = []

    const removed = await removeLegacyDoctorSupervisor('win32', ((command: string, args: string[], options: { windowsHide?: boolean }, callback: (error: Error | null) => void) => {
      calls.push({ command, args, windowsHide: options.windowsHide })
      callback(null)
    }) as never)

    expect(removed).toBe(true)
    expect(calls).toEqual([{
      command: 'schtasks',
      args: ['/Delete', '/TN', 'DSH Doctor Supervisor', '/F'],
      windowsHide: true,
    }])
  })
})
