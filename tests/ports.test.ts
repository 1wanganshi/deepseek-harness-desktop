import { describe, expect, it } from 'vitest'
import { findAvailablePort, isLocalUrl } from '../src/main/ports.js'

describe('local runtime networking', () => {
  it('finds an available loopback port and returns a local URL', async () => {
    const port = await findAvailablePort()

    expect(port).toBeGreaterThan(0)
    expect(isLocalUrl(`http://127.0.0.1:${port}`)).toBe(true)
  })

  it('rejects non-loopback URLs before a web view can navigate to them', () => {
    expect(isLocalUrl('https://deepseek.com')).toBe(false)
    expect(isLocalUrl('http://192.168.1.10:3080')).toBe(false)
    expect(isLocalUrl('http://127.0.0.1:3080')).toBe(true)
  })
})
