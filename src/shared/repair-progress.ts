import type { RepairCheck, RepairCheckStatus } from './types.js'
import type { RepairPlanStep } from './repair-plan.js'

export function createRepairChecks(plan: readonly RepairPlanStep[]): RepairCheck[] {
  return plan.map(step => ({
    ...step,
    status: 'pending',
    problem: null,
    detail: null,
  }))
}

export function updateRepairCheck(
  checks: readonly RepairCheck[],
  id: string,
  update: Partial<Pick<RepairCheck, 'status' | 'problem' | 'detail'>>,
): RepairCheck[] {
  return checks.map(check => check.id === id ? { ...check, ...update } : { ...check })
}

export function repairStatusLabel(status: RepairCheckStatus): string {
  if (status === 'checking') return '检查中'
  if (status === 'repairing') return '正在修复'
  if (status === 'failed') return '失败'
  if (status === 'fixed') return '已修复'
  if (status === 'skipped') return '跳过'
  if (status === 'ok') return '无需修复'
  return '待执行'
}
