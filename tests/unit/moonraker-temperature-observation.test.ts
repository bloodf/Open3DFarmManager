import { describe, expect, it } from 'vitest'
import { parseTemperatureFields } from '../../packages/connector/src/moonraker/temperature-observation'

describe('parseTemperatureFields', () => {
  it.each([
    [
      { extruder: { temperature: 0 }, heater_bed: { temperature: 205 } },
      {
        tool: { kind: 'reading', celsius: 0 },
        bed: { kind: 'reading', celsius: 205 },
      },
    ],
    [
      { extruder: { temperature: -10 }, heater_bed: {} },
      { tool: { kind: 'reading', celsius: -10 }, bed: { kind: 'absent' } },
    ],
    [
      { extruder: {}, heater_bed: { temperature: null } },
      { tool: { kind: 'absent' }, bed: { kind: 'invalid' } },
    ],
    [
      { extruder: null, heater_bed: { temperature: '22' } },
      { tool: { kind: 'invalid' }, bed: { kind: 'invalid' } },
    ],
    [
      { heater_bed: { temperature: Number.NaN } },
      { tool: { kind: 'absent' }, bed: { kind: 'invalid' } },
    ],
    [
      { extruder: { temperature: Number.POSITIVE_INFINITY } },
      { tool: { kind: 'invalid' }, bed: { kind: 'absent' } },
    ],
    [
      {
        extruder: { temperature: 42, metadata: 'ignored' },
        unrelated: { temperature: 8 },
      },
      { tool: { kind: 'reading', celsius: 42 }, bed: { kind: 'absent' } },
    ],
  ])('parses selected values only', (input, expected) => {
    expect(parseTemperatureFields(input)).toEqual(expected)
  })

  it('does not mutate the source', () => {
    const input = {
      extruder: { temperature: 0, extra: 'kept' },
      heater_bed: { temperature: 205 },
    }
    parseTemperatureFields(input)
    expect(input).toEqual({
      extruder: { temperature: 0, extra: 'kept' },
      heater_bed: { temperature: 205 },
    })
  })

  it.each([null, 1, 'status', [], undefined])(
    'rejects malformed top-level status: %s',
    (input) => {
      expect(() => parseTemperatureFields(input)).toThrow(TypeError)
    },
  )
})
