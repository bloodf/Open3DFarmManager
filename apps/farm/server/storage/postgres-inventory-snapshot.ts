import { ApiSpoolMembership } from '../../../../packages/farm-protocol/src/api-query.ts'
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

type Binding = { serviceId: string; spoolId: number }

export type ReadSpoolMembership = (
  agentId: string,
  binding: Binding,
) => Promise<unknown> | undefined

function fresh(observedAt: number, now: number) {
  const age = now - observedAt
  return age >= 0 && age < SPOOL_INVENTORY_STALE_MS
}

export async function hasCurrentSpoolObservation(
  tx: TransactionSql,
  farmId: string,
  binding: Binding,
  readMembership?: ReadSpoolMembership,
) {
  // The bounded lookup runs with the same locks as the summary check. A
  // revocation, settings update or snapshot replacement that wins these locks
  // first is visible before the lookup. A later update waits for the write.
  const rows = await tx<(InventoryRow & { agentId: string })[]>`
    SELECT agent_id::text AS "agentId", observed_at::float8 AS "observedAt", snapshot
    FROM farm.lock_physical_spool_observations(${farmId}::uuid, ${binding.serviceId}::uuid)`
  const now = Date.now()
  const eligible = rows.flatMap((row) => {
    const snapshot = parseInventorySnapshot(row)
    return snapshot &&
      !snapshot.stale &&
      fresh(row.observedAt, now) &&
      snapshot.serviceId?.toLowerCase() === binding.serviceId
      ? [{ row, snapshot }]
      : []
  })
  if (
    eligible.some(({ snapshot }) =>
      snapshot.spools.some(({ spoolId }) => spoolId === binding.spoolId),
    )
  )
    return true
  if (!readMembership) return false

  const candidates = eligible
    .filter(
      ({ snapshot, row }) =>
        row.agentId && snapshot.total > snapshot.spools.length,
    )
    .slice(0, 4)
  const results = await Promise.all(
    candidates.map(async ({ row }) => {
      const reply = ApiSpoolMembership.safeParse(
        await readMembership(row.agentId, binding),
      )
      return { row, reply }
    }),
  )
  const checkedAt = Date.now()
  return results.some(
    ({ row, reply }) =>
      reply.success &&
      reply.data.present &&
      reply.data.serviceId === binding.serviceId &&
      reply.data.spoolId === binding.spoolId &&
      fresh(row.observedAt, checkedAt) &&
      fresh(reply.data.observedAt, checkedAt),
  )
}
