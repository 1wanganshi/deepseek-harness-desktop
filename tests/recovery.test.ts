import { describe, expect, it } from 'vitest'
import { RecoveryController } from '../src/main/recovery.js'

describe('runtime recovery controller', () => {
  it('uses bounded exponential backoff with jitter', () => {
    const controller = new RecoveryController({
      initialDelayMs: 1000,
      maxDelayMs: 5000,
      jitterRatio: 0,
      maxAttempts: 4,
    })

    expect(controller.nextDelay()).toBe(1000)
    expect(controller.nextDelay()).toBe(2000)
    expect(controller.nextDelay()).toBe(4000)
    expect(controller.nextDelay()).toBe(5000)
    expect(controller.nextDelay()).toBeNull()
  })

  it('resets the failure budget after a healthy run', () => {
    const controller = new RecoveryController({ maxAttempts: 2, jitterRatio: 0 })

    expect(controller.nextDelay()).not.toBeNull()
    expect(controller.nextDelay()).not.toBeNull()
    expect(controller.nextDelay()).toBeNull()

    controller.markHealthy()

    expect(controller.nextDelay()).not.toBeNull()
  })
})
