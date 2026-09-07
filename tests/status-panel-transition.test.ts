import { describe, expect, it } from 'vitest'
import { createStatusPanelStateReconciler, createStatusPanelTransition } from '../src/renderer/status-panel-transition.js'

describe('status panel transition', () => {
  it('commits the rendered panel only after the native view is resized', async () => {
    const events: string[] = []
    let releaseResize!: () => void
    const resize = new Promise<void>(resolve => { releaseResize = resolve })
    const transition = createStatusPanelTransition(
      async expanded => {
        events.push(`resize:${expanded}`)
        await resize
      },
      expanded => events.push(`render:${expanded}`),
    )

    const pending = transition(true)
    await Promise.resolve()
    expect(events).toEqual(['resize:true'])

    releaseResize()
    await pending
    expect(events).toEqual(['resize:true', 'render:true'])
  })

  it('serializes a quick expand and collapse without exposing an intermediate overlap', async () => {
    const events: string[] = []
    const transition = createStatusPanelTransition(
      async expanded => { events.push(`resize:${expanded}`) },
      expanded => events.push(`render:${expanded}`),
    )

    const expand = transition(true)
    const collapse = transition(false)
    await Promise.all([expand, collapse])

    expect(events).toEqual([
      'resize:true',
      'render:true',
      'resize:false',
      'render:false',
    ])
  })

  it('reconciles a native menu state when its event was missed', async () => {
    let nativeExpanded = false
    const renderedStates: boolean[] = []
    const reconcile = createStatusPanelStateReconciler(
      async () => nativeExpanded,
      expanded => renderedStates.push(expanded),
    )

    await reconcile()
    nativeExpanded = true
    await reconcile()

    expect(renderedStates).toEqual([false, true])
  })
})
