import type { Sql } from 'postgres'
import { useRuntimeConfig } from 'nuxt/server'
import { SpoolInventory } from '@open3dfarmmanager/farm-protocol'
import { uuidPattern, type IntegrationPrincipal } from './integration-auth.ts'

import { integrationHistoryJobIds } from '../storage/integration-jobs-history.ts'

const cursorPattern = /^[A-Za-z0-9_-]{1,512}$/

function decodeCursor<T>(
  cursor: string | null,
  valid: (value: unknown) => value is T,
): T | null | undefined {
  if (cursor === null) return undefined
  if (!cursorPattern.test(cursor)) return null
  try {
    const bytes = Buffer.from(cursor, 'base64url')
    if (bytes.toString('base64url') !== cursor) return null
    const value: unknown = JSON.parse(bytes.toString())
    return valid(value) ? value : null
  } catch {
    return null
  }
}

const inventoryPosition = (
  value: unknown,
): value is { farmId: string; connectorId: string } =>
  !!value &&
  typeof value === 'object' &&
  uuidPattern.test(String((value as { farmId?: unknown }).farmId ?? '')) &&
  uuidPattern.test(
    String((value as { connectorId?: unknown }).connectorId ?? ''),
  )

const jobPosition = (
  value: unknown,
): value is { endedAt: number; id: string } =>
  !!value &&
  typeof value === 'object' &&
  Number.isSafeInteger((value as { endedAt?: unknown }).endedAt) &&
  Number((value as { endedAt: number }).endedAt) >= 0 &&
  typeof (value as { id?: unknown }).id === 'string' &&
  /^[0-9]{1,19}$/.test((value as { id: string }).id)

export function validInventoryCursor(cursor: string | null) {
  return decodeCursor(cursor, inventoryPosition) !== null
}

export function validJobCursor(cursor: string | null) {
  return decodeCursor(cursor, jobPosition) !== null
}

export function inventoryGrantFarms(
  principal: IntegrationPrincipal,
  farmId?: string,
) {
  return [
    ...new Set(
      principal.grants
        .filter(
          (grant) =>
            grant.scopes.includes('inventory:read') &&
            grant.printerAssignmentId === null &&
            (farmId === undefined || grant.farmId === farmId),
        )
        .map((grant) => grant.farmId),
    ),
  ]
}

export function jobGrantScope(
  principal: IntegrationPrincipal,
  farmId?: string,
  printerId?: string,
) {
  const grants = principal.grants.filter(
    (grant) =>
      grant.scopes.includes('jobs:read') &&
      (farmId === undefined || grant.farmId === farmId) &&
      (printerId === undefined ||
        grant.printerAssignmentId === null ||
        grant.printerAssignmentId === printerId),
  )
  return {
    farmWideFarmIds: [
      ...new Set(
        grants
          .filter((grant) => grant.printerAssignmentId === null)
          .map((grant) => grant.farmId),
      ),
    ],
    assignmentIds: [
      ...new Set(
        grants.flatMap((grant) =>
          grant.printerAssignmentId ? [grant.printerAssignmentId] : [],
        ),
      ),
    ],
  }
}

function encodeCursor(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export async function listIntegrationInventory(
  sql: Sql,
  input: { farmIds: string[]; limit: number; cursor: string | null },
) {
  const position = decodeCursor(input.cursor, inventoryPosition)
  if (position === null || input.farmIds.length === 0) {
    if (position === null) throw new Error('Invalid inventory cursor')
    return { data: [], nextCursor: null }
  }
  const rows = await sql<
    {
      farmId: string
      connectorId: string
      observedAt: number
      snapshot: unknown
    }[]
  >`SELECT farm_id::text AS "farmId", agent_id::text AS "connectorId", observed_at::float8 AS "observedAt", snapshot
      FROM farm.connector_inventory_snapshots
      WHERE farm_id = ANY(${input.farmIds}::uuid[])
        AND (${position?.farmId ?? null}::uuid IS NULL OR (farm_id, agent_id) > (${position?.farmId ?? null}::uuid, ${position?.connectorId ?? null}::uuid))
      ORDER BY farm_id, agent_id
      LIMIT ${input.limit + 1}`
  const data = rows.slice(0, input.limit).map((row) => {
    const parsed = SpoolInventory.safeParse(row.snapshot)
    if (!parsed.success || parsed.data.observedAt !== row.observedAt)
      throw new Error('Stored inventory does not match its schema')
    return { farmId: row.farmId, connectorId: row.connectorId, ...parsed.data }
  })
  const last = data.at(-1)
  return {
    data,
    nextCursor:
      rows.length > input.limit && last
        ? encodeCursor({ farmId: last.farmId, connectorId: last.connectorId })
        : null,
  }
}

export async function listIntegrationJobs(
  sql: Sql,
  input: {
    farmWideFarmIds: string[]
    assignmentIds: string[]
    printerId: string | null
    since: number | null
    until: number | null
    limit: number
    cursor: string | null
  },
  linkSql?: Sql | null,
) {
  const position = decodeCursor(input.cursor, jobPosition)
  if (position === null) throw new Error('Invalid job cursor')
  const rows = await sql<
    {
      id: string
      farmId: string
      printerId: string
      agentId: string
      outcome: 'completed' | 'cancelled' | 'failed'
      filename: string | null
      printDurationSeconds: number | null
      totalDurationSeconds: number | null
      filamentUsage:
        import('@open3dfarmmanager/farm-protocol').FilamentUsage[] | null
      endedAt: number
    }[]
  >`SELECT h.id::text AS id, h.farm_id::text AS "farmId", p.id::text AS "printerId", h.agent_id::text AS "agentId", h.outcome,
      h.filename, h.print_duration_seconds AS "printDurationSeconds",
      h.total_duration_seconds AS "totalDurationSeconds", h.filament_usage AS "filamentUsage", h.ended_at::float8 AS "endedAt"
      FROM farm.job_history h
      JOIN farm.printer_assignments p ON p.farm_id = h.farm_id AND p.agent_id = h.agent_id
        AND p.printer_key = h.printer_key AND p.revoked_at IS NULL
      WHERE ((p.farm_id = ANY(${input.farmWideFarmIds}::uuid[])) OR (p.id = ANY(${input.assignmentIds}::uuid[])))
        AND (${input.printerId}::uuid IS NULL OR p.id = ${input.printerId}::uuid)
        AND (${input.since}::bigint IS NULL OR h.ended_at >= ${input.since})
        AND (${input.until}::bigint IS NULL OR h.ended_at < ${input.until})
        AND (${position?.endedAt ?? null}::bigint IS NULL OR (h.ended_at, h.id) < (${position?.endedAt ?? null}::bigint, ${position?.id ?? null}::bigint))
      ORDER BY h.ended_at DESC, h.id DESC
      LIMIT ${input.limit + 1}`
  const page = rows.slice(0, input.limit)
  // This path can also run with only the read API enabled. The integration
  // jobs runtime owns the separate role allowed to read envelope receipts.
  if (linkSql === undefined && page.length) {
    const config = useRuntimeConfig().integrationJobs
    if (
      typeof config === 'object' &&
      config !== null &&
      'enabled' in config &&
      config.enabled === true
    ) {
      const { integrationJobsRuntime } =
        await import('./integration-jobs-runtime.ts')
      linkSql = (await integrationJobsRuntime()).pool
    }
  }
  const jobIds = linkSql
    ? await integrationHistoryJobIds(linkSql, page)
    : new Map()
  const data = page.map((row) => ({
    ...(jobIds.has(row.id) ? { jobId: jobIds.get(row.id)! } : {}),
    id: row.id,
    farmId: row.farmId,
    printerId: row.printerId,
    outcome: row.outcome,
    ...(row.filename !== null ? { filename: row.filename } : {}),
    ...(row.printDurationSeconds !== null
      ? { printDurationSeconds: Number(row.printDurationSeconds) }
      : {}),
    ...(row.totalDurationSeconds !== null
      ? { totalDurationSeconds: Number(row.totalDurationSeconds) }
      : {}),
    ...(row.filamentUsage?.length ? { filamentUsage: row.filamentUsage } : {}),
    endedAt: Number(row.endedAt),
  }))
  const last = data.at(-1)
  return {
    data,
    nextCursor:
      rows.length > input.limit && last
        ? encodeCursor({ endedAt: last.endedAt, id: last.id })
        : null,
  }
}
