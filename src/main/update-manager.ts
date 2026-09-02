import { access, cp, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, extname } from 'node:path'

export interface RuntimeUpdatePaths {
  activePath: string
  candidatePath: string
}

export class RuntimeUpdateManager {
  private readonly activePath: string
  private readonly candidatePath: string

  constructor(paths: RuntimeUpdatePaths) {
    this.activePath = paths.activePath
    this.candidatePath = paths.candidatePath
  }

  async activateCandidate(healthValidate: (path: string) => Promise<boolean>): Promise<void> {
    if (!await healthValidate(this.candidatePath)) {
      throw new Error('Candidate health validation failed; active runtime was kept')
    }

    const backupPath = `${this.activePath}.backup${extname(this.activePath)}`
    await mkdir(dirname(this.activePath), { recursive: true })
    await rm(backupPath, { recursive: true, force: true })
    const activeExists = await this.exists(this.activePath)
    if (activeExists) await cp(this.activePath, backupPath, { recursive: true, force: true })

    try {
      await rm(this.activePath, { recursive: true, force: true })
      await rename(this.candidatePath, this.activePath)
      if (activeExists) await rm(backupPath, { recursive: true, force: true })
    } catch (error) {
      await rm(this.activePath, { recursive: true, force: true })
      if (activeExists) await rename(backupPath, this.activePath)
      throw error
    }
  }

  async hasCandidate(): Promise<boolean> {
    return this.exists(this.candidatePath)
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }
}
