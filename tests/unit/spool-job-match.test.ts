// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'vitest'
import {
  loadedSpoolSlots,
  rankSlots,
  rankSlotsForJob,
  type LoadedSlot,
} from '../../apps/farm/app/utils/spool-job-match.ts'
import type { SlotAssignment } from '../../apps/farm/app/utils/spool-features-types.ts'
import type { SpoolItem } from '../../apps/farm/app/utils/spool-library-types.ts'

const slot = (
  key: string,
  materialType: string | undefined,
  colorHex: string | undefined,
  remainingGrams?: number | null,
): LoadedSlot => ({
  key,
  label: key,
  materialType,
  colorHex,
  remainingGrams,
})
const red = { type: 'PLA', colour: '#FF0000', grams: 100 }
const keys = (ranked: { slot: LoadedSlot }[]) =>
  ranked.map((entry) => entry.slot.key)

describe('ranking', () => {
  test('material and colour come before the weight left', () => {
    const ranked = rankSlots(red, [
      slot('petg', 'PETG', 'FF0000FF', 900),
      slot('no-material', undefined, 'FF0000FF', 900),
      slot('blue', 'PLA', '0000FFFF', 900),
      slot('no-colour', 'PLA', undefined, 900),
      slot('exact-but-short', 'pla', 'ff0000', 10),
    ])
    expect(keys(ranked)).toEqual([
      'exact-but-short',
      'no-colour',
      'blue',
      'no-material',
      'petg',
    ])
    expect(ranked.map((entry) => entry.match.kind)).toEqual([
      'match',
      'colour-unknown',
      'colour-differs',
      'material-unknown',
      'material-differs',
    ])
  })

  test('an unknown weight stays unknown, between enough and short', () => {
    const ranked = rankSlots(red, [
      slot('empty', 'PLA', 'FF0000', 0),
      slot('short', 'PLA', 'FF0000', 99),
      slot('unknown', 'PLA', 'FF0000', null),
      slot('just-enough', 'PLA', 'FF0000', 100),
      slot('plenty', 'PLA', 'FF0000', 800),
    ])
    expect(keys(ranked)).toEqual([
      'plenty',
      'just-enough',
      'unknown',
      'short',
      'empty',
    ])
    expect(ranked[2]).toMatchObject({
      weight: 'unknown',
      remainingGrams: null,
      weightText: 'Peso restante não informado.',
    })
    expect(ranked[4]).toMatchObject({
      weight: 'short',
      weightText: 'Bobina sem filamento restante.',
    })
  })

  test.each([undefined, null, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'a weight of %s is not a weight',
    (value) => {
      expect(
        rankSlots(red, [slot('a', 'PLA', 'FF0000', value)])[0],
      ).toMatchObject({ weight: 'unknown', remainingGrams: null })
    },
  )

  test('without a stated need nothing is called enough', () => {
    const ranked = rankSlots({ type: 'PLA', colour: '#FF0000' }, [
      slot('unknown', 'PLA', 'FF0000'),
      slot('little', 'PLA', 'FF0000', 5),
      slot('more', 'PLA', 'FF0000', 500),
    ])
    expect(keys(ranked)).toEqual(['more', 'little', 'unknown'])
    expect(ranked[0]).toMatchObject({ weight: 'available' })
    expect(ranked[0]!.weightText).toContain('não informa quanto é preciso')
  })

  test('each filament of a job gets its own ranking', () => {
    const slots = [
      slot('b', 'PETG', '000000', 500),
      slot('a', 'PLA', 'FF0000', 500),
    ]
    const ranked = rankSlotsForJob(
      [red, { type: 'PETG', colour: '#000000' }],
      slots,
    )
    expect(ranked.map((entry) => keys(entry.candidates))).toEqual([
      ['a', 'b'],
      ['b', 'a'],
    ])
    expect(rankSlotsForJob([red], [])[0]!.candidates).toEqual([])
    expect(keys(rankSlots(red, slots.slice(1)))).toEqual(['a'])
    expect(slots.map((entry) => entry.key)).toEqual(['b', 'a'])
  })
})

test('loaded slots are the open bindings of live spools', () => {
  const spool = (id: number, extra: Partial<SpoolItem> = {}): SpoolItem => ({
    id,
    registered: '2026-01-01T00:00:00Z',
    filament: {
      id: 1,
      registered: '2026-01-01T00:00:00Z',
      material: 'PLA',
      color_hex: 'FF0000',
      density: 1.24,
      diameter: 1.75,
      extra: {},
    },
    used_weight: 0,
    used_length: 0,
    archived: false,
    extra: {},
    ...extra,
  })
  const binding = (
    spoolId: number,
    slotIndex: number,
    unassignedAt: number | null = null,
  ): SlotAssignment => ({
    id: String(slotIndex),
    spoolId,
    printerId: 'printer',
    slotKind: 'ams',
    slotIndex,
    assignedAt: 1,
    unassignedAt,
  })
  const loaded = loadedSpoolSlots(
    [
      binding(1, 0),
      binding(2, 1),
      binding(3, 2),
      binding(4, 3),
      binding(1, 4, 5),
    ],
    [
      spool(1, { remaining_weight: 300 }),
      spool(2),
      spool(3, { archived: true }),
    ],
  )
  expect(loaded.map((entry) => [entry.label, entry.remainingGrams])).toEqual([
    ['AMS 1', 300],
    ['AMS 2', null],
  ])
  expect(rankSlots(red, loaded).map((entry) => entry.weight)).toEqual([
    'enough',
    'unknown',
  ])
})
