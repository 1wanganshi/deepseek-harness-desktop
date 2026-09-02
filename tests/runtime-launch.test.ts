import { describe, expect, it } from 'vitest'
import { buildDshLaunchArgs } from '../src/main/runtime-controller.js'

describe('official DSH launch', () => {
  it('enables Node internals required by the official HMR plugin', () => {
    expect(buildDshLaunchArgs('C:/runtime/bin.js', 34567)).toEqual([
      '--expose-internals',
      'C:/runtime/bin.js',
      'web',
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      '34567',
    ])
  })
})
