import { access } from 'node:fs/promises'
import { join } from 'node:path'

export interface BundledDependencyRepairOptions {
  workerPath: string
  install: (args: string[]) => Promise<void>
}

export async function repairBundledDependencies(options: BundledDependencyRepairOptions): Promise<boolean> {
  if (await isUsableWorkerPackage(options.workerPath)) return false
  await options.install(['install', '--prod', '--no-frozen-lockfile'])
  if (!await isUsableWorkerPackage(options.workerPath)) {
    throw new Error(`修复后仍缺少 ${options.workerPath}`)
  }
  return true
}

async function isUsableWorkerPackage(packagePath: string): Promise<boolean> {
  try {
    await access(join(packagePath, 'package.json'))
    await access(join(packagePath, 'lib', 'index.js'))
    return true
  } catch {
    return false
  }
}
