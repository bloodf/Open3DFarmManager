import { describe, expect, test } from 'bun:test'
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
