import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildDshLaunchArgs, isHealthyHarnessResponse } from './runtime-controller.js'
import { runtimeProvidesBuiltInClientStore } from './compatibility.js'
import { findAvailablePort } from './ports.js'

function parseAdvertisedUrl(output: string, port: number): string | null {
  const match = output.match(new RegExp(`https?://127\\.0\\.0\\.1:${port}\\/?\\?token=[A-Za-z0-9_-]+`))
  return match?.[0] ?? null
}

export interface ValidateDshRuntimeOptions {
  runtimeRoot: string
  nodeExecutable: string
  dshHome: string
  /** Use the supplied home when it contains a candidate profile to validate. */
  useProvidedHome?: boolean
  /** Prepare an isolated home before the runtime reads its profile. */
  prepareValidationHome?: (validationHome: string, runtimeRoot: string) => Promise<void>
  findAvailablePortImpl?: () => Promise<number>
  spawnImpl?: typeof spawn
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  pollIntervalMs?: number
}

/** Reject the known 0.1.2 collision before starting a candidate runtime. */
async function hasStaticClientStoreCollision(runtimeRoot: string, dshHome: string): Promise<boolean> {
  try {
    const runtimePackage = JSON.parse(await readFile(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as { version?: unknown }
    if (!runtimeProvidesBuiltInClientStore(typeof runtimePackage.version === 'string' ? runtimePackage.version : undefined)) return false
    const profile = JSON.parse(await readFile(join(dshHome, 'profiles', 'web', 'package.json'), 'utf8')) as {
      dsh?: { profile?: { bundles?: unknown } }
    }
    return Array.isArray(profile.dsh?.profile?.bundles) && profile.dsh.profile.bundles.includes('@deepseek-ai/dsh-client-store')
  } catch {
    return false
  }
}

export function isHealthyHarnessDocument(status: number, body: string): boolean {
  if (status < 200 || status >= 300) return false
  return !/failed to load plugins|failed to apply loader entry/i.test(body)
}

export async function validateDshRuntime(options: ValidateDshRuntimeOptions): Promise<boolean> {
  const port = await (options.findAvailablePortImpl ?? findAvailablePort)()
  const ownsValidationHome = options.useProvidedHome !== true
  const validationHome = ownsValidationHome
    ? await mkdtemp(join(tmpdir(), 'dsh-runtime-validation-'))
    : options.dshHome
  try {
    await options.prepareValidationHome?.(validationHome, options.runtimeRoot)
  } catch {
    if (ownsValidationHome) await rm(validationHome, { recursive: true, force: true })
    return false
  }
  if (await hasStaticClientStoreCollision(options.runtimeRoot, validationHome)) {
    if (ownsValidationHome) await rm(validationHome, { recursive: true, force: true })
    return false
  }
  const dshBin = join(options.runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  let advertisedUrl: string | null = null
  let advertisedOutput = ''
  const spawnProcess = options.spawnImpl ?? spawn
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const child = spawnProcess(options.nodeExecutable, buildDshLaunchArgs(dshBin, port), {
    cwd: options.runtimeRoot,
    env: { ...process.env, DSH_HOME: validationHome, DSH_DESKTOP_SUPERVISED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout?.on('data', chunk => {
    advertisedOutput += chunk.toString()
    advertisedUrl = advertisedUrl ?? parseAdvertisedUrl(advertisedOutput, port)
  })
  try {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000)
    while (Date.now() < deadline) {
      if (child.exitCode !== null) return false
      try {
        const requestedUrl = advertisedUrl ?? `http://127.0.0.1:${port}/`
        const response = await fetchImpl(requestedUrl, { redirect: 'manual', signal: AbortSignal.timeout(2_000) })
        if (response.status === 303) {
          const location = response.headers.get('location')
          if (location !== null) {
            const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
            const target = new URL(location, requestedUrl).toString()
            const documentResponse = await fetchImpl(target, {
              redirect: 'manual',
              signal: AbortSignal.timeout(2_000),
              ...(cookie === undefined ? {} : { headers: { cookie } }),
            })
            if (isHealthyHarnessDocument(documentResponse.status, await documentResponse.text())) return true
          }
        } else if (isHealthyHarnessResponse(response)) {
          const body = response.status === 200 ? await response.text() : ''
          if (response.status !== 200 || isHealthyHarnessDocument(response.status, body)) return true
        }
      } catch {
        // Wait until official plugins have mounted.
      }
      await sleep(options.pollIntervalMs ?? 250)
    }
    return false
  } finally {
    child.kill()
    if (ownsValidationHome) await rm(validationHome, { recursive: true, force: true })
  }
}
