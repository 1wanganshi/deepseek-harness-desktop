import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const START_MARKER = '# deepseek-harness-desktop: incompatible task-board disabled'
const END_MARKER = '# deepseek-harness-desktop: end incompatible task-board disabled'
const TASK_BOARD_ID = 'web-ui-task-board'

export interface TaskBoardMitigationResult {
  changed: boolean
  taskBoardDisabled: boolean
}

export async function mitigateIncompatibleTaskBoard(options: {
  profilePath: string
  runtimeVersion: string
}): Promise<TaskBoardMitigationResult> {
  const packagePath = join(options.profilePath, 'package.json')
  const patchPath = join(options.profilePath, 'cordis.patch.yml')
  const manifest = await readJson(packagePath)
  const bundles = readBundles(manifest)
  const usesAggregate = bundles.includes('@linxin666/dsh-web-all')
  const needsMitigation = usesAggregate && isOlderThanAlpha2(options.runtimeVersion)
  const currentPatch = await readOptional(patchPath) ?? '[]\n'
  const withoutManagedOverride = removeManagedOverride(currentPatch)
  const nextPatch = needsMitigation
    ? appendManagedOverride(withoutManagedOverride)
    : withoutManagedOverride
  if (nextPatch === currentPatch) return { changed: false, taskBoardDisabled: needsMitigation }
  await writeFile(patchPath, nextPatch, 'utf8')
  return { changed: true, taskBoardDisabled: needsMitigation }
}

function isOlderThanAlpha2(version: string): boolean {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?/) 
  if (match === null) return true
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (major !== 0) return major < 0
  if (minor !== 1) return minor < 1
  if (patch !== 2) return patch < 2
  if (match[4] === undefined) return false
  if (match[4] !== 'alpha') return false
  return Number(match[5]) < 2
}

function readBundles(manifest: Record<string, unknown>): string[] {
  const dsh = asRecord(manifest.dsh)
  const profile = asRecord(dsh.profile)
  return Array.isArray(profile.bundles) ? profile.bundles.filter((value): value is string => typeof value === 'string') : []
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try { return asRecord(JSON.parse(await readFile(path, 'utf8'))) } catch { return {} }
}

async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') } catch { return null }
}

function removeManagedOverride(content: string): string {
  const pattern = new RegExp(`\\n?${escapeRegex(START_MARKER)}[\\s\\S]*?${escapeRegex(END_MARKER)}\\n?`, 'g')
  return content.replace(pattern, '').trimEnd() + '\n'
}

function appendManagedOverride(content: string): string {
  const base = content.trimEnd().replace(/(?:^|\n)\[\]\s*$/, '').trimEnd()
  const rows = base === '[]' || base === '' ? '' : `${base}\n`
  return `${rows}${START_MARKER}\n- id: ${TASK_BOARD_ID}\n  disabled: true\n${END_MARKER}\n`
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
