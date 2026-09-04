import { describe, expect, it, vi } from 'vitest'
import { buildStatusPanelMenu } from '../src/main/status-panel-menu.js'

describe('status panel application menu', () => {
  it('replaces the default menu with the single Chinese status-panel entry', () => {
    const onToggle = vi.fn()
    const menu = buildStatusPanelMenu(onToggle)

    expect(menu).toHaveLength(1)
    expect(menu[0]?.label).toBe('状态栏')

    ;(menu[0]?.click as (() => void) | undefined)?.()
    expect(onToggle).toHaveBeenCalledOnce()
  })
})
