import { describe, expect, test } from 'vitest'
import {
  MAX_INVENTORY_SPOOLS,
  SpoolInventory,
  StatusMessage,
  parseStatusMessageTolerant,
} from '@open3dfarmmanager/farm-protocol'

const spool = {
  name: 'PLA Preto',
  material: 'PLA',
  colorHex: '1a2b3c',
  remainingGrams: 750,
  location: 'Prateleira A',
  archived: false,
}
const inventory = {
  observedAt: 1_800_000_000_000,
  stale: false,
  total: 1,
  spools: [spool],
}

describe('spool inventory schema', () => {
  test('round-trips JSON and keeps negative or unknown weights', () => {
    const value = {
      ...inventory,
      spools: [
        spool,
        { ...spool, remainingGrams: -12 },
        { ...spool, remainingGrams: null, name: null, colorHex: null },
      ],
      total: 3,
    }
    expect(SpoolInventory.parse(JSON.parse(JSON.stringify(value)))).toEqual(
      value,
    )
  })
  test('is optional on status snapshots and strict inside them', () => {
    const base = { t: 'snapshot' as const, seq: 1, printers: [] }
    expect(StatusMessage.parse(base)).toEqual(base)
    expect(StatusMessage.parse({ ...base, inventory })).toEqual({
      ...base,
      inventory,
    })
    expect(
      StatusMessage.safeParse({ ...base, inventory: { ...inventory, x: 1 } })
        .success,
    ).toBe(false)
    expect(
      StatusMessage.safeParse({ ...base, inventory, extra: true }).success,
    ).toBe(false)
  })
  test.each([
    ['unknown spool field', { ...spool, vendor: 'x' }],
    ['long name', { ...spool, name: 'n'.repeat(33) }],
    ['long material', { ...spool, material: 'm'.repeat(17) }],
    ['long location', { ...spool, location: 'l'.repeat(33) }],
    ['uppercase color', { ...spool, colorHex: '1A2B3C' }],
    ['alpha color', { ...spool, colorHex: '1a2b3cff' }],
    ['fractional weight', { ...spool, remainingGrams: 1.5 }],
    ['huge weight', { ...spool, remainingGrams: 1_000_001 }],
    ['non-boolean archived', { ...spool, archived: 'no' }],
  ])('rejects %s', (_name, bad) => {
    expect(
      SpoolInventory.safeParse({ ...inventory, spools: [bad] }).success,
    ).toBe(false)
  })
  test('caps spool count and rejects invalid envelope values', () => {
    const full = Array.from({ length: MAX_INVENTORY_SPOOLS }, () => spool)
    expect(
      SpoolInventory.safeParse({ ...inventory, spools: full, total: 99 })
        .success,
    ).toBe(true)
    expect(
      SpoolInventory.safeParse({
        ...inventory,
        spools: [...full, spool],
      }).success,
    ).toBe(false)
    for (const bad of [
      { total: -1 },
      { total: 10_001 },
      { observedAt: -1 },
      { observedAt: 1.5 },
      { stale: 'yes' },
    ])
      expect(SpoolInventory.safeParse({ ...inventory, ...bad }).success).toBe(
        false,
      )
  })
})

describe('tolerant browser parsing', () => {
  const base = { t: 'snapshot' as const, seq: 1, printers: [] }
  test('drops only an invalid inventory and keeps printers', () => {
    const bad = { ...inventory, spools: [{ ...spool, extra: 1 }] }
    const result = parseStatusMessageTolerant({ ...base, inventory: bad })
    expect(result.success && result.data).toEqual(base)
    expect(StatusMessage.safeParse({ ...base, inventory: bad }).success).toBe(
      false,
    )
  })
  test('keeps a valid inventory and rejects other violations', () => {
    const ok = parseStatusMessageTolerant({ ...base, inventory })
    expect(ok.success && ok.data.inventory).toEqual(inventory)
    expect(
      parseStatusMessageTolerant({ ...base, inventory, extra: 1 }).success,
    ).toBe(false)
    expect(
      parseStatusMessageTolerant({
        ...base,
        printers: [{ printerKey: 'a', state: 'bad' }],
        inventory: 'x',
      }).success,
    ).toBe(false)
  })
})
