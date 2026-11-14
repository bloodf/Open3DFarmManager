import { describe, expect, it } from 'vitest'
import { decodeCrealityStatus } from '../../packages/connector/src/creality/index.ts'

describe('Creality job telemetry', () => {
  it('maps a complete status frame', () => {
    expect(
      decodeCrealityStatus(
        JSON.stringify({
          printFileName: 'part.gcode',
          printProgress: 42,
          layer: 12,
          TotalLayer: 50,
          printJobTime: 120,
          printLeftTime: 60,
          model: 'K1',
          hostname: 'printer',
          modelVersion: '1.2',
        }),
      ),
    ).toEqual({
      filename: 'part.gcode',
      progress: 42,
      layer: 12,
      totalLayer: 50,
      printDuration: 120,
      estimatedRemainingSeconds: 60,
      model: 'K1',
      hostname: 'printer',
      firmwareVersion: '1.2',
    })
  })
  it('preserves absent fields', () => {
    expect(decodeCrealityStatus('{"printLeftTime":0}')).toEqual({
      estimatedRemainingSeconds: 0,
    })
  })
  it('ignores malformed fields', () => {
    expect(
      decodeCrealityStatus(
        JSON.stringify({
          printFileName: 'x'.repeat(256),
          printProgress: 101,
          layer: 1.5,
          TotalLayer: -1,
          printJobTime: '12',
          printLeftTime: -1,
          model: {},
          hostname: '\n',
          modelVersion: null,
        }),
      ),
    ).toEqual({})
  })
})
