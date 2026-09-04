import { describe, expect, it } from 'vitest'
import { desktopWebPreferences } from '../src/main/desktop-web-preferences.js'

describe('desktop preload configuration', () => {
  it('keeps the bridge isolated while allowing the ESM preload to load', () => {
    expect(desktopWebPreferences('C:/DHS/preload.js')).toEqual({
      preload: 'C:/DHS/preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    })
  })
})
