import { expect, it } from 'vitest'
import { PrinterState } from '@open3dfarmmanager/farm-protocol'

it('round-trips bounded alarm codes and rejects oversized or free-text summaries', () => {
  const state = {
    printerKey: 'bambu',
    state: 'printing' as const,
    progress: 0.5,
    observedAt: 1_800_000_000_000,
  }
  const alarms = {
    printError: 'FFFF-FFFF',
    hmsCount: 64,
    hmsCode: 'FFFF-FFFF-FFFF-FFFF',
  }
  expect(PrinterState.parse({ ...state, alarms })).toEqual({
    ...state,
    alarms,
  })
  for (const invalid of [
    { ...alarms, printError: 'FFFF-FFFFF' },
    { ...alarms, hmsCode: 'FFFF-FFFF-FFFF-FFFFF' },
    { ...alarms, hmsCount: 65 },
    { ...alarms, text: 'Printer reported an error' },
  ]) {
    expect(PrinterState.safeParse({ ...state, alarms: invalid }).success).toBe(
      false,
    )
  }
})
