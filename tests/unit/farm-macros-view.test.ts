import { describe, expect, it } from 'vitest'
import {
  filamentTrays,
  macroActions,
  macroArgs,
} from '../../apps/farm/app/utils/farm-macros.ts'
import type { PrinterState } from '../../packages/farm-protocol/src/state.ts'

describe('macros and filament controls', () => {
  const state: PrinterState = {
    printerKey: 'printer',
    state: 'idle',
    progress: 0,
    observedAt: 1,
    controls: ['run_macro', 'load_filament'],
    macros: ['PURGE'],
    materials: [{ slot: 'ams:2:3', materialType: 'PLA' }, { slot: 'external' }],
  }
  it('exposes only advertised actions and validates macro names', () => {
    expect(macroActions(state)).toEqual({
      macros: ['PURGE'],
      load: true,
      unload: false,
    })
    expect(macroArgs(state, 'PURGE')).toEqual({ name: 'PURGE' })
    expect(macroArgs(state, 'OTHER')).toBeUndefined()
    expect(macroArgs({ ...state, controls: [] }, 'PURGE')).toBeUndefined()
    expect(macroActions(undefined)).toEqual({
      macros: [],
      load: false,
      unload: false,
    })
  })
  it('maps advertised AMS slots to tray indices', () => {
    expect(filamentTrays(state)).toEqual([{ id: 11, label: 'ams:2:3 — PLA' }])
  })
})
