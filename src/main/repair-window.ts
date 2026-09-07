import type { BrowserWindowConstructorOptions } from 'electron'

export function repairWindowOptions(): BrowserWindowConstructorOptions {
  return {
    width: 540,
    height: 650,
    minWidth: 480,
    minHeight: 560,
    title: 'DeepSeek Harness 维修',
    modal: false,
    show: false,
    backgroundColor: '#0b0e14',
  }
}
