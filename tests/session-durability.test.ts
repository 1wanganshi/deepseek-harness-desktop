import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionDurabilityGuard, isTranscriptFileName, repairWorkspaceLinks } from '../src/main/session-durability.js'

const roots: string[] = []
const project = 'D:\\vibecoding\\DHS1'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dhs-session-durability-'))
  roots.push(root)
  return { dshHome: join(root, 'dsh-home'), backupRoot: join(root, 'backups') }
}

async function writeWorkspace(dshHome: string, entries: Array<{ id: string; path: string; sessionIds?: string[] }>) {
  const workspaces = Object.fromEntries(entries.map(entry => [entry.id, {
    path: entry.path,
    sessionIds: entry.sessionIds ?? [],
  }]))
  await mkdir(join(dshHome, 'storages'), { recursive: true })
  await writeFile(join(dshHome, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { workspaceIds: entries.map(entry => entry.id) },
    tables: { workspaces },
  }), 'utf8')
}

async function writeTranscript(dshHome: string, id: string) {
  const path = join(dshHome, 'sessions', '--D-vibecoding-DHS1--', `session-${id}`, 'session.jsonl.zstd')
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `transcript-${id}`, 'utf8')
}

async function writeIndex(dshHome: string, id: string, cwd = project) {
  const path = join(dshHome, 'storages', 'session_projcache', 'sessions', `session-${id}.json`)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify({ version: 4, record: { identity: { cwd } } }), 'utf8')
}

async function writeCompleteSession(dshHome: string, id: string, cwd = project) {
  await writeTranscript(dshHome, id)
  await writeIndex(dshHome, id, cwd)
}

async function workspaceSessionIds(dshHome: string, workspaceId: string): Promise<string[]> {
  const document = JSON.parse(await readFile(join(dshHome, 'storages', 'workspace.json'), 'utf8')) as {
    tables: { workspaces: Record<string, { sessionIds: string[] }> }
  }
  return document.tables.workspaces[workspaceId].sessionIds
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('session durability guard', () => {
  it('recognizes every transcript file name variant the official runtimes write', () => {
    expect(isTranscriptFileName('session.jsonl.zstd')).toBe(true)
    expect(isTranscriptFileName('session.v2.jsonl.zstd')).toBe(true)
    expect(isTranscriptFileName('session.v3.jsonl.zstd')).toBe(true)
    expect(isTranscriptFileName('session.v10.jsonl.zstd')).toBe(true)
    expect(isTranscriptFileName('SESSION.V3.JSONL.ZSTD')).toBe(true)
    expect(isTranscriptFileName('session.jsonl')).toBe(false)
    expect(isTranscriptFileName('session-v3.jsonl.zstd')).toBe(false)
  })

  it('does not block exit for sessions stored in a versioned transcript file', async () => {
    const { dshHome, backupRoot } = await setup()
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    // 0.1.5 writes `session.v3.jsonl.zstd`; those sessions must never be
    // reported as missing a transcript.
    const dir = join(dshHome, 'sessions', '--D-vibecoding-DHS1--', `session-${id}`)
    await mkdir(dir, { recursive: true })
    const header = { type: 'session', id, cwd: project, createdAt: Date.now(), seq: 0 }
    const user = {
      type: 'user/message',
      seq: 1,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '版本化 transcript 会话' }] },
    }
    await writeFile(
      join(dir, 'session.v3.jsonl.zstd'),
      Buffer.concat([header, user].map(value => zstdCompressSync(Buffer.from(`${JSON.stringify(value)}\n`)))),
    )
    await writeIndex(dshHome, id)

    const guard = new SessionDurabilityGuard({ dshHome, backupRoot, settleMs: 0 })
    await guard.captureBaseline()
    const report = await guard.verifyForRestart()

    expect(report.blockers.filter(blocker => blocker.sessionId === id)).toEqual([])
  })

  it('normalizes imported workspace links without duplicating the session', async () => {
    const { dshHome, backupRoot } = await setup()
    const id = 'import-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await writeWorkspace(dshHome, [{ id: 'dhs1', path: project, sessionIds: [id, `session-${id}`] }])
    const dir = join(dshHome, 'sessions', '--D-vibecoding-DHS1--', `session-${id}`)
    await mkdir(dir, { recursive: true })
    const frame = { type: 'session', version: 0, id, createdAt: 1700000000000, cwd: project }
    await writeFile(join(dir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(`${JSON.stringify(frame)}\n`)))
    await writeIndex(dshHome, id)

    await repairWorkspaceLinks(dshHome, backupRoot)

    const ids = await workspaceSessionIds(dshHome, 'dhs1')
    expect(ids).toEqual([`session-${id}`])
  })

  it('recovers an imported transcript that has no index before restart', async () => {
    const { dshHome, backupRoot } = await setup()
    await writeWorkspace(dshHome, [{ id: 'dhs1', path: project }])
    const guard = new SessionDurabilityGuard({ dshHome, backupRoot })
    await guard.captureBaseline()
    const id = 'import-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const dir = join(dshHome, 'sessions', '--D-vibecoding-DHS1--', id)
    await mkdir(dir, { recursive: true })
    const frames = [
      { type: 'session', version: 0, id, createdAt: 1700000000000, cwd: project },
      { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '昨晚的记录' }] } },
    ]
    await writeFile(join(dir, 'session.jsonl.zstd'), Buffer.concat(frames.map(value => zstdCompressSync(Buffer.from(`${JSON.stringify(value)}\n`)))))

    const report = await guard.verifyForRestart()

    expect(report.safe).toBe(true)
    expect(report.repairedSessionIds).toContain(id)
    const index = JSON.parse(await readFile(join(dshHome, 'storages', 'session_projcache', 'sessions', `session-${id}.json`), 'utf8')) as { record: { identity: { cwd: string }; rows: { title: { val: string } } } }
    expect(index.record.identity.cwd).toBe(project)
    expect(index.record.rows.title.val).toBe('昨晚的记录')
    await expect(workspaceSessionIds(dshHome, 'dhs1')).resolves.toContain(`session-${id}`)
  })

  it('blocks restart when a new transcript has no session index', async () => {
    const { dshHome, backupRoot } = await setup()
    await writeWorkspace(dshHome, [{ id: 'dhs1', path: project }])
    const guard = new SessionDurabilityGuard({ dshHome, backupRoot })
    await guard.captureBaseline()
    const id = '11111111-1111-4111-8111-111111111111'
    await writeTranscript(dshHome, id)

    await expect(guard.verifyForRestart()).resolves.toMatchObject({
      safe: false,
      checkedSessionIds: [id],
      blockers: [{ sessionId: id, reason: 'missing-index' }],
    })
  })

  it('blocks restart when a new index has no transcript', async () => {
    const { dshHome, backupRoot } = await setup()
    await writeWorkspace(dshHome, [{ id: 'dhs1', path: project }])
    const guard = new SessionDurabilityGuard({ dshHome, backupRoot })
    await guard.captureBaseline()
    const id = '22222222-2222-4222-8222-222222222222'
    await writeIndex(dshHome, id)

    await expect(guard.verifyForRestart()).resolves.toMatchObject({
      safe: false,
      checkedSessionIds: [id],
      blockers: [{ sessionId: id, reason: 'missing-transcript' }],
    })
  })

  it('checks an existing session again when its transcript is changed after the baseline', async () => {
    const { dshHome, backupRoot } = await setup()
    await writeWorkspace(dshHome, [{ id: 'dhs1', path: project, sessionIds: ['session-77777777-7777-4777-8777-777777777777'] }])
    const id = '77777777-7777-4777-8777-777777777777'
    await writeCompleteSession(dshHome, id)
    const guard = new SessionDurabilityGuard({ dshHome, backupRoot })
    await guard.captureBaseline()
    await new Promise(resolve => setTimeout(resolve, 5))
    await writeTranscript(dshHome, id)
    await writeIndex(dshHome, id)

    await expect(guard.verifyForRestart()).resolves.toMatchObject({
      safe: true,
      checkedSessionIds: [id],
    })
  })

  it('blocks restart when a new index is malformed', async () => {
    const { dshHome, backupRoot } = await setup()
    await writeWorkspace(dshHome, [{ id: 'dhs1', path: project }])
    const guard = new SessionDurabilityGuard({ dshHome, backupRoot })
    await guard.captureBaseline()
    const id = '33333333-3333-4333-8333-333333333333'
    await writeTranscript(dshHome, id)
    const indexPath = join(dshHome, 'storages', 'session_projcache', 'sessions', `session-${id}.json`)
    await mkdir(join(indexPath, '..'), { recursive: true })
    await writeFile(indexPath, '{not-json', 'utf8')

    await expect(guard.verifyForRestart()).resolves.toMatchObject({
      safe: false,
      blockers: [{ sessionId: id, reason: 'invalid-index' }],
    })
  })

  it('atomically records a new complete session in its sole matching workspace', async () => {
    const { dshHome, backupRoot } = await setup()
    await writeWorkspace(dshHome, [{ id: 'dhs1', path: project }])
    const guard = new SessionDurabilityGuard({ dshHome, backupRoot })
    await guard.captureBaseline()
    const id = '44444444-4444-4444-8444-444444444444'
    await writeCompleteSession(dshHome, id)

    const report = await guard.verifyForRestart()

    expect(report).toMatchObject({ safe: true, checkedSessionIds: [id], repairedSessionIds: [id] })
    expect(report.backupPath).toEqual(expect.any(String))
    await expect(access(join(report.backupPath as string, 'workspace.json'))).resolves.toBeUndefined()
    await expect(workspaceSessionIds(dshHome, 'dhs1')).resolves.toContain(`session-${id}`)
  })

  it('blocks restart rather than guessing when no workspace owns the session cwd', async () => {
    const { dshHome, backupRoot } = await setup()
    await writeWorkspace(dshHome, [{ id: 'other', path: 'D:\\vibecoding\\other' }])
    const guard = new SessionDurabilityGuard({ dshHome, backupRoot })
    await guard.captureBaseline()
    const id = '55555555-5555-4555-8555-555555555555'
    await writeCompleteSession(dshHome, id)

    await expect(guard.verifyForRestart()).resolves.toMatchObject({
      safe: false,
      blockers: [{ sessionId: id, reason: 'missing-workspace' }],
    })
  })

  it('blocks restart rather than choosing between duplicate workspace paths', async () => {
    const { dshHome, backupRoot } = await setup()
    await writeWorkspace(dshHome, [{ id: 'first', path: project }, { id: 'second', path: project }])
    const guard = new SessionDurabilityGuard({ dshHome, backupRoot })
    await guard.captureBaseline()
    const id = '66666666-6666-4666-8666-666666666666'
    await writeCompleteSession(dshHome, id)

    await expect(guard.verifyForRestart()).resolves.toMatchObject({
      safe: false,
      blockers: [{ sessionId: id, reason: 'ambiguous-workspace' }],
    })
  })
})
