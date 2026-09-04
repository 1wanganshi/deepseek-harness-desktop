import { describe, expect, it } from 'vitest'
import { REPAIR_PLAN } from '../src/shared/repair-plan.js'
import { createRepairChecks, updateRepairCheck } from '../src/shared/repair-progress.js'

describe('repair progress state', () => {
  it('keeps the problem and repair method visible across checking and repairing states', () => {
    const initial = createRepairChecks(REPAIR_PLAN)
    expect(initial[0]).toMatchObject({
      status: 'pending',
      problem: null,
      repairMethod: REPAIR_PLAN[0]?.repairMethod,
    })

    const checking = updateRepairCheck(initial, 'deps', {
      status: 'checking',
      detail: '正在检查桌面壳依赖',
    })
    expect(checking[0]).toMatchObject({ status: 'checking', detail: '正在检查桌面壳依赖' })

    const repairing = updateRepairCheck(checking, 'deps', {
      status: 'repairing',
      problem: '检测到官方 workflow 依赖缺失',
      detail: '正在重新安装官方依赖',
    })
    expect(repairing[0]).toMatchObject({
      status: 'repairing',
      problem: '检测到官方 workflow 依赖缺失',
      repairMethod: REPAIR_PLAN[0]?.repairMethod,
    })

    const completed = updateRepairCheck(repairing, 'deps', {
      status: 'fixed',
      detail: '已重新安装官方 workflow worker 依赖',
    })
    expect(completed[0]).toMatchObject({ status: 'fixed', problem: '检测到官方 workflow 依赖缺失' })
  })
})
