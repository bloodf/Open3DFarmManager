import { describe, expect, test } from 'vitest'
import { PrinterState } from '@open3dfarmmanager/farm-protocol'
import { flagEnabled } from '@open3dfarmmanager/shared'

describe('configuration boundaries', () => {
  test.each([false, 'false', '0', 0, '', undefined, null, 'yes', {}])(
    'flags fail closed for %p',
    (value) => {
      expect(flagEnabled(value)).toBe(false)
    },
  )
  test.each([true, 'true', '1', 1])('flags accept %p', (value) =>
    expect(flagEnabled(value)).toBe(true),
  )
})
describe('printer state', () => {
  const state = {
    printerKey: 'sv06',
    state: 'printing' as const,
    progress: 0.5,
    observedAt: 1_800_000_000_000,
  }
  test('round-trips JSON', () =>
    expect(PrinterState.parse(JSON.parse(JSON.stringify(state)))).toEqual(
      state,
    ))
  test.each([-1, 1.01, NaN, Infinity])(
    'rejects invalid progress %p',
    (progress) => {
      expect(PrinterState.safeParse({ ...state, progress }).success).toBe(false)
    },
  )
  test('rejects command fields on status', () => {
    expect(PrinterState.safeParse({ ...state, action: 'pause' }).success).toBe(
      false,
    )
  })
})

test('temperature readings are optional finite display primitives, including zero and negatives', () => {
  const core = {
    printerKey: 'bedless',
    state: 'idle',
    progress: 0,
    observedAt: 100,
  }
  expect(PrinterState.parse(core)).toEqual(core)
  expect(
    PrinterState.parse({
      ...core,
      toolTemperatureCelsius: 0,
      bedTemperatureCelsius: -12.5,
    }),
  ).toEqual({
    ...core,
    toolTemperatureCelsius: 0,
    bedTemperatureCelsius: -12.5,
  })
  for (const value of [NaN, Infinity, -Infinity, '20', null]) {
    expect(
      PrinterState.safeParse({ ...core, toolTemperatureCelsius: value })
        .success,
    ).toBe(false)
    expect(
      PrinterState.safeParse({ ...core, bedTemperatureCelsius: value }).success,
    ).toBe(false)
  }
  expect(
    PrinterState.safeParse({ ...core, targetTemperatureCelsius: 200 }).success,
  ).toBe(false)
})
