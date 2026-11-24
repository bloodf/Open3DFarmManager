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

// Allow modest Connector clock skew without letting a far-future report
// become the ordering watermark for this Connector.
const MAX_FUTURE_OBSERVATION_MS = 30_000

export async function recordInventorySnapshot(
  tx: TransactionSql,
  { farmId, agentId }: { farmId: string; agentId: string },
  inventory: SpoolInventory,
  receivedAt: number,
) {
  if (inventory.observedAt > receivedAt + MAX_FUTURE_OBSERVATION_MS) return

  await tx`INSERT INTO farm.connector_inventory_snapshots AS current
    (farm_id, agent_id, observed_at, snapshot, received_at)
    VALUES (${farmId}::uuid, ${agentId}::uuid, ${inventory.observedAt}, ${tx.json(inventory)}, ${receivedAt})
    ON CONFLICT (farm_id, agent_id) DO UPDATE SET
      observed_at = EXCLUDED.observed_at, snapshot = EXCLUDED.snapshot, received_at = EXCLUDED.received_at
    WHERE current.observed_at < EXCLUDED.observed_at
      OR (current.received_at IS NULL AND current.observed_at > EXCLUDED.received_at + ${MAX_FUTURE_OBSERVATION_MS}::bigint)`
}

type Binding = { serviceId: string; spoolId: number }

export type ReadSpoolMembership = (
  agentId: string,
  binding: Binding,
) => Promise<unknown> | undefined

function fresh(receivedAt: number | null, now: number) {
  if (receivedAt === null) return false
  const age = now - receivedAt
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
  const rows = await tx<
    (InventoryRow & { agentId: string; receivedAt: number | null })[]
  >`
    SELECT agent_id::text AS "agentId", observed_at::float8 AS "observedAt",
      received_at::float8 AS "receivedAt", snapshot
    FROM farm.lock_physical_spool_observations_with_receipt(${farmId}::uuid, ${binding.serviceId}::uuid)`
  const now = Date.now()
  const eligible = rows.flatMap((row) => {
    const snapshot = parseInventorySnapshot(row)
    return snapshot &&
      !snapshot.stale &&
      fresh(row.receivedAt, now) &&
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
  // The Connector checks membership age locally. Recheck the locked
  // snapshot against the server clock after the round trip.
  const checkedAt = Date.now()
  return results.some(
    ({ row, reply }) =>
      reply.success &&
      reply.data.present &&
      reply.data.serviceId === binding.serviceId &&
      reply.data.spoolId === binding.spoolId &&
      fresh(row.receivedAt, checkedAt),
  )
}
