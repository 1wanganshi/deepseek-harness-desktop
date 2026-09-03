import { describe, expect, it } from 'vitest'
import { createHarnessLoader } from '../src/main/harness-loader.js'

describe('harness web view loader', () => {
  it('serializes duplicate running-state loads for the same URL', async () => {
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const loader = createHarnessLoader(
      async url => {
        events.push(`load:${url}`)
        await gate
      },
      visible => events.push(`visible:${visible}`),
    )
    loader.setDesiredUrl('http://127.0.0.1:3080')
    const first = loader.load('http://127.0.0.1:3080')
    const second = loader.load('http://127.0.0.1:3080')
    await Promise.resolve()
    expect(events).toEqual(['load:http://127.0.0.1:3080'])

    release()
    await Promise.all([first, second])
    expect(events).toEqual(['load:http://127.0.0.1:3080', 'visible:true'])
  })

  it('does not reveal a stale page when the runtime goes offline while loading', async () => {
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const loader = createHarnessLoader(
      async () => { await gate },
      visible => events.push(`visible:${visible}`),
    )
    loader.setDesiredUrl('http://127.0.0.1:3080')
    const pending = loader.load('http://127.0.0.1:3080')
    loader.setDesiredUrl(null)
    loader.clearLoadedUrl()

    release()
    await pending
    expect(events).toEqual(['visible:false'])
  })
})
