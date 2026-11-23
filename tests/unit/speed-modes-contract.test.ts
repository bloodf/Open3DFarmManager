import { describe, expect, it } from 'vitest'
import { PrinterState } from '../../packages/farm-protocol/src/state.ts'
import { speedModeAllowed } from '../../packages/farm-protocol/src/control-actions.ts'
import { speedModeOptions } from '../../apps/farm/app/utils/farm-control-extended.ts'

describe('per-printer speed modes', () => {
  const printer = {
    printerKey: 'test',
    state: 'idle',
    progress: 0,
    observedAt: 1,
  } as const
  it('round trips a non-empty unique subset and rejects invalid advertisements', () => {
    const state = PrinterState.parse({
      ...printer,
      speedModes: ['silent', 'sport'],
    })
    expect(
      PrinterState.parse(JSON.parse(JSON.stringify(state))).speedModes,
    ).toEqual(['silent', 'sport'])
    for (const speedModes of [[], ['silent', 'silent'], ['fast']])
      expect(PrinterState.safeParse({ ...printer, speedModes }).success).toBe(
        false,
      )
  })
  it('refuses an unadvertised level and preserves the default', () => {
    expect(speedModeAllowed(['silent', 'sport'], 'ludicrous')).toBe(false)
    expect(speedModeAllowed(['silent', 'sport'], 'sport')).toBe(true)
    for (const mode of ['silent', 'standard', 'sport', 'ludicrous'])
      expect(speedModeAllowed(undefined, mode)).toBe(true)
  })
  it('offers advertised options or all options by default', () => {
    expect(
      speedModeOptions(['silent', 'sport']).map((option) => option.value),
    ).toEqual(['silent', 'sport'])
    expect(speedModeOptions(undefined).map((option) => option.value)).toEqual([
      'silent',
      'standard',
      'sport',
      'ludicrous',
    ])
  })
})
