import { describe, expect, it } from 'vitest'
import { decodeBambuReport } from '../../packages/connector/src/bambu/report.ts'

describe('Bambu fan and light telemetry', () => {
  it('converts fan speeds and chamber light', () => {
    expect(
      decodeBambuReport({
        print: {
          cooling_fan_speed: '15',
          big_fan1_speed: 8,
          big_fan2_speed: '0',
          lights_report: [{ node: 'chamber_light', mode: 'off' }],
        },
      }),
    ).toEqual({
      kind: 'observation',
      fans: { part: 100, aux: 53, chamber: 0 },
      light: { chamber: false },
    })
  })
  it('omits invalid and absent values', () => {
    expect(
      decodeBambuReport({
        print: {
          cooling_fan_speed: 16,
          big_fan1_speed: '-1',
          lights_report: [{ node: 'chamber_light', mode: 'flashing' }],
        },
      }),
    ).toEqual({ kind: 'observation' })
  })
})
