import { describe, expect, it } from 'vitest'
import {
  PrinterState,
  firmwareUpdateAvailable,
} from '../../packages/farm-protocol/src/state.ts'

const base = { printerKey: 'printer', state: 'offline', observedAt: 0 }

describe('firmware snapshot', () => {
  it('accepts absent and bounded firmware', () => {
    expect(PrinterState.safeParse(base).success).toBe(true)
    expect(
      PrinterState.safeParse({
        ...base,
        firmware: {
          current: '1'.repeat(64),
          components: Array(16).fill({ name: 'mcu', current: '1' }),
        },
      }).success,
    ).toBe(true)
  })
  it('rejects oversized values and components', () => {
    expect(
      PrinterState.safeParse({ ...base, firmware: { latest: 'x'.repeat(65) } })
        .success,
    ).toBe(false)
    expect(
      PrinterState.safeParse({
        ...base,
        firmware: { components: Array(17).fill({ name: 'mcu', current: '1' }) },
      }).success,
    ).toBe(false)
    expect(
      PrinterState.safeParse({
        ...base,
        firmware: { components: [{ name: 'mcu' }] },
      }).success,
    ).toBe(false)
  })
  it('compares numeric versions and leaves unknown ordering undecided', () => {
    expect(firmwareUpdateAvailable('1.9', '1.10')).toBe(true)
    expect(firmwareUpdateAvailable('2.0', '1.9')).toBe(false)
    expect(firmwareUpdateAvailable('v1.0', '1.0.0')).toBe(false)
    expect(firmwareUpdateAvailable('vendor-build', 'vendor-build')).toBe(false)
    expect(firmwareUpdateAvailable('vendor-a', 'vendor-b')).toBeUndefined()
    expect(firmwareUpdateAvailable(undefined, '1')).toBeUndefined()
  })
})
