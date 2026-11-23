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

  it.each([
    [
      { toolhead: { extruder: 'extruder2' }, extruder2: { temperature: 230 } },
      { kind: 'reading', celsius: 230 },
    ],
    [{ toolhead: { extruder: 'extruder' } }, { kind: 'reading', celsius: 210 }],
    [{ toolhead: { extruder: 'extruder3' } }, { kind: 'absent' }],
    [
      { toolhead: { extruder: 'extruder1' }, extruder1: { temperature: null } },
      { kind: 'invalid' },
    ],
    [
      { toolhead: { extruder: 'fan' }, fan: { temperature: 80 } },
      { kind: 'invalid' },
    ],
    [{}, { kind: 'invalid' }],
  ])(
    'reads only the selected extruder in a multi-tool query',
    (objects, tool) => {
      expect(
        parseTemperatureFields(
          {
            extruder: { temperature: 210 },
            heater_bed: { temperature: 60 },
            ...objects,
          },
          true,
        ),
      ).toEqual({ tool, bed: { kind: 'reading', celsius: 60 } })
    },
  )

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
