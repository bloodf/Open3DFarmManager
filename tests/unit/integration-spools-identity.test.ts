// spec-derived, not captured: https://github.com/Donkie/Spoolman/blob/master/docs/api.md
import { expect, test } from 'vitest'
import { parseSpoolmanSpoolInventory } from '../../packages/connector/src/spoolman/read.ts'
import {
  inventoryAt,
  summarizeSpoolman,
} from '../../packages/connector/src/runtime/spool-inventory.ts'
import { listIntegrationInventory } from '../../apps/farm/server/utils/integration-read.ts'
import type { Sql } from 'postgres'

const farmId = '00000000-0000-4000-8000-000000000001'
const connectorId = '00000000-0000-4000-8000-000000000002'

test('duplicate names retain distinct IDs in the existing snapshot contract', async () => {
  const wire = JSON.stringify(
    Array.from({ length: 9 }, (_, i) => ({
      id: i + 1,
      filament: { id: 1, name: 'PLA', material: 'PLA', weight: 1000 },
      remaining_weight: i === 0 ? 250 : null,
      archived: false,
    })),
  )
  const inventory = parseSpoolmanSpoolInventory(
    [{ wire, offset: 0, observedAt: 1000 }],
    { farmId, serviceId: connectorId, limit: 100 },
  )
  const summary = summarizeSpoolman({ kind: 'observed', inventory, ageMs: 0 })!
  const snapshot = inventoryAt(summary, 0, 1000)
  expect(snapshot.spools.map((spool) => spool.spoolId)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8,
  ])
  expect(snapshot.spools[0]?.remainingPercent).toBe(25)
  expect(snapshot.spools[1]?.remainingPercent).toBeUndefined()
  const sql = (() =>
    Promise.resolve([
      { farmId, connectorId, observedAt: 1000, snapshot },
    ])) as unknown as Sql
  const page = await listIntegrationInventory(sql, {
    farmIds: [farmId],
    limit: 10,
    cursor: null,
  })
  expect(page.data[0]).not.toHaveProperty('partial')
  expect(page.data[0]).toMatchObject({
    total: 9,
    observedAt: 1000,
  })
})

test('older complete snapshots remain readable without fabricated identity', async () => {
  const snapshot = {
    observedAt: 1000,
    stale: false,
    total: 1,
    spools: [
      {
        name: 'PLA',
        material: null,
        colorHex: null,
        remainingGrams: null,
        location: null,
        archived: false,
      },
    ],
  }
  const sql = (() =>
    Promise.resolve([
      { farmId, connectorId, observedAt: 1000, snapshot },
    ])) as unknown as Sql
  const page = await listIntegrationInventory(sql, {
    farmIds: [farmId],
    limit: 10,
    cursor: null,
  })
  expect(page.data[0]).not.toHaveProperty('partial')
  expect(page.data[0]).toMatchObject({
    spools: snapshot.spools,
  })
})
