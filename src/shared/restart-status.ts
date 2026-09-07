import type { DesktopRestartResult } from '../main/desktop-restart.js'

const blockerCopy: Record<NonNullable<DesktopRestartResult['report']>['blockers'][number]['reason'], string> = {
  'missing-transcript': '会话正文尚未写入',
  'missing-index': '会话索引尚未写入',
  'invalid-index': '会话索引尚未写完整',
  'missing-workspace': '会话尚未归属到工作区',
  'ambiguous-workspace': '会话工作区归属不明确',
}

export function restartNotice(result: DesktopRestartResult): string | null {
  if (result.restarted) return null
  const blocker = result.report?.blockers[0]
  if (blocker === undefined) return '已取消重启'
  return `会话尚未完整保存，已取消重启：${blockerCopy[blocker.reason]}。请稍候再试。`
}
