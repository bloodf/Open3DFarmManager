import { describe, expect, it } from 'vitest'
import {
  kobraXInputs,
  kobraXMapping,
} from '../../apps/farm/app/utils/kobra-x-inputs.ts'

describe('Kobra X input selection', () => {
  it('maps observed holders and ACE slots to physical indices', () => {
    expect(
      kobraXInputs([
        { slot: '-1:0', materialType: 'PLA' },
        { slot: '-1:1' },
        { slot: '-1:2' },
        { slot: '0:0' },
        { slot: '0:1' },
        { slot: '0:2' },
        { slot: '0:3' },
      ]),
    ).toEqual([
      { id: 0, label: 'Suporte 1 — PLA' },
      { id: 1, label: 'Suporte 2' },
      { id: 2, label: 'Suporte 3' },
      { id: 4, label: 'ACE 1' },
      { id: 5, label: 'ACE 2' },
      { id: 6, label: 'ACE 3' },
      { id: 7, label: 'ACE 4' },
    ])
  })
  it('excludes empty and unknown inputs', () => {
    expect(
      kobraXInputs([
        { slot: '-1:0', remainingPercent: 0 },
        { slot: '-1:3' },
        { slot: '1:0' },
        { slot: '0:4' },
        { slot: 'ams:0:0' },
      ]),
    ).toEqual([])
    expect(kobraXInputs([{ slot: '0:0' }])).toEqual([])
    expect(kobraXInputs(undefined)).toEqual([])
  })
  it('maps ordered filament selections and rejects unavailable inputs', () => {
    const inputs = kobraXInputs(
      ['-1:0', '-1:1', '-1:2', '0:0', '0:1', '0:2', '0:3'].map((slot) => ({
        slot,
      })),
    )
    expect(
      kobraXMapping(['0', '1', '2', '4', '5', '6', '7'], 7, inputs),
    ).toEqual([0, 1, 2, 4, 5, 6, 7])
    expect(kobraXMapping(['4', '', '', '', '', '', ''], 1, inputs)).toEqual([4])
    expect(kobraXMapping(['0', '3'], 2, inputs)).toBeUndefined()
    expect(kobraXMapping(['0'], 2, inputs)).toBeUndefined()
    expect(kobraXMapping(['0'], 0, inputs)).toBeUndefined()
    expect(kobraXMapping(['0'], 8, inputs)).toBeUndefined()
  })
})
