import type { UpdateStatus } from '../shared/types.js'

export function updateBadgeLabel(status: UpdateStatus | null): string {
  if (status === null) return '检查更新中'
  return status.updateAvailable ? '有更新' : '已是最新'
}
