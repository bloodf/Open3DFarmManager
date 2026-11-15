import { describe, expect, it } from 'vitest'
import { decodeCrealityStatus } from '../../packages/connector/src/creality/index.ts'
import { mapCrealityFirmware } from '../../packages/connector/src/creality/firmware.ts'

describe('Creality firmware', () => {
  it('maps the version in a status frame without inventing update information', () => {
    const status = decodeCrealityStatus('{"modelVersion":"1.2.3"}')!
    expect(mapCrealityFirmware(status)).toEqual({ current: '1.2.3' })
  })

  it('leaves absent and invalid versions absent', () => {
    for (const version of [undefined, '', 'x'.repeat(65), '1\n2']) {
      expect(mapCrealityFirmware({ firmwareVersion: version })).toBeUndefined()
    }
    expect(mapCrealityFirmware({ firmwareVersion: 'x'.repeat(64) })).toEqual({
      current: 'x'.repeat(64),
    })
  })
})
