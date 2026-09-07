import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mergeLegacyProjectSessions } from '../src/main/session-merge.js'

const roots: string[] = []

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dhs1-session-merge-'))
  roots.push(root)
  return { root, legacyHome: join(root, 'legacy'), targetHome: join(root, 'target'), backupRoot: join(root, 'backups') }
}

async function writeSession(home: string, id: string, cwd: string, title: string, blob = `blob-${id}`) {
  const indexPath = join(home, 'storages', 'session_projcache', 'sessions', `session-${id}.json`)
  const blobPath = join(home, 'sessions', '--D-vibecoding-DHS1--', `session-${id}`, 'session.jsonl.zstd')
  await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await mkdir(join(home, 'sessions', '--D-vibecoding-DHS1--', `session-${id}`), { recursive: true })
  await writeFile(indexPath, JSON.stringify({ version: 4, record: { identity: { cwd }, rows: { title: { val: title } } } }), 'utf8')
  await writeFile(blobPath, blob, 'utf8')
  return { indexPath, blobPath }
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('mergeLegacyProjectSessions', () => {
  it('replaces a legacy imported workspace id with the canonical id', async () => {
    const { legacyHome, targetHome, backupRoot } = await setup()
    const project = 'D:\\vibecoding\\DHS1'
    const id = 'import-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await writeSession(legacyHome, id, project, 'DHS1 imported')
    await mkdir(join(legacyHome, 'storages'), { recursive: true })
    await writeFile(join(legacyHome, 'storages', 'workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { workspaceIds: ['workspace-dhs1'] },
      tables: { workspaces: { 'workspace-dhs1': { path: project, title: 'DHS1', sessionIds: [id] } } },
    }), 'utf8')

    await mergeLegacyProjectSessions({ legacyHome, targetHome, projectCwd: project, backupRoot })

    const workspace = JSON.parse(await readFile(join(targetHome, 'storages', 'workspace.json'), 'utf8'))
    expect(workspace.tables.workspaces['workspace-dhs1'].sessionIds).toEqual([`session-${id}`])
  })

  it('restores the matching workspace mapping and session ids', async () => {
    const { legacyHome, targetHome, backupRoot } = await setup()
    const project = 'D:\\vibecoding\\DHS1'
    const source = await writeSession(legacyHome, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', project, 'DHS1 workspace')
    await mkdir(join(legacyHome, 'storages'), { recursive: true })
    await writeFile(join(legacyHome, 'storages', 'workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { workspaceIds: ['workspace-dhs1'] },
      tables: { workspaces: { 'workspace-dhs1': { path: project, title: 'DHS1', sessionIds: [`session-${source.indexPath.split('session-')[1].replace('.json', '')}`] } } },
    }), 'utf8')
    const result = await mergeLegacyProjectSessions({ legacyHome, targetHome, projectCwd: project, backupRoot })
    expect(result.status).toBe('merged')
    expect(result.workspaceUpdated).toBe(true)
    expect(result.workspaceId).toBe('workspace-dhs1')
    const workspace = JSON.parse(await readFile(join(targetHome, 'storages', 'workspace.json'), 'utf8'))
    expect(workspace.global.workspaceIds).toContain('workspace-dhs1')
    expect(workspace.tables.workspaces['workspace-dhs1'].path).toBe(project)
    expect(workspace.tables.workspaces['workspace-dhs1'].sessionIds).toContain('session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  })

  it('copies only DHS1 sessions and is idempotent', async () => {
    const { legacyHome, targetHome, backupRoot } = await setup()
    const project = 'D:\\vibecoding\\DHS1'
    const source = await writeSession(legacyHome, '11111111-1111-4111-8111-111111111111', project, 'DHS1 yesterday')
    await writeSession(legacyHome, '22222222-2222-4222-8222-222222222222', 'D:\\vibecoding\\other-project', 'Other project')
    await mkdir(join(targetHome, 'storages', 'session_projcache', 'sessions'), { recursive: true })

    const first = await mergeLegacyProjectSessions({ legacyHome, targetHome, projectCwd: project, backupRoot })
    expect(first.status).toBe('merged')
    expect(first.sourceSessionIds).toEqual(['11111111-1111-4111-8111-111111111111'])
    expect(first.copiedSessionIds).toEqual(['11111111-1111-4111-8111-111111111111'])
    await expect(readFile(join(targetHome, 'storages', 'session_projcache', 'sessions', 'session-11111111-1111-4111-8111-111111111111.json'), 'utf8')).resolves.toContain('DHS1 yesterday')
    await expect(readFile(join(targetHome, 'sessions', '--D-vibecoding-DHS1--', 'session-11111111-1111-4111-8111-111111111111', 'session.jsonl.zstd'), 'utf8')).resolves.toBe('blob-11111111-1111-4111-8111-111111111111')
    await expect(access(join(targetHome, 'storages', 'session_projcache', 'sessions', 'session-22222222-2222-4222-8222-222222222222.json'))).rejects.toThrow()
    await expect(readFile(source.indexPath, 'utf8')).resolves.toContain('DHS1 yesterday')

    const second = await mergeLegacyProjectSessions({ legacyHome, targetHome, projectCwd: project, backupRoot })
    expect(second.status).toBe('already-merged')
    expect(second.copiedSessionIds).toEqual([])
  })

  it('does not overwrite an existing target session', async () => {
    const { legacyHome, targetHome, backupRoot } = await setup()
    const project = 'D:\\vibecoding\\DHS1'
    const id = '33333333-3333-4333-8333-333333333333'
    await writeSession(legacyHome, id, project, 'legacy title', 'legacy blob')
    await writeSession(targetHome, id, project, 'target title', 'target blob')
    const result = await mergeLegacyProjectSessions({ legacyHome, targetHome, projectCwd: project, backupRoot })
    expect(result.status).toBe('already-merged')
    await expect(readFile(join(targetHome, 'storages', 'session_projcache', 'sessions', `session-${id}.json`), 'utf8')).resolves.toContain('target title')
    await expect(readFile(join(targetHome, 'sessions', '--D-vibecoding-DHS1--', `session-${id}`, 'session.jsonl.zstd'), 'utf8')).resolves.toBe('target blob')
  })

  it('returns not-found when the legacy home has no matching project', async () => {
    const { legacyHome, targetHome, backupRoot } = await setup()
    await writeSession(legacyHome, '44444444-4444-4444-8444-444444444444', 'D:\\vibecoding\\other-project', 'Other project')
    const result = await mergeLegacyProjectSessions({ legacyHome, targetHome, projectCwd: 'D:\\vibecoding\\DHS1', backupRoot })
    expect(result.status).toBe('not-found')
    expect(result.sourceSessionIds).toEqual([])
  })
})
