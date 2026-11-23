// spec-derived, not captured: https://donkie.github.io/Spoolman/
import { expect, test } from 'vitest'
import type { Sql } from 'postgres'
import {
  listObservedSpools,
  spoolCursor,
} from '../../apps/farm/server/utils/integration-inventory-spools.ts'

const farmId = '00000000-0000-4000-8000-000000000001'
const connectorId = '00000000-0000-4000-8000-000000000002'
const spool = (spoolId: number) => ({
  spoolId,
  name: 'PLA',
  material: 'PLA',
  colorHex: 'ff0000',
  remainingGrams: 100,
  location: null,
  archived: false,
})
const snapshot = {
  observedAt: 10,
  stale: false,
  total: 3,
  spools: [spool(1), spool(2)],
}

test('pages duplicate names with identity and partial evidence', async () => {
  const rows = [0, 1].map((index) => ({
    farmId,
    connectorId,
    observedAt: 10,
    snapshot,
    index,
  }))
  const sql = (() => Promise.resolve(rows)) as unknown as Sql
  const page = await listObservedSpools(sql, {
    farmIds: [farmId],
    limit: 1,
    cursor: null,
  })
  expect(page.data[0]).toMatchObject({
    partial: true,
    spool: { spoolId: 1, name: 'PLA' },
  })
  expect(spoolCursor(page.nextCursor)).toEqual({
    farmId,
    connectorId,
    index: 0,
  })
  expect(spoolCursor('bad')).toBeNull()
})
