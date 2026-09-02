import { access, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

interface ActiveRuntimePointer {
  root: string
  version: string
}

export interface RuntimePaths {
  bundledRoot: string
  userRuntimeRoot: string
  pointerPath: string
  dshHome: string
}

export interface ResolvedRuntime {
  root: string
  version: string
}

export function createRuntimePaths(appRoot: string, userDataPath: string): RuntimePaths {
  const userRuntimeRoot = join(userDataPath, 'runtime')
  return {
    bundledRoot: appRoot,
    userRuntimeRoot,
    pointerPath: join(userRuntimeRoot, 'active.json'),
    dshHome: join(userDataPath, 'dsh-home'),
  }
}

export async function resolveActiveRuntime(paths: RuntimePaths, bundledVersion: string): Promise<ResolvedRuntime> {
  try {
    const pointer = JSON.parse(await readFile(paths.pointerPath, 'utf8')) as Partial<ActiveRuntimePointer>
    if (typeof pointer.root === 'string' && typeof pointer.version === 'string') {
      const root = resolve(pointer.root)
      await access(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
      return { root, version: pointer.version }
    }
  } catch {
    // A missing or invalid pointer falls back to the immutable bundled runtime.
  }
  return { root: paths.bundledRoot, version: bundledVersion }
}

export async function ensureRuntimeDirectories(paths: RuntimePaths): Promise<void> {
  await mkdir(paths.userRuntimeRoot, { recursive: true })
  await mkdir(paths.dshHome, { recursive: true })
}
