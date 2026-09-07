import { access } from 'node:fs/promises'
import { join } from 'node:path'

export interface BundledDependencyRepairOptions {
  workerPath: string
  requiredPackagePaths?: string[]
  install: (args: string[]) => Promise<void>
}

export async function repairBundledDependencies(options: BundledDependencyRepairOptions): Promise<boolean> {
  if (await hasUsableDependencies(options)) return false
  await options.install(['install', '--prod', '--no-frozen-lockfile'])
  if (!await hasUsableDependencies(options)) {
    throw new Error(`修复后仍缺少官方 workflow 依赖：${options.workerPath}`)
  }
  return true
}

async function hasUsableDependencies(options: BundledDependencyRepairOptions): Promise<boolean> {
  if (!await isUsablePackage(options.workerPath, 'lib/index.js')) return false
  for (const packagePath of options.requiredPackagePaths ?? []) {
    if (!await isUsablePackage(packagePath, 'lib/index.js')) return false
  }
  return true
}

async function isUsablePackage(packagePath: string, entrypoint: string): Promise<boolean> {
  try {
    await access(join(packagePath, 'package.json'))
    await access(join(packagePath, entrypoint))
    return true
  } catch {
    return false
  }
}
