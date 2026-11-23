import type { Sql } from 'postgres'
import { SpoolInventory } from '@open3dfarmmanager/farm-protocol'
import { uuidPattern } from './integration-auth.ts'
import { spoolIdentity } from './integration-spool-identity.ts'

type Position = { farmId: string; connectorId: string; index: number }

export function spoolCursor(
  cursor: string | null,
): Position | null | undefined {
  if (cursor === null) return undefined
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) return null
    const bytes = Buffer.from(cursor, 'base64url')
    if (bytes.toString('base64url') !== cursor) return null
    const p: unknown = JSON.parse(bytes.toString())
    if (!p || typeof p !== 'object') return null
    const v = p as Record<string, unknown>
    if (
      typeof v.farmId !== 'string' ||
      !uuidPattern.test(v.farmId) ||
      typeof v.connectorId !== 'string' ||
      !uuidPattern.test(v.connectorId) ||
      !Number.isInteger(v.index) ||
      Number(v.index) < 0 ||
      Number(v.index) > 7
    )
      return null
    return {
      farmId: v.farmId,
      connectorId: v.connectorId,
      index: Number(v.index),
    }
  } catch {
    return null
  }
}

/** Pages observations, not a complete inventory: each source may be truncated. */
export async function listObservedSpools(
  sql: Sql,
  input: { farmIds: string[]; limit: number; cursor: string | null },
) {
  const p = spoolCursor(input.cursor)
  if (p === null) throw new Error('Invalid cursor')
  const rows = await sql<
    {
      farmId: string
      connectorId: string
      observedAt: number
      snapshot: unknown
      index: number
    }[]
  >`
    SELECT s.farm_id::text AS "farmId", s.agent_id::text AS "connectorId", s.observed_at::float8 AS "observedAt", s.snapshot, (item.ordinality - 1)::int AS index
    FROM farm.connector_inventory_snapshots s
    CROSS JOIN LATERAL jsonb_array_elements(s.snapshot->'spools') WITH ORDINALITY AS item(value, ordinality)
    WHERE s.farm_id = ANY(${input.farmIds}::uuid[])
      AND (${p?.farmId ?? null}::uuid IS NULL OR (s.farm_id, s.agent_id, item.ordinality - 1) > (${p?.farmId ?? null}::uuid, ${p?.connectorId ?? null}::uuid, ${p?.index ?? null}::bigint))
    ORDER BY s.farm_id, s.agent_id, item.ordinality LIMIT ${input.limit + 1}`
  const data = rows.slice(0, input.limit).map((row) => {
    const parsed = SpoolInventory.safeParse(row.snapshot)
    if (
      !parsed.success ||
      parsed.data.observedAt !== row.observedAt ||
      !parsed.data.spools[row.index]
    )
      throw new Error('Invalid inventory snapshot')
    const spool = parsed.data.spools[row.index]!
    return {
      ...spoolIdentity(parsed.data.serviceId, spool.spoolId),
      farmId: row.farmId,
      connectorId: row.connectorId,
      observedAt: row.observedAt,
      stale: parsed.data.stale,
      partial: parsed.data.spools.length < parsed.data.total,
      spool,
    }
  })
  const last = rows[Math.min(rows.length, input.limit) - 1]
  return {
    data,
    nextCursor:
      rows.length > input.limit && last
        ? Buffer.from(
            JSON.stringify({
              farmId: last.farmId,
              connectorId: last.connectorId,
              index: last.index,
            }),
          ).toString('base64url')
        : null,
  }
}
