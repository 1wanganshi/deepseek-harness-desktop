import { describe, expect, it } from 'vitest'
import { createRuntimeRestartGate } from '../src/main/harness-mount-recovery.js'

describe('runtime restart gate', () => {
  it('allows restarts up to the budget and then latches', async () => {
    let now = 0
    const restarts: number[] = []
    const latches: number[] = []
    const gate = createRuntimeRestartGate({
      maxRestarts: 2,
      windowMs: 1000,
      now: () => now,
      restart: () => { restarts.push(now) },
      onLatched: info => { latches.push(info.restartsInWindow) },
    })

    expect(await gate.restart()).toBe(true)
    expect(await gate.restart()).toBe(true)
    // Third attempt inside the same window is refused instead of looping.
    expect(await gate.restart()).toBe(false)
    expect(restarts).toHaveLength(2)
    expect(latches).toEqual([2])
    expect(gate.latched()).toBe(true)
  })

  it('resets the budget once the runtime is healthy again', async () => {
    let now = 0
    let count = 0
    const gate = createRuntimeRestartGate({
      maxRestarts: 1,
      windowMs: 1000,
      now: () => now,
      restart: () => { count += 1 },
    })

    expect(await gate.restart()).toBe(true)
    expect(await gate.restart()).toBe(false)
    // The runtime answered a health probe, so the loop is over.
    gate.markHealthy()
    expect(gate.latched()).toBe(false)
    expect(await gate.restart()).toBe(true)
    expect(count).toBe(2)
  })

  it('stays latched until an explicit health signal, even after the window passes', async () => {
    let now = 0
    const gate = createRuntimeRestartGate({
      maxRestarts: 1,
      windowMs: 1000,
      now: () => now,
      restart: () => undefined,
    })

    expect(await gate.restart()).toBe(true)
    expect(await gate.restart()).toBe(false)
    now = 5000
    // Latched means latched: a restart loop must stop until the runtime proves
    // healthy, otherwise a crashing session keeps cycling the whole app.
    expect(await gate.restart()).toBe(false)
    gate.markHealthy()
    expect(await gate.restart()).toBe(true)
  })
})
