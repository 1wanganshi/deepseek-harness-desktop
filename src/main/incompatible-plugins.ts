import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import YAML from 'yaml'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const START_MARKER = '# deepseek-harness-desktop: incompatible plugin entries disabled'
const END_MARKER = '# deepseek-harness-desktop: end incompatible plugin entries disabled'
const LEGACY_START_MARKER = '# deepseek-harness-desktop: incompatible task-board disabled'
const LEGACY_END_MARKER = '# deepseek-harness-desktop: end incompatible task-board disabled'
const TASK_BOARD_ID = 'web-ui-task-board'
const DOCTOR_ENTRY_ID = 'web-ui-doctor'
const PRE_RELEASE_INCOMPATIBLE_BUNDLES = [
  { bundle: 'dsh-vision-router', entryId: 'vision-router' },
  { bundle: 'dsh-browser-computer-use', entryId: 'browser-computer-use' },
] as const

export interface TaskBoardMitigationResult {
  changed: boolean
  taskBoardDisabled: boolean
}

export interface ProfilePatchNormalizationResult {
  changed: boolean
  path: string
}

/**
 * Normalize the user profile overlay before DHS reads it. Older desktop
 * builds could leave an empty document or a single mapping here, while DHS
 * requires a top-level YAML array on every boot.
 */
export async function normalizeProfilePatchFile(profilePath: string): Promise<ProfilePatchNormalizationResult> {
  const patchPath = join(profilePath, 'cordis.patch.yml')
  const changed = await withFileLock(patchPath, async () => {
    const rawPatch = await readOptional(patchPath)
    const source = rawPatch ?? '[]\n'
    const normalized = normalizeProfilePatchContent(source)
    if (rawPatch === normalized.content) return false
    if (normalized.parseFailed && source.trim().length > 0) {
      await backupCorruptPatch(patchPath, source)
    }
    await writeFileAtomic(patchPath, normalized.content, { mode: 0o600 })
    return true
  }, { waitMs: 10_000 })
  return { changed, path: patchPath }
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
  const requiresCompatibilityMitigation = isOlderThanTaskBoardCompatibleRuntime(options.runtimeVersion)
  const disabledEntryIds = [
    // This aggregate entry registers a machine-level supervisor which can
    // outlive the desktop process. The desktop host owns restart and repair.
    ...(usesAggregate ? [DOCTOR_ENTRY_ID] : []),
    ...(usesAggregate && requiresCompatibilityMitigation ? [TASK_BOARD_ID] : []),
    ...PRE_RELEASE_INCOMPATIBLE_BUNDLES
      .filter(({ bundle }) => requiresCompatibilityMitigation && bundles.includes(bundle))
      .map(({ entryId }) => entryId),
  ]
  const changed = await withFileLock(patchPath, async () => {
    const rawPatch = await readOptional(patchPath) ?? '[]\n'
    const normalized = normalizeProfilePatchContent(rawPatch)
    if (normalized.parseFailed && rawPatch.trim().length > 0) {
      await backupCorruptPatch(patchPath, rawPatch)
    }
    const withoutManagedOverride = removeManagedOverride(normalized.content)
    const nextPatch = disabledEntryIds.length > 0
      ? appendManagedOverride(withoutManagedOverride, disabledEntryIds)
      : withoutManagedOverride
    if (nextPatch === rawPatch) return false
    await writeFileAtomic(patchPath, nextPatch, { mode: 0o600 })
    return true
  }, { waitMs: 10_000 })
  return { changed, taskBoardDisabled: disabledEntryIds.includes(TASK_BOARD_ID) }
}

function isOlderThanTaskBoardCompatibleRuntime(version: string): boolean {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
  if (match === null) return true
  // Any prerelease (has -suffix) is below the stable 0.1.2 contract
  if (match[4] !== undefined) return true
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (major !== 0) return major < 0
  if (minor !== 1) return minor < 1
  return patch < 2
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

function normalizeProfilePatchContent(content: string): { content: string; parseFailed: boolean } {
  let parsed: unknown
  try {
    parsed = YAML.parse(content)
  } catch {
    // A broken overlay cannot be applied safely. The caller preserves the
    // original bytes before replacing it with an empty valid layer.
    return { content: '[]\n', parseFailed: true }
  }
  if (Array.isArray(parsed)) return { content, parseFailed: false }
  if (parsed === null || parsed === undefined) return { content: '[]\n', parseFailed: false }
  if (typeof parsed === 'object') {
    // A few pre-0.2 builds wrote one patch mapping instead of a list. Keep
    // that entry intact, but put it in the format accepted by current DHS.
    return { content: YAML.stringify([parsed]), parseFailed: false }
  }
  return { content: '[]\n', parseFailed: false }
}

async function backupCorruptPatch(patchPath: string, content: string): Promise<void> {
  const backupPath = `${patchPath}.corrupt-${Date.now()}-${process.pid}-${randomUUID()}.bak`
  await writeFileAtomic(backupPath, content, { mode: 0o600 })
}

function removeManagedOverride(content: string): string {
  const markers = [
    [START_MARKER, END_MARKER],
    [LEGACY_START_MARKER, LEGACY_END_MARKER],
  ] as const
  return markers.reduce((result, [start, end]) => {
    const pattern = new RegExp(`\\n?${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}\\n?`, 'g')
    return result.replace(pattern, '')
  }, content).trimEnd() + '\n'
}

function appendManagedOverride(content: string, entryIds: string[]): string {
  const base = content.trimEnd().replace(/(?:^|\n)\[\]\s*$/, '').trimEnd()
  const rows = base === '[]' || base === '' ? '' : `${base}\n`
  const overrides = entryIds.map(id => `- id: ${id}\n  disabled: true`).join('\n')
  return `${rows}${START_MARKER}\n${overrides}\n${END_MARKER}\n`
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
