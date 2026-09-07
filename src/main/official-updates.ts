import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeActiveRuntimePointer, type RuntimePaths } from './runtime-paths.js'
import type { UpdateStatus } from '../shared/types.js'

const PACKAGE_NAME = '@deepseek-ai/dsh'
const REGISTRY_URL = 'https://registry.npmjs.org/@deepseek-ai%2fdsh/latest'
export interface OfficialUpdateOptions {
  paths: RuntimePaths
  currentVersion: () => Promise<string>
  runNpm: (cwd: string, args: string[]) => Promise<void>
  healthValidate?: (candidateRoot: string) => Promise<boolean>
  fetchImpl?: typeof fetch
}

export class OfficialUpdateService {
  private readonly options: OfficialUpdateOptions
  private readonly fetchImpl: typeof fetch
  private status: UpdateStatus = {
    currentVersion: 'unknown',
    latestVersion: null,
    updateAvailable: false,
    checkedAt: null,
    error: null,
  }

  constructor(options: OfficialUpdateOptions) {
    this.options = options
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  getStatus(): UpdateStatus {
    return { ...this.status }
  }

  async check(): Promise<UpdateStatus> {
    const currentVersion = await this.options.currentVersion()
    try {
      const response = await this.fetchImpl(REGISTRY_URL, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error(`npm Registry returned ${response.status}`)
      const data = await response.json() as { version?: unknown }
      const latestVersion = typeof data.version === 'string' ? data.version : null
      this.status = {
        currentVersion,
        latestVersion,
        updateAvailable: latestVersion !== null && latestVersion !== currentVersion,
        checkedAt: new Date().toISOString(),
        error: latestVersion === null ? 'npm Registry response did not contain a version' : null,
      }
    } catch (error) {
      this.status = {
        ...this.status,
        currentVersion,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }
    }
    return this.getStatus()
  }

  async install(
    version = this.status.latestVersion ?? '',
    healthValidate = this.options.healthValidate ?? (async () => true),
  ): Promise<UpdateStatus> {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error('无效的官方 DSH 版本号')
    }
    const candidate = join(this.options.paths.userRuntimeRoot, 'versions', `dsh-${version}`)
    try {
      // Never destroy an existing candidate. Preserve it as evidence if a
      // retry is needed, then build the new candidate from an empty directory.
      try {
        await access(candidate)
        await rename(candidate, `${candidate}.previous-${Date.now()}`)
      } catch {
        // Candidate does not exist yet.
      }
      await mkdir(candidate, { recursive: true })
      await writeFile(join(candidate, 'package.json'), JSON.stringify({
        name: 'dsh-managed-runtime',
        private: true,
        dependencies: { [PACKAGE_NAME]: version },
      }, null, 2))
      await this.options.runNpm(candidate, ['install', '--no-audit', '--no-fund', '--loglevel=warn'])
      await access(join(candidate, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
      if (!await healthValidate(candidate)) {
        throw new Error('Candidate health validation failed; active runtime was kept')
      }

      await writeActiveRuntimePointer(this.options.paths, { root: candidate, version })
      await rm(this.options.paths.updateFailurePath ?? join(this.options.paths.userRuntimeRoot, 'update-failure.json'), { force: true })
      this.status = {
        ...this.status,
        currentVersion: version,
        latestVersion: version,
        updateAvailable: false,
        error: null,
      }
      return this.getStatus()
    } catch (error) {
      this.status = { ...this.status, error: error instanceof Error ? error.message : String(error) }
      const failurePath = this.options.paths.updateFailurePath ?? join(this.options.paths.userRuntimeRoot, 'update-failure.json')
      await writeFile(failurePath, JSON.stringify({ version, candidate, detail: this.status.error, recordedAt: new Date().toISOString() }, null, 2), 'utf8')
      throw error
    }
  }
}

export async function readInstalledDshVersion(root: string): Promise<string> {
  const file = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const data = JSON.parse(await readFile(file, 'utf8')) as { version?: unknown }
  return typeof data.version === 'string' ? data.version : 'unknown'
}
