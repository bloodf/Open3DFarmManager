import { expect, test } from 'bun:test'
import { parseInventoryPage } from '../../apps/farm/server/services/connector-inventory.ts'

const base = 'https://farm.example.invalid/api/farms'
const cursor = '12345678-1234-4234-8234-123456789abc'
test('inventory pagination accepts only bounded canonical keysets', () => {
  expect(parseInventoryPage(base)).toEqual({ limit: 20, after: null })
  expect(parseInventoryPage(`${base}?limit=1&after=${cursor}`)).toEqual({
    limit: 1,
    after: cursor,
  })
  expect(parseInventoryPage(`${base}?limit=50`)).toEqual({
    limit: 50,
    after: null,
  })
  for (const query of [
    'limit=0',
    'limit=51',
    'limit=01',
    'limit=1.0',
    'limit=',
    'limit=1&limit=2',
    `after=${cursor}&after=${cursor}`,
    `after=${cursor.toUpperCase()}`,
    'after=',
    'after=bad',
    'other=1',
  ])
    expect(() => parseInventoryPage(`${base}?${query}`)).toThrow()
})
