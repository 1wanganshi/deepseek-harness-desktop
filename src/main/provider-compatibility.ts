import { access, readFile, rename, rm, writeFile } from 'node:fs/promises'
import YAML from 'yaml'

type JsonRecord = Record<string, unknown>

export interface ProviderCompatibilityRepairResult {
  changed: boolean
  providerIds: string[]
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasReasoningModel(provider: JsonRecord): boolean {
  if (!Array.isArray(provider.models)) return false
  return provider.models.some(model => isRecord(model) && isRecord(model.reasoningEfforts))
}

function providerNeedsCompatibilityRepair(provider: JsonRecord): boolean {
  return provider.api === 'openai-completions' && hasReasoningModel(provider)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Prevents reasoning requests from being serialized with a developer role for
 * OpenAI-compatible endpoints that only accept system/user/assistant roles.
 */
export async function repairOpenAiProviderCompatibility(settingsPath: string): Promise<ProviderCompatibilityRepairResult> {
  if (!(await pathExists(settingsPath))) return { changed: false, providerIds: [] }

  const document = YAML.parseDocument(await readFile(settingsPath, 'utf8'))
  if (document.errors.length > 0) {
    throw new Error(`settings.yaml 包含无效 YAML：${document.errors[0]?.message ?? '未知语法错误'}`)
  }
  const settings = document.toJSON()
  if (!isRecord(settings)) return { changed: false, providerIds: [] }
  const llmPiAi = isRecord(settings['llm-pi-ai']) ? settings['llm-pi-ai'] : null
  const providers = llmPiAi !== null && isRecord(llmPiAi.providers) ? llmPiAi.providers : null
  if (providers === null) return { changed: false, providerIds: [] }

  const providerIds: string[] = []
  for (const [providerId, rawProvider] of Object.entries(providers)) {
    if (!isRecord(rawProvider) || !providerNeedsCompatibilityRepair(rawProvider)) continue
    const compat = isRecord(rawProvider.compat) ? rawProvider.compat : {}
    if (compat.supportsDeveloperRole === false) continue
    rawProvider.compat = { ...compat, supportsDeveloperRole: false }
    providerIds.push(providerId)
  }
  if (providerIds.length === 0) return { changed: false, providerIds: [] }

  const temporaryPath = `${settingsPath}.desktop-provider-compat-${process.pid}.tmp`
  try {
    await writeFile(temporaryPath, YAML.stringify(settings), 'utf8')
    await rename(temporaryPath, settingsPath)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
  return { changed: true, providerIds: providerIds.sort() }
}
