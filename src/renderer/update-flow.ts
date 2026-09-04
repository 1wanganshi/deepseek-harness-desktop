import type { UpdateStatus } from '../shared/types.js'

export type UpdateDialogKind = 'checking' | 'available' | 'latest' | 'error'

export function getUpdateDialogKind(status: UpdateStatus | null): UpdateDialogKind {
  if (status === null) return 'checking'
  if (status.error !== null) return 'error'
  if (status.updateAvailable) return 'available'
  return 'latest'
}
