import { describe, expect, it } from 'vitest'
import { filamentTrays } from '../../apps/farm/app/utils/farm-macros.ts'
import { slotLabel } from '../../apps/farm/app/utils/spool-features-format.ts'
import {
  farmSlotLabel,
  slotBindingKey,
  verifiedSlotBindings,
} from '../../apps/farm/app/utils/slot-spools.ts'
import type { SpoolItem } from '../../apps/farm/app/utils/spool-library-types.ts'
import { ControlArguments } from '../../packages/farm-protocol/src/control-actions.ts'
import { buildBambuCommand } from '../../packages/connector/src/bambu/commands.ts'
import { decodeBambuAms } from '../../packages/connector/src/bambu/ams.ts'

/** AMS HT units 128 and 135 plus both external holders, as the Connector decodes them. */
const { materials } = decodeBambuAms({
  ams: {
    ams: [
      { id: '0', tray: [{ id: '1', tray_type: 'PLA' }] },
      { id: '128', tray: [{ id: '0', tray_type: 'PA-CF' }] },
      { id: '135', tray: [{ id: '0', tray_type: 'PETG' }] },
    ],
  },
  vir_slot: [
    { id: '255', tray_type: 'ABS' },
    { id: '254', tray_type: 'TPU' },
  ],
})
const state = { materials } as Parameters<typeof filamentTrays>[0]

describe('#881 AMS HT and two external holders', () => {
  it('labels every decoded slot in pt-BR', () => {
    expect(materials.map(({ slot }) => farmSlotLabel(slot))).toEqual([
      'AMS 1, bandeja 2',
      'AMS HT 1',
      'AMS HT 8',
      'Bobina externa',
      'Bobina externa 2',
    ])
    expect(slotLabel('ams', 128)).toBe('AMS HT 1')
    expect(slotLabel('ams', 135)).toBe('AMS HT 8')
    expect(slotLabel('ams', 136)).toBe('AMS 137')
  })

  it('gives each slot its own binding key and finds the bound spool', () => {
    expect(materials.map(({ slot }) => slotBindingKey(slot))).toEqual([
      'ams:1',
      'ams:128',
      'ams:135',
      'printer:0',
      'printer:1',
    ])
    const bound = verifiedSlotBindings(
      [
        {
          id: 'a',
          spoolId: 7,
          printerId: 'p',
          slotKind: 'printer',
          slotIndex: 1,
          assignedAt: 1,
          unassignedAt: null,
        },
      ],
      [
        {
          id: 7,
          remaining_weight: 250,
          initial_weight: 1000,
          filament: {},
        } as unknown as SpoolItem,
      ],
    ).get('p')
    expect(bound?.get(slotBindingKey('external:254'))).toEqual({
      remainingGrams: 250,
      initialGrams: 1000,
    })
    expect(bound?.get(slotBindingKey('external'))).toBeUndefined()
  })

  it('keeps slot ids outside the known ranges unknown', () => {
    for (const slot of [
      'ams:127:0',
      'ams:128:1',
      'ams:136:0',
      'external:253',
    ]) {
      expect(farmSlotLabel(slot)).toBe(slot)
      expect(slotBindingKey(slot)).toBe('printer:-1')
      expect(filamentTrays({ materials: [{ slot }] } as never)).toEqual([])
    }
  })

  it('offers AMS HT trays for loading, but no external holder', () => {
    expect(filamentTrays(state).map(({ id, label }) => [id, label])).toEqual([
      [1, 'ams:0:1 — PLA'],
      [128, 'AMS HT 1 — PA-CF'],
      [135, 'AMS HT 8 — PETG'],
    ])
  })

  it('signs every offered tray into the request the Connector builds', () => {
    for (const id of [1, 128, 135]) {
      expect(
        ControlArguments.safeParse({
          action: 'load_filament',
          args: { tray: id },
        }).success,
      ).toBe(true)
      expect(
        buildBambuCommand('load_filament', { tray: id, target_c: 220 }),
      ).toMatchObject({ print: { target: id } })
    }
    for (const tray of [16, 127, 128.5, 136, 254, 255])
      expect(
        ControlArguments.safeParse({
          action: 'load_filament',
          args: { tray },
        }).success,
      ).toBe(false)
  })
})
