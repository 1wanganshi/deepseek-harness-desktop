import type { RepairReport, UpdateStatus } from '../shared/types.js'

export type UpdateTone = 'ok' | 'warming' | 'danger' | 'idle'

export interface UpdateIndicator {
  text: string
  tone: UpdateTone
}

export function describeUpdateState(update: UpdateStatus | null, checking: boolean): UpdateIndicator {
  if (checking) return { text: '正在检查更新…', tone: 'warming' }
  if (update === null) return { text: '尚未检查更新', tone: 'idle' }
  if (update.latestVersion !== null && update.updateAvailable) {
    return { text: `发现新版本 v${update.latestVersion}，可一键更新`, tone: 'warming' }
  }
  if (update.latestVersion !== null) return { text: '已是最新版本', tone: 'ok' }
  if (update.error !== null) return { text: `检查失败：${update.error}`, tone: 'danger' }
  return { text: '尚未检查更新', tone: 'idle' }
}

export function summarizeRepairReport(report: RepairReport | null): string | null {
  if (report === null || report.finishedAt === null) return null
  const failed = report.checks.filter(check => check.status === 'failed').length
  if (failed > 0) return `维修结束：${failed} 项未通过，可打开诊断查看日志后重试`
  if (report.fixedCount > 0) return `维修完成：已修复 ${report.fixedCount} 项问题`
  if (report.knownErrors.length > 0) return '维修完成：未发现可自动修复的问题，官方运行时已重启'
  return '维修完成：各项检查全部通过，官方运行时正常'
}
