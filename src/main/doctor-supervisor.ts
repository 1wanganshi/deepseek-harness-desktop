import { execFile } from 'node:child_process'

const LEGACY_TASK_NAME = 'DSH Doctor Supervisor'

/**
 * Remove the legacy community-plugin task which starts an independent Node
 * supervisor at login. The desktop host owns its own lifecycle and must not
 * leave an embedded-runtime process running after exit.
 */
export async function removeLegacyDoctorSupervisor(
  platform: NodeJS.Platform = process.platform,
  execFileImpl: typeof execFile = execFile,
): Promise<boolean> {
  if (platform !== 'win32') return false
  return new Promise(resolve => {
    execFileImpl('schtasks', ['/Delete', '/TN', LEGACY_TASK_NAME, '/F'], { windowsHide: true }, error => {
      resolve(error === null)
    })
  })
}
