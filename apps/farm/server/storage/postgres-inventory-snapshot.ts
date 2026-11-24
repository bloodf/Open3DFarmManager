import type { TransactionSql } from 'postgres'
import {
  SPOOL_INVENTORY_STALE_MS,
  SpoolInventory,
} from '@open3dfarmmanager/farm-protocol'

interface InventoryRow {
  observedAt: number
  snapshot: unknown
}

export function parseInventorySnapshot(row: InventoryRow) {
  const parsed = SpoolInventory.safeParse(row.snapshot)
  return parsed.success && parsed.data.observedAt === row.observedAt
    ? parsed.data
    : null
}

export async function hasCurrentSpoolObservation(
  tx: TransactionSql,
  farmId: string,
  binding: { serviceId: string; spoolId: number },
) {
  // Row locks make concurrent revocation or replacement wait, or recheck
  // the updated rows if the other transaction acquired its locks first.
  const rows = await tx<InventoryRow[]>`
    SELECT observed_at::float8 AS "observedAt", snapshot
    FROM farm.lock_physical_spool_observations(${farmId}::uuid, ${binding.serviceId}::uuid)`
  const now = Date.now()
  return rows.some((row) => {
    const snapshot = parseInventorySnapshot(row)
    const age = now - row.observedAt
    return (
      snapshot !== null &&
      !snapshot.stale &&
      age >= 0 &&
      age < SPOOL_INVENTORY_STALE_MS &&
      snapshot.serviceId?.toLowerCase() === binding.serviceId &&
      snapshot.spools.some((spool) => spool.spoolId === binding.spoolId)
    )
  })
}
