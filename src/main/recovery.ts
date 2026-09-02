export interface RecoveryOptions {
  initialDelayMs?: number
  maxDelayMs?: number
  jitterRatio?: number
  maxAttempts?: number
  random?: () => number
}

export class RecoveryController {
  private readonly initialDelayMs: number
  private readonly maxDelayMs: number
  private readonly jitterRatio: number
  private readonly maxAttempts: number
  private readonly random: () => number
  private attempts = 0

  constructor(options: RecoveryOptions = {}) {
    this.initialDelayMs = options.initialDelayMs ?? 500
    this.maxDelayMs = options.maxDelayMs ?? 10_000
    this.jitterRatio = options.jitterRatio ?? 0.1
    this.maxAttempts = options.maxAttempts ?? 8
    this.random = options.random ?? Math.random
  }

  nextDelay(): number | null {
    if (this.attempts >= this.maxAttempts) return null
    const base = Math.min(this.maxDelayMs, this.initialDelayMs * (2 ** this.attempts))
    this.attempts += 1
    const jitter = 1 + ((this.random() * 2) - 1) * this.jitterRatio
    return Math.round(Math.min(this.maxDelayMs, base * jitter))
  }

  markHealthy(): void {
    this.attempts = 0
  }

  get attemptCount(): number {
    return this.attempts
  }
}
