import { access, mkdir, readdir, readFile, rename, writeFile, cp } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'

export interface SessionDurabilityOptions {
  dshHome: string
  backupRoot: string
  now?: () => Date
  settleMs?: number
}

export type SessionDurabilityBlockerReason =
  | 'missing-transcript'
  | 'missing-index'
  | 'invalid-index'
  | 'missing-workspace'
  | 'ambiguous-workspace'

export interface SessionDurabilityBlocker {
  sessionId: string
  reason: SessionDurabilityBlockerReason
}

export interface SessionDurabilityReport {
  safe: boolean
  checkedSessionIds: string[]
  repairedSessionIds: string[]
  blockers: SessionDurabilityBlocker[]
  backupPath: string | null
}

interface SessionRecord {
  id: string
  transcriptPath: string | null
  indexPath: string | null
  transcriptSignature: string | null
  indexSignature: string | null
}

interface JsonRecord {
  [key: string]: unknown
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizePath(value: string): string {
  return resolve(value).replace(/[\\/]+$/, '').toLowerCase()
}

function sessionIdFromName(name: string): string | null {
  const match = /^session-(.+)\.json$/i.exec(name)
  return match?.[1] ?? null
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function listFiles(root: string, predicate: (name: string) => boolean): Promise<string[]> {
  if (!await exists(root)) return []
  const result: string[] = []
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) queue.push(path)
      else if (predicate(entry.name)) result.push(path)
    }
  }
  return result
}

async function fileSignature(path: string | null): Promise<string | null> {
  if (path === null) return null
  try {
    const { stat } = await import('node:fs/promises')
    const info = await stat(path)
    return `${info.size}:${info.mtimeMs}`
  } catch {
    return null
  }
}

function sessionsEqual(left: Map<string, SessionRecord>, right: Map<string, SessionRecord>): boolean {
  if (left.size !== right.size) return false
  for (const [id, value] of left) {
    const other = right.get(id)
    if (other === undefined || value.indexSignature !== other.indexSignature || value.transcriptSignature !== other.transcriptSignature) return false
  }
  return true
}

async function waitForStableScan(dshHome: string, settleMs: number): Promise<Map<string, SessionRecord>> {
  let previous = await scanSessions(dshHome)
  const deadline = Date.now() + Math.max(settleMs * 4, 250)
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, settleMs))
    const current = await scanSessions(dshHome)
    if (sessionsEqual(previous, current)) return current
    previous = current
  }
  return previous
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.dhs-durability-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  } finally {
    if (await exists(temporary)) {
      const { rm } = await import('node:fs/promises')
      await rm(temporary, { force: true })
    }
  }
}

function indexCwd(value: unknown): string | null {
  if (!isRecord(value)) return null
  const record = isRecord(value.record) ? value.record : value
  const identity = isRecord(record.identity) ? record.identity : null
  return typeof identity?.cwd === 'string' ? identity.cwd : null
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

function workspaceSessionIds(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.sessionIds)) return []
  return value.sessionIds.filter((id): id is string => typeof id === 'string')
}

function canonicalSessionKey(id: string): string {
  return `session-${id}`
}

function normalizeWorkspaceSessionLinks(workspaces: JsonRecord, knownSessionIds: Set<string>): boolean {
  let changed = false
  for (const workspace of Object.values(workspaces)) {
    if (!isRecord(workspace)) continue
    const ids = workspaceSessionIds(workspace)
    const normalized: string[] = []
    const seen = new Set<string>()
    let workspaceChanged = false
    for (const id of ids) {
      const key = knownSessionIds.has(id) ? canonicalSessionKey(id) : id
      if (seen.has(key)) {
        changed = true
        workspaceChanged = true
        continue
      }
      seen.add(key)
      normalized.push(key)
      if (key !== id) {
        changed = true
        workspaceChanged = true
      }
    }
    if (workspaceChanged) workspace.sessionIds = normalized
  }
  return changed
}

async function scanSessions(dshHome: string): Promise<Map<string, SessionRecord>> {
  const result = new Map<string, SessionRecord>()
  const indexRoot = join(dshHome, 'storages', 'session_projcache', 'sessions')
  for (const path of await listFiles(indexRoot, name => /^session-.+\.json$/i.test(name))) {
    const id = sessionIdFromName(path.split(/[\\/]/).pop() as string)
    if (id !== null) result.set(id, {
      id,
      indexPath: path,
      transcriptPath: null,
      indexSignature: await fileSignature(path),
      transcriptSignature: null,
    })
  }
  for (const path of await listFiles(join(dshHome, 'sessions'), name => name === 'session.jsonl.zstd')) {
    // Imported sessions use an `import-*` directory while native sessions use
    // `session-*`; both are valid session IDs and must be indexed alike.
    const match = /[\\/]([^\\/]+)[\\/]session\.jsonl\.zstd$/i.exec(path)
    if (match === null) continue
    const directoryId = match[1]
    const id = directoryId.startsWith('session-') ? directoryId.slice('session-'.length) : directoryId
    const current = result.get(id) ?? {
      id,
      indexPath: null,
      transcriptPath: null,
      indexSignature: null,
      transcriptSignature: null,
    }
    current.transcriptPath = path
    current.transcriptSignature = await fileSignature(path)
    result.set(id, current)
  }
  return result
}

interface TranscriptHeader {
  id: string
  createdAt: number
  cwd: string
}

interface TranscriptSummary extends TranscriptHeader {
  title: string
  titleSeq: number
  lastSeq: number
}

function frameOffsets(blob: Buffer): number[] {
  const offsets: number[] = []
  for (let index = 0; index <= blob.length - 4; index += 1) {
    if (blob[index] === 0x28 && blob[index + 1] === 0xb5 && blob[index + 2] === 0x2f && blob[index + 3] === 0xfd) {
      offsets.push(index)
    }
  }
  return offsets
}

function transcriptSummary(blob: Buffer, expectedId: string): TranscriptSummary | null {
  const offsets = frameOffsets(blob)
  if (offsets.length === 0) return null
  const records: JsonRecord[] = []
  for (let index = 0; index < offsets.length; index += 1) {
    const end = index + 1 < offsets.length ? offsets[index + 1] : blob.length
    try {
      const decoded = zstdDecompressSync(blob.subarray(offsets[index], end)).toString('utf8')
      for (const line of decoded.split(/\r?\n/)) {
        if (line.trim() === '') continue
        try {
          const value = JSON.parse(line) as unknown
          if (isRecord(value)) records.push(value)
        } catch {
          // A partially written final frame is ignored; the stable scan will
          // retry on the next startup once the transcript is complete.
        }
      }
    } catch {
      return null
    }
  }
  const header = records.find(value => value.type === 'session')
  if (header === undefined || typeof header.id !== 'string' || header.id !== expectedId || typeof header.cwd !== 'string' || typeof header.createdAt !== 'number') return null
  let title = '新会话'
  let titleSeq = 0
  let lastSeq = 0
  for (const record of records) {
    if (typeof record.seq === 'number') lastSeq = Math.max(lastSeq, record.seq)
    if (title !== '新会话' || record.type !== 'user/message' || !isRecord(record.data)) continue
    const source = isRecord(record.data.source) ? record.data.source : null
    if (source !== null && source.kind !== 'user') continue
    const content = Array.isArray(record.data.content) ? record.data.content : []
    const textPart = content.find(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
    if (isRecord(textPart) && typeof textPart.text === 'string' && textPart.text.trim() !== '') {
      title = textPart.text.trim().slice(0, 120)
      titleSeq = typeof record.seq === 'number' ? record.seq : 0
    }
  }
  return { id: header.id, createdAt: header.createdAt, cwd: header.cwd, title, titleSeq, lastSeq }
}

async function readTranscriptSummary(path: string, expectedId: string): Promise<TranscriptSummary | null> {
  try {
    return transcriptSummary(await readFile(path), expectedId)
  } catch {
    return null
  }
}

function buildRecoveredIndex(summary: TranscriptSummary): JsonRecord {
  return {
    version: 4,
    record: {
      identity: { createdAt: summary.createdAt, cwd: summary.cwd },
      rows: {
        title: { ver: 1, seq: summary.lastSeq, val: summary.title },
        titleInput: {
          ver: 3,
          seq: summary.lastSeq,
          val: { first: { seq: summary.titleSeq, text: summary.title }, count: 1, lastSeq: summary.titleSeq },
        },
      },
    },
  }
}

export interface RecoveredSessionIndex {
  id: string
  indexPath: string
  cwd: string
  title: string
}

/** Rebuild missing session indexes from durable transcript headers/events. */
export async function recoverMissingSessionIndexes(dshHome: string): Promise<RecoveredSessionIndex[]> {
  const sessions = await scanSessions(dshHome)
  const recovered: RecoveredSessionIndex[] = []
  for (const session of sessions.values()) {
    if (session.transcriptPath === null || session.indexPath !== null) continue
    const summary = await readTranscriptSummary(session.transcriptPath, session.id)
    if (summary === null) continue
    const indexPath = join(dshHome, 'storages', 'session_projcache', 'sessions', `session-${session.id}.json`)
    if (await exists(indexPath)) continue
    await writeJsonAtomic(indexPath, buildRecoveredIndex(summary))
    recovered.push({ id: session.id, indexPath, cwd: summary.cwd, title: summary.title })
  }
  return recovered
}

/** Attach every indexed session to the sole workspace matching its cwd. */
export async function repairWorkspaceLinks(dshHome: string, backupRoot: string): Promise<string[]> {
  const workspaceFile = join(dshHome, 'storages', 'workspace.json')
  if (!await exists(workspaceFile)) return []
  let document: unknown
  try {
    document = JSON.parse(await readFile(workspaceFile, 'utf8')) as unknown
  } catch {
    return []
  }
  const parts = workspaceTables(document)
  if (parts === null) return []
  const linked: string[] = []
  const sessions = await scanSessions(dshHome)
  let changed = normalizeWorkspaceSessionLinks(parts.workspaces, new Set(sessions.keys()))
  for (const session of sessions.values()) {
    if (session.indexPath === null) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(session.indexPath, 'utf8')) as unknown
    } catch {
      continue
    }
    const cwd = indexCwd(parsed)
    if (cwd === null) continue
    const matches = Object.entries(parts.workspaces).filter(([, value]) => workspacePath(value) !== null && normalizePath(workspacePath(value) as string) === normalizePath(cwd))
    if (matches.length !== 1) continue
    const [workspaceId, workspace] = matches[0]
    if (!isRecord(workspace)) continue
    const ids = workspaceSessionIds(workspace)
    const sessionKey = canonicalSessionKey(session.id)
    if (ids.includes(sessionKey)) continue
    workspace.sessionIds = [...ids, sessionKey]
    parts.global.workspaceIds = Array.isArray(parts.global.workspaceIds)
      ? [...new Set([...parts.global.workspaceIds.filter((value): value is string => typeof value === 'string'), workspaceId])]
      : [workspaceId]
    linked.push(session.id)
    changed = true
  }
  if (!changed) return []
  const backupPath = await createBackup(backupRoot, () => new Date(), workspaceFile)
  const nextDocument = isRecord(document) ? document : {}
  nextDocument.global = parts.global
  nextDocument.tables = parts.tables
  await writeJsonAtomic(workspaceFile, nextDocument)
  void backupPath
  return linked
}

async function createBackup(root: string, now: () => Date, workspacePathname: string): Promise<string> {
  const stamp = now().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  let path = join(root, `session-durability-${stamp}`)
  let suffix = 1
  while (await exists(path)) path = join(root, `session-durability-${stamp}-${suffix++}`)
  await mkdir(path, { recursive: true })
  await cp(workspacePathname, join(path, 'workspace.json'))
  return path
}

export class SessionDurabilityGuard {
  private readonly dshHome: string
  private readonly backupRoot: string
  private readonly now: () => Date
  private readonly settleMs: number
  private baseline = new Map<string, SessionRecord>()

  constructor(options: SessionDurabilityOptions) {
    this.dshHome = options.dshHome
    this.backupRoot = options.backupRoot
    this.now = options.now ?? (() => new Date())
    this.settleMs = options.settleMs ?? 50
  }

  async captureBaseline(): Promise<void> {
    this.baseline = await scanSessions(this.dshHome)
  }

  async verifyForRestart(): Promise<SessionDurabilityReport> {
    // A missing index is recoverable when the transcript contains a complete
    // header and event stream. Repair it before deciding whether to block.
    await recoverMissingSessionIndexes(this.dshHome)
    const current = await waitForStableScan(this.dshHome, this.settleMs)
    const checkedSessionIds = [...current.keys()].filter(id => {
      const before = this.baseline.get(id)
      const after = current.get(id)
      return before === undefined
        || before.indexPath !== after?.indexPath
        || before.transcriptPath !== after?.transcriptPath
        || before.indexSignature !== after?.indexSignature
        || before.transcriptSignature !== after?.transcriptSignature
    }).sort()
    const blockers: SessionDurabilityBlocker[] = []
    const repairedSessionIds: string[] = []
    let backupPath: string | null = null
    const workspaceFile = join(this.dshHome, 'storages', 'workspace.json')
    let workspaceDocument: unknown = null
    let workspaceParts: ReturnType<typeof workspaceTables> = null
    let workspaceChanged = false

    if (checkedSessionIds.length > 0 && await exists(workspaceFile)) {
      try {
        workspaceDocument = JSON.parse(await readFile(workspaceFile, 'utf8')) as unknown
        workspaceParts = workspaceTables(workspaceDocument)
      } catch {
        workspaceParts = null
      }
    }

    for (const id of checkedSessionIds) {
      const session = current.get(id) as SessionRecord
      if (session.transcriptPath === null) {
        blockers.push({ sessionId: id, reason: 'missing-transcript' })
        continue
      }
      if (session.indexPath === null) {
        blockers.push({ sessionId: id, reason: 'missing-index' })
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(await readFile(session.indexPath, 'utf8')) as unknown
      } catch {
        blockers.push({ sessionId: id, reason: 'invalid-index' })
        continue
      }
      const cwd = indexCwd(parsed)
      if (cwd === null || workspaceParts === null) {
        blockers.push({ sessionId: id, reason: 'missing-workspace' })
        continue
      }
      const matches = Object.entries(workspaceParts.workspaces).filter(([, value]) => workspacePath(value) !== null && normalizePath(workspacePath(value) as string) === normalizePath(cwd))
      if (matches.length === 0) {
        blockers.push({ sessionId: id, reason: 'missing-workspace' })
        continue
      }
      if (matches.length > 1) {
        blockers.push({ sessionId: id, reason: 'ambiguous-workspace' })
        continue
      }
      const [workspaceId, workspace] = matches[0]
      const ids = workspaceSessionIds(workspace)
      if (!ids.includes(`session-${id}`)) {
        if (!isRecord(workspace)) {
          blockers.push({ sessionId: id, reason: 'missing-workspace' })
          continue
        }
        workspace.sessionIds = [...ids, `session-${id}`]
        workspaceParts.global.workspaceIds = Array.isArray(workspaceParts.global.workspaceIds)
          ? [...new Set([...workspaceParts.global.workspaceIds.filter((value): value is string => typeof value === 'string'), workspaceId])]
          : [workspaceId]
        workspaceChanged = true
        repairedSessionIds.push(id)
      }
    }

    if (blockers.length === 0 && workspaceChanged && workspaceParts !== null) {
      if (!await exists(workspaceFile)) {
        return {
          safe: false,
          checkedSessionIds,
          repairedSessionIds: [],
          blockers: checkedSessionIds.map(sessionId => ({ sessionId, reason: 'missing-workspace' as const })),
          backupPath: null,
        }
      }
      backupPath = await createBackup(this.backupRoot, this.now, workspaceFile)
      const nextDocument = isRecord(workspaceDocument) ? workspaceDocument : {}
      nextDocument.global = workspaceParts.global
      nextDocument.tables = workspaceParts.tables
      await writeJsonAtomic(workspaceFile, nextDocument)
    }

    if (blockers.length === 0) {
      const linked = await repairWorkspaceLinks(this.dshHome, this.backupRoot)
      for (const id of linked) if (!repairedSessionIds.includes(id)) repairedSessionIds.push(id)
      if (linked.length > 0 && backupPath === null) backupPath = 'workspace-link-repair'
    }
    return { safe: blockers.length === 0, checkedSessionIds, repairedSessionIds, blockers, backupPath }
  }
}
