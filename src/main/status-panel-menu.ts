import type { MenuItemConstructorOptions } from 'electron'

export function buildStatusPanelMenu(onToggle: () => void): MenuItemConstructorOptions[] {
  return [{ label: '状态栏', click: onToggle }]
}
