import { access, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

export interface ProjectSessionMergeOptions {
  legacyHome: string
  targetHome: string
  projectCwd: string
  backupRoot: string
}

export interface ProjectSessionMergeStatus {
  status: 'not-found' | 'merged' | 'already-merged' | 'failed'
  projectCwd: string
  sourceSessionIds: string[]
  copiedSessionIds: string[]
  skippedSessionIds: string[]
  copiedPaths: string[]
  workspaceUpdated: boolean
  workspaceId: string | null
  workspaceSessionIdsAdded: number
  backupPath: string | null
  error: string | null
}

interface SessionSource {
  id: string
  indexPath: string
  blobPath: string | null
}

interface JsonRecord {
  [key: string]: unknown
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeCwd(value: string): string {
  return resolve(value).replaceAll('/', '\\').replace(/[\\]+$/, '').toLowerCase()
}

function recordCwd(value: unknown): string | null {
  if (!isRecord(value)) return null
  const record = isRecord(value.record) ? value.record : value
  const identity = isRecord(record.identity) ? record.identity : null
  return typeof identity?.cwd === 'string' ? identity.cwd : null
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function findSessionBlob(root: string, sessionId: string): Promise<string | null> {
  const sessionsRoot = join(root, 'sessions')
  if (!await exists(sessionsRoot)) return null
  const expectedDirectory = `session-${sessionId}`.toLowerCase()
  const queue = [sessionsRoot]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (!entry.isDirectory()) continue
      if (entry.name.toLowerCase() === expectedDirectory) {
        const blob = join(path, 'session.jsonl.zstd')
        if (await exists(blob)) return blob
      }
      queue.push(path)
    }
  }
  return null
}

async function discoverProjectSessions(root: string, projectCwd: string): Promise<SessionSource[]> {
  const indexRoot = join(root, 'storages', 'session_projcache', 'sessions')
  if (!await exists(indexRoot)) return []
  const normalizedProject = normalizeCwd(projectCwd)
  const result: SessionSource[] = []
  for (const entry of await readdir(indexRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
    const indexPath = join(indexRoot, entry.name)
    try {
      const parsed = JSON.parse(await readFile(indexPath, 'utf8')) as unknown
      if (recordCwd(parsed) === null || normalizeCwd(recordCwd(parsed) as string) !== normalizedProject) continue
      const id = basename(entry.name, '.json').replace(/^session-/i, '')
      if (!id) continue
      result.push({ id, indexPath, blobPath: await findSessionBlob(root, id) })
    } catch {
      // Ignore unrelated/corrupt index files; the caller still receives the
      // valid DHS1 sessions and the repair report can surface the count.
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id))
}

async function makeBackupPath(root: string): Promise<string> {
  await mkdir(root, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  let candidate = join(root, `dhs1-session-merge-${stamp}`)
  let suffix = 1
  while (await exists(candidate)) candidate = join(root, `dhs1-session-merge-${stamp}-${suffix++}`)
  await mkdir(candidate, { recursive: true })
  return candidate
}

async function copyAtomic(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.dhs1-merge-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`
  try {
    await cp(source, temporary, { force: true })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.dhs1-merge-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

interface WorkspaceMergePlan {
  sourcePath: string
  targetPath: string
  nextValue: JsonRecord
  targetExists: boolean
  workspaceId: string
  sessionIdsAdded: number
  changed: boolean
}

function workspaceTables(value: unknown): { global: JsonRecord; tables: JsonRecord; workspaces: JsonRecord } | null {
  if (!isRecord(value)) return null
  const global = isRecord(value.global) ? value.global : {}
  const tables = isRecord(value.tables) ? value.tables : {}
  const workspaces = isRecord(tables.workspaces) ? tables.workspaces : {}
  return { global, tables, workspaces }
}

function workspacePath(value: unknown): string | null {
  if (!isRecord(value) || typeof value.path !== 'string') return null
  return value.path
}

async function buildWorkspaceMergePlan(
  sourceRoot: string,
  targetRoot: string,
  projectCwd: string,
  sessionIds: string[],
): Promise<WorkspaceMergePlan | null> {
  const sourcePath = join(sourceRoot, 'storages', 'workspace.json')
  if (!await exists(sourcePath)) return null
  const sourceValue = JSON.parse(await readFile(sourcePath, 'utf8')) as unknown
  const sourceParts = workspaceTables(sourceValue)
  if (sourceParts === null) return null
  const normalizedProject = normalizeCwd(projectCwd)
  const sourceEntry = Object.entries(sourceParts.workspaces).find(([, value]) => {
    const path = workspacePath(value)
    return path !== null && normalizeCwd(path) === normalizedProject
  })
  if (sourceEntry === undefined) return null

  const targetPath = join(targetRoot, 'storages', 'workspace.json')
  const targetExists = await exists(targetPath)
  const targetValue = targetExists
    ? JSON.parse(await readFile(targetPath, 'utf8')) as unknown
    : { unit: { name: 'workspace', version: 2 }, global: {}, tables: {} }
  const targetParts = workspaceTables(targetValue)
  if (targetParts === null) return null
  const [sourceId, sourceWorkspace] = sourceEntry
  const targetEntry = Object.entries(targetParts.workspaces).find(([, value]) => {
    const path = workspacePath(value)
    return path !== null && normalizeCwd(path) === normalizedProject
  })
  const workspaceId = targetEntry?.[0] ?? sourceId
  const currentWorkspace = isRecord(targetEntry?.[1])
    ? targetEntry[1]
    : isRecord(sourceWorkspace)
      ? { ...sourceWorkspace }
      : {}
  const existingSessionIds = Array.isArray(currentWorkspace.sessionIds)
    ? (currentWorkspace.sessionIds as unknown[]).filter((id): id is string => typeof id === 'string')
    : []
  const mergedSessionIds = [...existingSessionIds]
  let sessionIdsAdded = 0
  for (const id of sessionIds) {
    const key = `session-${id}`
    if (!mergedSessionIds.includes(key)) {
      mergedSessionIds.push(key)
      sessionIdsAdded += 1
    }
  }
  currentWorkspace.sessionIds = mergedSessionIds
  targetParts.workspaces[workspaceId] = currentWorkspace
  const workspaceIds = Array.isArray(targetParts.global.workspaceIds)
    ? targetParts.global.workspaceIds.filter((id): id is string => typeof id === 'string')
    : []
  const hadWorkspaceId = workspaceIds.includes(workspaceId)
  if (!hadWorkspaceId) workspaceIds.push(workspaceId)
  targetParts.global.workspaceIds = workspaceIds
  targetParts.tables.workspaces = targetParts.workspaces
  const nextValue = isRecord(targetValue) ? targetValue : {}
  nextValue.global = targetParts.global
  nextValue.tables = targetParts.tables
  const changed = targetEntry === undefined || sessionIdsAdded > 0 || !hadWorkspaceId
  return { sourcePath, targetPath, nextValue, targetExists, workspaceId, sessionIdsAdded, changed }
}

function aggregateSessions(value: unknown): JsonRecord | null {
  if (!isRecord(value) || !isRecord(value.tables) || !isRecord(value.tables.sessions)) return null
  return value.tables.sessions
}

async function mergeAggregate(
  sourceRoot: string,
  targetRoot: string,
  sessionIds: Set<string>,
  changedPaths: string[],
): Promise<void> {
  const sourcePath = join(sourceRoot, 'storages', 'session_projcache.json')
  if (!await exists(sourcePath)) return
  const targetPath = join(targetRoot, 'storages', 'session_projcache.json')
  const source = JSON.parse(await readFile(sourcePath, 'utf8')) as unknown
  const sourceSessions = aggregateSessions(source)
  if (sourceSessions === null) return
  const target = await exists(targetPath)
    ? JSON.parse(await readFile(targetPath, 'utf8')) as unknown
    : {}
  if (!isRecord(target) || !isRecord(target.tables)) return
  const targetSessions = aggregateSessions(target) ?? {}
  let changed = false
  for (const id of sessionIds) {
    const key = `session-${id}`
    if (!(key in targetSessions) && key in sourceSessions) {
      targetSessions[key] = sourceSessions[key]
      changed = true
    }
  }
  if (!changed) return
  await writeJsonAtomic(targetPath, target)
  changedPaths.push(targetPath)
}

/**
 * Merge only the sessions belonging to one project from the legacy DSH home.
 * Source files are never changed; target writes are atomic and repeatable.
 */
export async function mergeLegacyProjectSessions(
  options: ProjectSessionMergeOptions,
): Promise<ProjectSessionMergeStatus> {
  const projectCwd = resolve(options.projectCwd)
  const base: ProjectSessionMergeStatus = {
    status: 'not-found',
    projectCwd,
    sourceSessionIds: [],
    copiedSessionIds: [],
    skippedSessionIds: [],
    copiedPaths: [],
    workspaceUpdated: false,
    workspaceId: null,
    workspaceSessionIdsAdded: 0,
    backupPath: null,
    error: null,
  }
  const sources = await discoverProjectSessions(options.legacyHome, projectCwd)
  base.sourceSessionIds = sources.map(source => source.id)
  if (sources.length === 0) return base

  const targetIndexRoot = join(options.targetHome, 'storages', 'session_projcache', 'sessions')
  const changedPaths: string[] = []
  const targetNewFiles: string[] = []
  const targetAggregate = join(options.targetHome, 'storages', 'session_projcache.json')
  let aggregateBefore: string | null = null
  let workspacePlan: WorkspaceMergePlan | null = null
  let workspaceBefore: string | null = null
  try {
    workspacePlan = await buildWorkspaceMergePlan(
      options.legacyHome,
      options.targetHome,
      projectCwd,
      sources.map(source => source.id),
    )
    for (const source of sources) {
      const targetIndex = join(targetIndexRoot, `session-${source.id}.json`)
      const targetBlob = await findSessionBlob(options.targetHome, source.id)
      const indexMissing = !await exists(targetIndex)
      const blobMissing = source.blobPath !== null && targetBlob === null
      if (!indexMissing && !blobMissing) {
        base.skippedSessionIds.push(source.id)
        continue
      }
      if (base.backupPath === null) base.backupPath = await makeBackupPath(options.backupRoot)
      const backupLegacy = join(base.backupPath, 'legacy')
      const backupTarget = join(base.backupPath, 'target')
      await copyAtomic(source.indexPath, join(backupLegacy, relative(options.legacyHome, source.indexPath)))
      if (source.blobPath !== null) await copyAtomic(source.blobPath, join(backupLegacy, relative(options.legacyHome, source.blobPath)))
      if (indexMissing) {
        await copyAtomic(source.indexPath, targetIndex)
        targetNewFiles.push(targetIndex)
        base.copiedPaths.push(relative(options.targetHome, targetIndex))
      }
      if (blobMissing && source.blobPath !== null) {
        const targetBlobPath = join(options.targetHome, 'sessions', relative(join(options.legacyHome, 'sessions'), source.blobPath))
        await copyAtomic(source.blobPath, targetBlobPath)
        targetNewFiles.push(targetBlobPath)
        base.copiedPaths.push(relative(options.targetHome, targetBlobPath))
      }
      base.copiedSessionIds.push(source.id)
      changedPaths.push(...targetNewFiles.slice(-2))
      if (await exists(targetAggregate) && aggregateBefore === null) {
        aggregateBefore = await readFile(targetAggregate, 'utf8')
        await copyAtomic(targetAggregate, join(backupTarget, relative(options.targetHome, targetAggregate)))
      }
    }

    if (workspacePlan?.changed) {
      if (base.backupPath === null) base.backupPath = await makeBackupPath(options.backupRoot)
      const backupLegacy = join(base.backupPath, 'legacy')
      const backupTarget = join(base.backupPath, 'target')
      await copyAtomic(workspacePlan.sourcePath, join(backupLegacy, relative(options.legacyHome, workspacePlan.sourcePath)))
      if (workspacePlan.targetExists) {
        workspaceBefore = await readFile(workspacePlan.targetPath, 'utf8')
        await copyAtomic(workspacePlan.targetPath, join(backupTarget, relative(options.targetHome, workspacePlan.targetPath)))
      }
      await writeJsonAtomic(workspacePlan.targetPath, workspacePlan.nextValue)
      base.workspaceUpdated = true
      base.workspaceId = workspacePlan.workspaceId
      base.workspaceSessionIdsAdded = workspacePlan.sessionIdsAdded
      base.copiedPaths.push(relative(options.targetHome, workspacePlan.targetPath))
    } else if (workspacePlan !== null) {
      base.workspaceId = workspacePlan.workspaceId
    }

    if (base.backupPath !== null) {
      await mergeAggregate(options.legacyHome, options.targetHome, new Set(base.copiedSessionIds), changedPaths)
      await writeJsonAtomic(join(base.backupPath, 'manifest.json'), {
        projectCwd,
        sourceSessionIds: base.sourceSessionIds,
        copiedSessionIds: base.copiedSessionIds,
        skippedSessionIds: base.skippedSessionIds,
        copiedPaths: base.copiedPaths,
        workspaceUpdated: base.workspaceUpdated,
        workspaceId: base.workspaceId,
        workspaceSessionIdsAdded: base.workspaceSessionIdsAdded,
      })
    }
    base.status = base.copiedSessionIds.length > 0 || base.workspaceUpdated ? 'merged' : 'already-merged'
    return base
  } catch (error) {
    for (const path of targetNewFiles) await rm(path, { force: true }).catch(() => undefined)
    if (aggregateBefore !== null) await writeFile(targetAggregate, aggregateBefore, 'utf8').catch(() => undefined)
    if (workspacePlan?.changed) {
      if (workspaceBefore !== null) await writeFile(workspacePlan.targetPath, workspaceBefore, 'utf8').catch(() => undefined)
      else await rm(workspacePlan.targetPath, { force: true }).catch(() => undefined)
    }
    base.status = 'failed'
    base.error = error instanceof Error ? error.message : String(error)
    return base
  }
}
