import { access, mkdir, readFile, rm, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

interface ActiveRuntimePointer {
  root: string
  version: string
}

export interface RuntimePaths {
  bundledRoot: string
  userRuntimeRoot: string
  pointerPath: string
  pointerBackupPath?: string
  updateFailurePath?: string
  dshHome: string
}

export interface ResolvedRuntime {
  root: string
  version: string
}

/** Resolve the immutable runtime shipped with the desktop installation. */
export function resolveBundledRuntime(paths: RuntimePaths, bundledVersion: string): ResolvedRuntime {
  return { root: paths.bundledRoot, version: bundledVersion }
}

export function createRuntimePaths(appRoot: string, userDataPath: string): RuntimePaths {
  const userRuntimeRoot = join(userDataPath, 'runtime')
  return {
    bundledRoot: appRoot,
    userRuntimeRoot,
    pointerPath: join(userRuntimeRoot, 'active.json'),
    pointerBackupPath: join(userRuntimeRoot, 'active.json.backup'),
    updateFailurePath: join(userRuntimeRoot, 'update-failure.json'),
    dshHome: join(userDataPath, 'dsh-home'),
  }
}

async function readPointer(path: string): Promise<ActiveRuntimePointer | null> {
  try {
    const pointer = JSON.parse(await readFile(path, 'utf8')) as Partial<ActiveRuntimePointer>
    if (typeof pointer.root !== 'string' || typeof pointer.version !== 'string') return null
    return { root: pointer.root, version: pointer.version }
  } catch {
    return null
  }
}

async function readFailure(paths: RuntimePaths): Promise<{ version: string; candidate?: string } | null> {
  try {
    const value = JSON.parse(await readFile(paths.updateFailurePath ?? join(paths.userRuntimeRoot, 'update-failure.json'), 'utf8')) as {
      version?: unknown
      candidate?: unknown
    }
    if (typeof value.version !== 'string') return null
    return {
      version: value.version,
      candidate: typeof value.candidate === 'string' ? value.candidate : undefined,
    }
  } catch {
    return null
  }
}

/** Persist the active runtime pointer and a recoverable copy in that order. */
export async function writeActiveRuntimePointer(paths: RuntimePaths, pointer: ActiveRuntimePointer): Promise<void> {
  await mkdir(paths.userRuntimeRoot, { recursive: true })
  const temporary = `${paths.pointerPath}.tmp-${process.pid}`
  await writeFile(temporary, JSON.stringify(pointer, null, 2), 'utf8')
  await rename(temporary, paths.pointerPath)
  const backupPath = paths.pointerBackupPath ?? `${paths.pointerPath}.backup`
  const backupTemporary = `${backupPath}.tmp-${process.pid}`
  await writeFile(backupTemporary, JSON.stringify(pointer, null, 2), 'utf8')
  await rename(backupTemporary, backupPath)
}

export async function resolveActiveRuntime(paths: RuntimePaths, bundledVersion: string): Promise<ResolvedRuntime> {
  let pointer = await readPointer(paths.pointerPath)
  if (pointer === null) {
    // Older update builds deleted active.json before renaming its replacement.
    // Restore the last known pointer before considering the immutable bundle.
    const backupPath = paths.pointerBackupPath ?? `${paths.pointerPath}.backup`
    pointer = await readPointer(backupPath)
    if (pointer !== null) {
      await writeActiveRuntimePointer(paths, pointer).catch(() => undefined)
    }
  }

  const failure = await readFailure(paths)
  if (pointer === null && failure !== null) {
    // A failed update may have been committed by an older build while its
    // pointer write was interrupted. The candidate directory is still useful
    // evidence and can be retried later, but must never be activated blindly.
    const candidate = resolve(failure.candidate ?? join(paths.userRuntimeRoot, 'versions', `dsh-${failure.version}`))
    try {
      await access(join(candidate, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
      pointer = { root: candidate, version: failure.version }
      await writeActiveRuntimePointer(paths, pointer).catch(() => undefined)
    } catch {
      // The candidate was removed; keep using the bundled runtime.
    }
  }

  if (pointer !== null) {
    if (failure?.version === pointer.version) return { root: paths.bundledRoot, version: bundledVersion }
    try {
      const root = resolve(pointer.root)
      await access(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
      return { root, version: pointer.version }
    } catch {
      // A missing candidate falls back to the immutable bundled runtime.
    }
  }
  return { root: paths.bundledRoot, version: bundledVersion }
}

export async function ensureRuntimeDirectories(paths: RuntimePaths): Promise<void> {
  await mkdir(paths.userRuntimeRoot, { recursive: true })
  await mkdir(paths.dshHome, { recursive: true })
}

/** Remove a failed update pointer so the next boot uses the immutable bundle. */
export async function clearActiveRuntimePointer(paths: RuntimePaths): Promise<void> {
  try {
    const pointer = JSON.parse(await readFile(paths.pointerPath, 'utf8')) as Partial<ActiveRuntimePointer>
    if (typeof pointer.root !== 'string') return
  } catch {
    return
  }
  // Rename is intentionally avoided here: a stale pointer is harmless and
  // deleting only this small metadata file cannot affect runtime or sessions.
  await rm(paths.pointerPath, { force: true })
}

export async function recordRuntimeFailure(paths: RuntimePaths, detail: string): Promise<void> {
  let version: string | null = null
  try {
    const pointer = JSON.parse(await readFile(paths.pointerPath, 'utf8')) as Partial<ActiveRuntimePointer>
    version = typeof pointer.version === 'string' ? pointer.version : null
  } catch {
    return
  }
  if (version === null) return
  await recordRuntimeFailureForVersion(paths, version, detail)
}

export async function recordRuntimeFailureForVersion(paths: RuntimePaths, version: string, detail: string): Promise<void> {
  const failurePath = paths.updateFailurePath ?? join(paths.userRuntimeRoot, 'update-failure.json')
  const temporary = `${failurePath}.tmp-${process.pid}`
  await writeFile(temporary, JSON.stringify({ version, detail, recordedAt: new Date().toISOString() }, null, 2), 'utf8')
  await rename(temporary, failurePath)
}

export async function clearRuntimeFailure(paths: RuntimePaths): Promise<void> {
  await rm(paths.updateFailurePath ?? join(paths.userRuntimeRoot, 'update-failure.json'), { force: true })
}
