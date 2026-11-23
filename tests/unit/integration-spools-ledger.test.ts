// spec-derived, not captured: https://github.com/Donkie/Spoolman/blob/master/docs/api.md
import type { Sql } from 'postgres'
import { expect, test, vi } from 'vitest'
import fixture from '../fixtures/spoolman/spools.json'
import {
  listIntegrationSpoolUsage,
  searchIntegrationSpools,
  spoolSearchQuery,
  spoolUsageQuery,
} from '../../apps/farm/server/utils/integration-inventory-ledger.ts'

const farmId = '00000000-0000-4000-8000-000000000001'
const printerId = '00000000-0000-4000-8000-000000000002'
const usageId = '00000000-0000-4000-8000-000000000003'
const source = fixture[0]!

test('finder binds the authorized farm, fixture color channels and stock filters', async () => {
  const query = spoolSearchQuery(
    new URLSearchParams({
      color: source.filament.color_hex!,
      material: 'pla',
      availability: 'loaded',
      minRemainingGrams: '750',
    }),
  )!
  const loaded = {
    farmId,
    spoolId: source.id,
    location: source.location,
    remainingGrams: source.remaining_weight,
    colorDistance: 0,
    loaded: true,
    loadedAt: [{ printerId, slotKind: 'ams', slotIndex: 0, assignedAt: 1000 }],
  }
  const sql = vi
    .fn()
    .mockResolvedValue([
      loaded,
      { ...loaded, spoolId: source.id + 1, location: null },
    ])
  const result = await searchIntegrationSpools(
    sql as unknown as Sql,
    [farmId],
    query,
  )
  expect(result.data).toEqual([
    loaded,
    { ...loaded, spoolId: source.id + 1, location: null },
  ])
  expect(sql.mock.calls[0]!.slice(1)).toEqual([
    51,
    51,
    136,
    255,
    [farmId],
    'pla',
    'pla',
    51,
    750,
    750,
    'loaded',
    'loaded',
    50,
  ])
})

test('usage replay returns the same identity when corrected after a slot change', async () => {
  const query = spoolUsageQuery(
    new URLSearchParams({ jobId: '42', limit: '1' }),
  )!
  const original = {
    farmId,
    usageId,
    spoolId: source.id,
    observedAt: 2000,
    grams: 15,
    corrected: false,
  }
  const corrected = { ...original, grams: 12, corrected: true }
  const sql = vi
    .fn()
    .mockResolvedValueOnce([original])
    .mockResolvedValueOnce([corrected])
  expect(
    await listIntegrationSpoolUsage(sql as unknown as Sql, [farmId], query),
  ).toEqual({
    data: [original],
    nextCursor: null,
  })
  expect(
    await listIntegrationSpoolUsage(sql as unknown as Sql, [farmId], query),
  ).toEqual({
    data: [corrected],
    nextCursor: null,
  })
})

test.each([
  'color=not-hex',
  'availability=archived',
  'minRemainingGrams=-1',
  'minRemainingGrams=Infinity',
  'limit=1&limit=2',
  'material=',
  'unknown=true',
])('finder rejects invalid query %s', (query) => {
  expect(spoolSearchQuery(new URLSearchParams(query))).toBeNull()
})

test('usage validates bigint job IDs and cursor syntax', () => {
  expect(
    spoolUsageQuery(new URLSearchParams('jobId=9223372036854775808')),
  ).toBeNull()
  expect(
    spoolUsageQuery(new URLSearchParams('jobId=2&cursor=wrong')),
  ).toBeNull()
  expect(
    spoolUsageQuery(new URLSearchParams('jobId=9223372036854775807'))?.jobId,
  ).toBe('9223372036854775807')
})
