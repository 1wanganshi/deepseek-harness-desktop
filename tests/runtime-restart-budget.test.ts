import { describe, expect, it } from 'vitest'
import { RuntimeRestartBudget } from '../src/main/runtime-controller.js'

describe('runtime restart budget', () => {
  it('latches after three starts that died inside the stability window', () => {
    let now = 0
    const budget = new RuntimeRestartBudget({ now: () => now })

    for (let attempt = 0; attempt < 3; attempt += 1) {
      budget.beginAttempt()
      now += 5_000
      budget.noteUnhealthy('Harness 进程已退出（code=1, signal=none）')
    }

    const decision = budget.shouldAttempt()
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('3 次')
    expect(budget.blocked).toBe(true)
  })

  it('clears the failure streak when a start is observed healthy', () => {
    let now = 0
    const budget = new RuntimeRestartBudget({ now: () => now })

    budget.beginAttempt()
    budget.noteUnhealthy('boom')
    now += 5_000
    budget.beginAttempt()
    budget.noteUnhealthy('boom')

    // The runtime served a session, so the two deaths mean nothing any more.
    budget.observeHealthy()
    expect(budget.blocked).toBe(false)

    now += 5_000
    budget.beginAttempt()
    budget.noteUnhealthy('boom')

    expect(budget.shouldAttempt().allowed).toBe(true)
  })

  it('stays latched past the failure window until an explicit reset', () => {
    let now = 0
    const budget = new RuntimeRestartBudget({ now: () => now })

    for (let attempt = 0; attempt < 3; attempt += 1) {
      budget.beginAttempt()
      budget.noteUnhealthy('boom')
    }
    expect(budget.blocked).toBe(true)

    // Ten minutes later the streak is stale, but only the user may clear it:
    // an automatic retry here is exactly the boot loop this exists to stop.
    now += 10 * 60_000
    expect(budget.shouldAttempt().allowed).toBe(false)

    budget.reset()
    expect(budget.blocked).toBe(false)
    expect(budget.shouldAttempt().allowed).toBe(true)
  })

  it('releases the latch after two clean probes long after the last death', () => {
    let now = 0
    const budget = new RuntimeRestartBudget({ now: () => now })

    for (let attempt = 0; attempt < 3; attempt += 1) {
      budget.beginAttempt()
      budget.noteUnhealthy('boom')
    }
    expect(budget.blocked).toBe(true)

    // The runtime is up and answering, but it only just started dying.
    now += 10_000
    budget.noteVerifiedHealthy()
    budget.noteVerifiedHealthy()
    expect(budget.blocked).toBe(true)

    // Well past the stability window, two clean probes are proof enough.
    now += 60_000
    budget.noteVerifiedHealthy()
    budget.noteVerifiedHealthy()
    expect(budget.blocked).toBe(false)
    expect(budget.shouldAttempt().allowed).toBe(true)
  })

  it('does not release a latch on a single healthy probe', () => {
    let now = 0
    const budget = new RuntimeRestartBudget({ now: () => now })

    for (let attempt = 0; attempt < 3; attempt += 1) {
      budget.beginAttempt()
      budget.noteUnhealthy('boom')
    }
    now += 120_000
    budget.noteVerifiedHealthy()

    expect(budget.blocked).toBe(true)
  })
})
