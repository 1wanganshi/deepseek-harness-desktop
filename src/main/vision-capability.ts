import { access, readFile, rename, rm, writeFile } from 'node:fs/promises'
import YAML from 'yaml'

/**
 * Harness decides whether to offer an image attachment entry from each model's
 * declared `input` capabilities. OpenAI-compatible providers in the wild
 * routinely omit or mis-state that field (for example a model literally named
 * "...-vision" declaring only `text`), which silently removes image upload
 * from the UI even though the model accepts images.
 *
 * The only reliable source of truth is a real image round-trip, so this module
 * probes every configured model once and records the verdict. Probing never
 * mutates user configuration unless a capability difference is actually
 * confirmed, and vendor rejections ("vision is disabled for model") are cached
 * as negatives so a model is never mislabelled.
 */

type JsonRecord = Record<string, unknown>

export interface VisionProbeResult {
  /** Model id -> verified image support. */
  verdicts: Map<string, boolean>
  /** Model ids the provider explicitly rejected with a vision-not-supported error. */
  explicitlyDenied: Set<string>
}

export interface VisionCapabilityRepairResult {
  changed: boolean
  /** Models that gained image input. */
  added: string[]
  /** Models that had image input removed because the provider denied it. */
  removed: string[]
  /** Models probed but left untouched (no definitive verdict). */
  undetermined: string[]
}

interface ProbedModel {
  providerId: string
  baseURL: string
  apiKey: string | null
  modelId: string
}

const DENIAL_PATTERNS = [
  /vision is disabled/i,
  /不支持该能力[：:]\s*vision/i,
  /does not support (?:image|vision)/i,
  /not a vision model/i,
  /model does not support vision/i,
]

const PROBE_TIMEOUT_MS = 30_000

/** A 2x2 PNG: red, green, blue and white quadrants. */
const PROBE_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAHElEQVQI12P8z8Dwn4GBgYGJgYGBgYGBgQEAKqoDBSK5cQkAAAAASUVORK5CYII='

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function readProbeModels(settings: JsonRecord, credentials: JsonRecord | null): ProbedModel[] {
  const llmPiAi = isRecord(settings['llm-pi-ai']) ? settings['llm-pi-ai'] : null
  const providers = llmPiAi !== null && isRecord(llmPiAi.providers) ? llmPiAi.providers : null
  if (providers === null) return []
  const refs = credentials !== null && isRecord(credentials.refs) ? credentials.refs : null
  const models: ProbedModel[] = []
  for (const [providerId, rawProvider] of Object.entries(providers)) {
    if (!isRecord(rawProvider)) continue
    const baseURL = typeof rawProvider.baseURL === 'string' ? rawProvider.baseURL.replace(/\/+$/, '') : null
    if (baseURL === null) continue
    const apiKeyEnv = typeof rawProvider.apiKeyEnv === 'string' ? rawProvider.apiKeyEnv : null
    const apiKey = apiKeyEnv !== null && refs !== null && typeof refs[apiKeyEnv] === 'string'
      ? refs[apiKeyEnv] as string
      : null
    if (!Array.isArray(rawProvider.models)) continue
    for (const rawModel of rawProvider.models) {
      if (!isRecord(rawModel) || typeof rawModel.id !== 'string') continue
      models.push({ providerId, baseURL, apiKey, modelId: rawModel.id })
    }
  }
  return models
}

async function probeModel(model: ProbedModel): Promise<{ supported: boolean | null, denied: boolean }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (model.apiKey !== null) headers.Authorization = `Bearer ${model.apiKey}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`${model.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: model.modelId,
        max_tokens: 24,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'What colors are in this image? Answer with colors only.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${PROBE_IMAGE_BASE64}` } },
          ],
        }],
      }),
    })
    const text = await response.text()
    if (DENIAL_PATTERNS.some(pattern => pattern.test(text))) return { supported: false, denied: true }
    if (!response.ok) return { supported: null, denied: false }
    let payload: unknown
    try {
      payload = JSON.parse(text) as unknown
    } catch {
      return { supported: null, denied: false }
    }
    if (!isRecord(payload) || !Array.isArray(payload.choices)) return { supported: null, denied: false }
    const first = payload.choices[0]
    const content = isRecord(first) && isRecord(first.message) && typeof first.message.content === 'string'
      ? first.message.content
      : ''
    // An empty answer means the image was dropped rather than understood.
    if (content.trim() === '') return { supported: false, denied: false }
    return { supported: /\b(red|green|blue|white)\b|红|绿|蓝|白/i.test(content), denied: false }
  } catch {
    // Network failure or timeout carries no capability information.
    return { supported: null, denied: false }
  } finally {
    clearTimeout(timer)
  }
}

/** Probing every model on each launch is too expensive; cache verdicts on disk. */
const CACHE_FILE = 'vision-probe-cache.json'

interface VisionProbeCache {
  [modelKey: string]: boolean
}

async function readCache(dshHome: string): Promise<VisionProbeCache> {
  try {
    const parsed = JSON.parse(await readFile(`${dshHome}/${CACHE_FILE}`, 'utf8')) as unknown
    if (!isRecord(parsed)) return {}
    const cache: VisionProbeCache = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') cache[key] = value
    }
    return cache
  } catch {
    return {}
  }
}

async function probeAll(models: ProbedModel[]): Promise<VisionProbeResult> {
  const verdicts = new Map<string, boolean>()
  const explicitlyDenied = new Set<string>()
  const concurrency = 4
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, models.length) }, async () => {
    while (index < models.length) {
      const current = models[index]
      index += 1
      const { supported, denied } = await probeModel(current)
      if (denied) explicitlyDenied.add(current.modelId)
      if (supported !== null) verdicts.set(current.modelId, supported)
    }
  })
  await Promise.all(workers)
  return { verdicts, explicitlyDenied }
}

/**
 * Probe every configured model and align its declared `input` capabilities with
 * the verified reality. Models the providers could not be reached for are left
 * exactly as the user configured them.
 */
export async function repairVisionCapabilities(
  dshHome: string,
  options: { probe?: (models: ProbedModel[]) => Promise<VisionProbeResult>, force?: boolean } = {},
): Promise<VisionCapabilityRepairResult> {
  const settingsPath = `${dshHome}/settings.yaml`
  if (!(await pathExists(settingsPath))) return { changed: false, added: [], removed: [], undetermined: [] }

  const document = YAML.parseDocument(await readFile(settingsPath, 'utf8'))
  if (document.errors.length > 0) {
    throw new Error(`settings.yaml 包含无效 YAML：${document.errors[0]?.message ?? '未知语法错误'}`)
  }
  const settings = document.toJSON()
  if (!isRecord(settings)) return { changed: false, added: [], removed: [], undetermined: [] }

  const credentialsPath = `${dshHome}/.credentials.yaml`
  let credentials: JsonRecord | null = null
  if (await pathExists(credentialsPath)) {
    try {
      const parsed = YAML.parse(await readFile(credentialsPath, 'utf8')) as unknown
      credentials = isRecord(parsed) ? parsed : null
    } catch {
      credentials = null
    }
  }

  const models = readProbeModels(settings, credentials)
  if (models.length === 0) return { changed: false, added: [], removed: [], undetermined: [] }

  const cache = await readCache(dshHome)
  const providers = (isRecord(settings['llm-pi-ai']) && isRecord(settings['llm-pi-ai'].providers))
    ? settings['llm-pi-ai'].providers as JsonRecord
    : null
  if (providers === null) return { changed: false, added: [], removed: [], undetermined: [] }

  // Only probe models whose verdict is not already known.
  const unknown = options.force === true
    ? models
    : models.filter(model => cache[model.modelId] === undefined)
  const probed = unknown.length > 0
    ? await (options.probe ?? probeAll)(unknown)
    : { verdicts: new Map<string, boolean>(), explicitlyDenied: new Set<string>() }

  const verdicts = new Map<string, boolean>(Object.entries(cache))
  for (const [id, value] of probed.verdicts) verdicts.set(id, value)

  const added: string[] = []
  const removed: string[] = []
  const undetermined: string[] = []

  for (const [providerId, rawProvider] of Object.entries(providers)) {
    if (!isRecord(rawProvider) || !Array.isArray(rawProvider.models)) continue
    for (const rawModel of rawProvider.models) {
      if (!isRecord(rawModel) || typeof rawModel.id !== 'string') continue
      const currentInput = Array.isArray(rawModel.input) ? rawModel.input.filter((v): v is string => typeof v === 'string') : ['text']
      const hasImage = currentInput.includes('image')
      const verdict = verdicts.get(rawModel.id)
      const denied = probed.explicitlyDenied.has(rawModel.id)
      if (denied && hasImage) {
        rawModel.input = currentInput.filter(value => value !== 'image')
        removed.push(`${providerId}/${rawModel.id}`)
        continue
      }
      if (verdict === true && !hasImage) {
        rawModel.input = [...currentInput, 'image']
        added.push(`${providerId}/${rawModel.id}`)
        continue
      }
      if (verdict === undefined) undetermined.push(`${providerId}/${rawModel.id}`)
    }
  }

  const nextCache: VisionProbeCache = { ...cache }
  for (const [id, value] of probed.verdicts) nextCache[id] = value
  for (const id of probed.explicitlyDenied) nextCache[id] = false
  await writeFile(`${dshHome}/${CACHE_FILE}`, `${JSON.stringify(nextCache, null, 2)}\n`, 'utf8').catch(() => undefined)

  if (added.length === 0 && removed.length === 0) {
    return { changed: false, added, removed, undetermined }
  }

  const temporaryPath = `${settingsPath}.desktop-vision-${process.pid}.tmp`
  try {
    await writeFile(temporaryPath, YAML.stringify(settings), 'utf8')
    await rename(temporaryPath, settingsPath)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
  return { changed: true, added: added.sort(), removed: removed.sort(), undetermined }
}
