import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { bundledPnpmScript } from '../src/main/command.js'

describe('bundled package manager', () => {
  it('resolves the portable pnpm script without generated absolute .cmd paths', () => {
    expect(bundledPnpmScript('C:/Program Files/DeepSeek Harness Desktop')).toBe(
      join('C:/Program Files/DeepSeek Harness Desktop', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    )
  })
})
