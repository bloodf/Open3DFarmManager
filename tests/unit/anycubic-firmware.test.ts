import { describe, expect, it } from 'vitest'
import { mapAnycubicFirmware } from '../../packages/connector/src/anycubic/firmware.ts'

describe('Anycubic firmware reports', () => {
  it('maps the reported version from direct and enveloped data', () => {
    expect(mapAnycubicFirmware({ version: '1.2.3' })).toEqual({
      current: '1.2.3',
    })
    expect(mapAnycubicFirmware({ data: { version: 'v2' } })).toEqual({
      current: 'v2',
    })
  })

  it('leaves absent or invalid versions absent', () => {
    for (const report of [
      null,
      [],
      {},
      { version: '' },
      { version: ' ' },
      { version: 42 },
      { version: 'x'.repeat(65) },
      { data: null },
    ]) {
      expect(mapAnycubicFirmware(report)).toBeUndefined()
    }
    expect(mapAnycubicFirmware({ version: 'x'.repeat(64) })).toEqual({
      current: 'x'.repeat(64),
    })
  })
})
