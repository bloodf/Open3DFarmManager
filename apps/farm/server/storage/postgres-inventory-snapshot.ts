import { ApiSpoolMembership } from '../../../../packages/farm-protocol/src/api-query.ts'
import type { Sql, TransactionSql } from 'postgres'
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

export async function recordInventorySnapshot(
  tx: TransactionSql,
  { farmId, agentId }: { farmId: string; agentId: string },
  inventory: SpoolInventory,
  ageAtSendMs?: number,
) {
  await tx`INSERT INTO farm.connector_inventory_snapshots AS current
    (farm_id, agent_id, observed_at, snapshot, received_at, age_at_send_ms)
    VALUES (${farmId}::uuid, ${agentId}::uuid, ${inventory.observedAt}, ${tx.json(inventory)}, floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::bigint, ${ageAtSendMs ?? null})
    ON CONFLICT (farm_id, agent_id) DO UPDATE SET
      observed_at = EXCLUDED.observed_at, snapshot = EXCLUDED.snapshot, received_at = EXCLUDED.received_at,
      age_at_send_ms = EXCLUDED.age_at_send_ms, revision = current.revision + 1`
}

type Binding = { serviceId: string; spoolId: number }

export type ReadSpoolMembership = (
  agentId: string,
  binding: Binding,
) => Promise<unknown> | undefined

type ObservationRow = InventoryRow & {
  agentId: string
  receivedAt: number | null
  ageAtSendMs: number | null
  databaseNow: number
  revision: string
}

export type MembershipEvidence = Pick<
  ObservationRow,
  'agentId' | 'revision'
> & {
  repliedAt: number
}

function eligibleObservations(rows: ObservationRow[], binding: Binding) {
  return rows.flatMap((row) => {
    const snapshot = parseInventorySnapshot(row)
    const elapsed =
      row.receivedAt === null ? -1 : row.databaseNow - row.receivedAt
    return snapshot &&
      !snapshot.stale &&
      elapsed >= 0 &&
      Number.isSafeInteger(row.ageAtSendMs) &&
      row.ageAtSendMs !== null &&
      row.ageAtSendMs >= 0 &&
      elapsed + row.ageAtSendMs < SPOOL_INVENTORY_STALE_MS &&
      snapshot.serviceId?.toLowerCase() === binding.serviceId
      ? [{ row, snapshot }]
      : []
  })
}

function listsSpool(snapshot: SpoolInventory, binding: Binding) {
  return snapshot.spools.some(({ spoolId }) => spoolId === binding.spoolId)
}

export async function prefetchSpoolMembership(
  sql: Sql,
  farmId: string,
  binding: Binding,
  readMembership: ReadSpoolMembership,
  retryAgents?: ReadonlySet<string>,
): Promise<MembershipEvidence[]> {
  const rows = await sql<ObservationRow[]>`
    SELECT agent_id::text AS "agentId", observed_at::float8 AS "observedAt",
      received_at::float8 AS "receivedAt", age_at_send_ms::float8 AS "ageAtSendMs",
      floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::float8 AS "databaseNow",
      revision::text AS revision, snapshot
    FROM farm.read_physical_spool_observations_with_freshness(${farmId}::uuid, ${binding.serviceId}::uuid)`
  const eligible = eligibleObservations(rows, binding)
  if (eligible.some(({ snapshot }) => listsSpool(snapshot, binding))) return []

  const candidates = eligible
    .filter(
      ({ row, snapshot }) =>
        snapshot.total > snapshot.spools.length &&
        (!retryAgents || retryAgents.has(row.agentId)),
    )
    .sort((a, b) => b.row.receivedAt! - a.row.receivedAt!)
  const pending: Promise<MembershipEvidence[]>[] = []
  for (const { row } of candidates) {
    // Unavailable inboxes return undefined and do not consume a slot.
    const query = readMembership(row.agentId, binding)
    if (!query) continue
    pending.push(
      query.then((result) => {
        const reply = ApiSpoolMembership.safeParse(result)
        return reply.success &&
          reply.data.present &&
          reply.data.serviceId === binding.serviceId &&
          reply.data.spoolId === binding.spoolId
          ? [
              {
                agentId: row.agentId,
                revision: row.revision,
                repliedAt: performance.now(),
              },
            ]
          : []
      }),
    )
    if (pending.length === 4) {
      const results = (await Promise.all(pending)).flat()
      if (results.length) return results
      pending.length = 0
    }
  }
  const results = await Promise.all(pending)
  return results.flat()
}

export async function checkCurrentSpoolObservation(
  tx: TransactionSql,
  farmId: string,
  binding: Binding,
  membership: MembershipEvidence[] = [],
) {
  const rows = await tx<ObservationRow[]>`
    SELECT agent_id::text AS "agentId", observed_at::float8 AS "observedAt",
      received_at::float8 AS "receivedAt", age_at_send_ms::float8 AS "ageAtSendMs",
      floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::float8 AS "databaseNow",
      revision::text AS revision, snapshot
    FROM farm.lock_physical_spool_observations_with_freshness(${farmId}::uuid, ${binding.serviceId}::uuid)`
  const newerAgents = new Set<string>()
  const now = performance.now()
  for (const { row, snapshot } of eligibleObservations(rows, binding)) {
    if (listsSpool(snapshot, binding)) return { present: true, newerAgents }
    if (snapshot.total <= snapshot.spools.length) continue
    for (const reply of membership) {
      if (
        reply.agentId !== row.agentId ||
        now - reply.repliedAt < 0 ||
        now - reply.repliedAt >= SPOOL_INVENTORY_STALE_MS
      )
        continue
      if (reply.revision === row.revision) return { present: true, newerAgents }
      if (BigInt(row.revision) > BigInt(reply.revision))
        newerAgents.add(row.agentId)
    }
  }
  return { present: false, newerAgents }
}

export async function hasCurrentSpoolObservation(
  ...args: Parameters<typeof checkCurrentSpoolObservation>
) {
  return (await checkCurrentSpoolObservation(...args)).present
}
