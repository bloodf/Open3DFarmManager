import { describe, expect, it } from 'vitest'
import { SpoolmanSpool } from '../../packages/connector/src/spoolman/read.ts'
import {
  getSpoolmanMaterials,
  mapSpoolmanMaterial,
} from '../../packages/connector/src/runtime/spoolman-materials.ts'

const spool = SpoolmanSpool.parse({
  id: 3,
  filament: { id: 1, material: 'PLA', color_hex: 'aabbcc' },
  initial_weight: 1000,
  remaining_weight: 250,
  archived: false,
})

describe('Spoolman materials', () => {
  it('maps material, color and weight', () => {
    expect(mapSpoolmanMaterial(spool)).toEqual({
      slot: 'external',
      active: true,
      materialType: 'PLA',
      colorHex: 'AABBCCFF',
      remainingPercent: 25,
    })
    expect(
      mapSpoolmanMaterial({ ...spool, initial_weight: 0 }).remainingPercent,
    ).toBeUndefined()
    expect(
      mapSpoolmanMaterial({ ...spool, remaining_weight: -5 }).remainingPercent,
    ).toBe(0)
  })
  it('selects only the active spool from a fresh inventory', async () => {
    const snapshot = {
      kind: 'observed' as const,
      ageMs: 0,
      inventory: {
        items: [spool],
        farmId: 'a',
        serviceId: 'b',
        observedFrom: 0,
        observedThrough: 0,
      },
    }
    expect(await getSpoolmanMaterials(async () => 3, snapshot)).toEqual([
      mapSpoolmanMaterial(spool),
    ])
    expect(
      await getSpoolmanMaterials(async () => null, snapshot),
    ).toBeUndefined()
    expect(await getSpoolmanMaterials(async () => 4, snapshot)).toBeUndefined()
    expect(
      await getSpoolmanMaterials(async () => 3, { ...snapshot, kind: 'stale' }),
    ).toBeUndefined()
  })
})
