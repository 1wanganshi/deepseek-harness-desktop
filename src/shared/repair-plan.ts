export interface RepairPlanStep {
  id: string
  label: string
  description: string
  repairMethod: string
}

export const REPAIR_PLAN: ReadonlyArray<RepairPlanStep> = [
  {
    id: 'deps',
    label: '桌面壳依赖',
    description: '检查内置 workflow 依赖，缺失时重新安装官方依赖。',
    repairMethod: '重新安装缺失的官方 workflow worker 依赖，并再次验证入口文件。',
  },
  {
    id: 'locks',
    label: '陈旧进程锁',
    description: '检测任务板遗留锁，仅在原进程已退出时清理。',
    repairMethod: '确认锁对应进程已退出后，删除陈旧锁文件。',
  },
  {
    id: 'profile',
    label: 'Web profile 依赖',
    description: '校验官方 Web profile 的兼容补丁和插件依赖，必要时重建。',
    repairMethod: '同步兼容包，按锁文件策略重建 Web profile 依赖，并校验插件版本。',
  },
  {
    id: 'provider-compatibility',
    label: '模型 Provider 兼容性',
    description: '检查 reasoning 模型的 OpenAI 兼容 Provider 是否会发送不受支持的 developer role。',
    repairMethod: '在符合条件的 Provider 下写入 compat.supportsDeveloperRole: false，保留 reasoningEfforts 配置。',
  },
  {
    id: 'sessions',
    label: 'DHS1 会话库',
    description: '检查 D:\\vibecoding\\DHS1 是否有历史会话仍留在旧 DSH_HOME。',
    repairMethod: '只合并 DHS1 项目的缺失会话、索引和正文，创建备份且不覆盖现有记录。',
  },
  {
    id: 'data',
    label: '运行目录与数据',
    description: '确认 DSH_HOME、运行时目录和用户数据目录可访问。',
    repairMethod: '创建缺失的运行目录，不删除会话、凭据或插件配置。',
  },
  {
    id: 'runtime',
    label: 'Harness 健康重启',
    description: '停止当前 Harness，重新启动并等待本机健康检查通过。',
    repairMethod: '停止当前 Harness，重新启动后轮询本机端口直到健康检查通过。',
  },
]
