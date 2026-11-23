import { createHash } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { z } from 'zod'

const recordId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const location = z
  .string()
  .refine(
    (value) =>
      value.length > 0 &&
      Array.from(value).length <= 256 &&
      !value.includes('\0'),
  )
export const registration = z.strictObject({
  filamentId: recordId,
  location: location
    .refine((value) => value.trim().length > 0 && !/\p{Cc}/u.test(value))
    .transform((value) => value.trim()),
  initialWeightGrams: z.number().nonnegative().optional(),
})
export const withdrawal = z.strictObject({
  expectedLocation: location,
  version: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})

export function physicalSpoolId(value: string | undefined) {
  if (!value || !/^[1-9]\d{0,15}$/.test(value)) return null
  const id = recordId.safeParse(Number(value))
  return id.success ? id.data : null
}

interface Access {
  appId: string
  farmId: string
  grantIds: string[]
  scope: 'inventory:read' | 'inventory:write'
}

interface SpoolRow {
  id: number
  location: string | null
  revision: string
}

// A PostgreSQL row version changes even when a move returns to the same bin.
// Include both system columns to distinguish updates within one transaction.
function version(farmId: string, row: SpoolRow) {
  return createHash('sha256')
    .update(JSON.stringify([farmId, row.id, row.revision, row.location]))
    .digest('base64url')
}

function physicalSpool(farmId: string, row: SpoolRow) {
  return {
    farmId,
    spoolId: row.id,
    location: row.location,
    version: version(farmId, row),
    label: {
      href: `/api/farms/${farmId}/spool-library/labels?spoolIds=${row.id}`,
    },
    binLight: { status: 'unsupported' as const },
  }
}

async function authorized<T>(
  sql: Sql,
  access: Access,
  work: (tx: TransactionSql) => Promise<T>,
) {
  return sql.begin(async (tx) => {
    const [grant] = await tx`
      SELECT g.id FROM farm.integration_apps a
      JOIN farm.integration_app_grants g ON g.app_id = a.id
      JOIN farm.farms f ON f.id = g.farm_id
      WHERE a.id = ${access.appId}::uuid AND g.id = ANY(${access.grantIds}::uuid[])
        AND f.id = ${access.farmId}::uuid AND (NOT a.sandbox OR f.sandbox)
        AND a.revoked_at IS NULL AND g.disabled_at IS NULL
        AND g.printer_assignment_id IS NULL AND ${access.scope} = ANY(g.scopes)
      FOR SHARE OF a, g`
    return grant ? await work(tx) : null
  })
}

export function registerPhysicalSpool(
  sql: Sql,
  access: Access,
  input: z.infer<typeof registration>,
) {
  return authorized(sql, access, async (tx) => {
    const [filament] = await tx`
      SELECT id FROM farm.spool_filaments
      WHERE farm_id = ${access.farmId}::uuid AND id = ${input.filamentId}
      FOR KEY SHARE`
    if (!filament) return null
    // Use the Spoolman-compatible library allocator, including its per-farm lock.
    const [row] = await tx<SpoolRow[]>`
      WITH allocated AS (
        INSERT INTO farm.spool_library_counters (farm_id, kind, last_id)
        VALUES (${access.farmId}::uuid, 'spool', 1)
        ON CONFLICT (farm_id, kind)
        DO UPDATE SET last_id = farm.spool_library_counters.last_id + 1
        RETURNING last_id
      )
      INSERT INTO farm.spools (farm_id, id, filament_id, location, initial_weight, registered_at)
      SELECT ${access.farmId}::uuid, last_id, ${input.filamentId}::bigint,
        ${input.location}, ${input.initialWeightGrams ?? null}::float8, ${Date.now()}::bigint
      FROM allocated
      RETURNING id::float8 AS id, location, xmin::text || ':' || ctid::text AS revision`
    if (!row) throw new Error('Spool allocation returned no row')
    return physicalSpool(access.farmId, row)
  })
}

export function readPhysicalSpool(sql: Sql, access: Access, spoolId: number) {
  return authorized(sql, access, async (tx) => {
    const [row] = await tx<SpoolRow[]>`
      SELECT id::float8 AS id, NULLIF(btrim(location), '') AS location,
        xmin::text || ':' || ctid::text AS revision
      FROM farm.spools
      WHERE farm_id = ${access.farmId}::uuid AND id = ${spoolId} AND NOT archived`
    return row ? physicalSpool(access.farmId, row) : null
  })
}

export function withdrawPhysicalSpool(
  sql: Sql,
  access: Access,
  spoolId: number,
  input: z.infer<typeof withdrawal>,
) {
  return authorized(sql, access, async (tx) => {
    const [row] = await tx<SpoolRow[]>`
      SELECT id::float8 AS id, NULLIF(btrim(location), '') AS location,
        xmin::text || ':' || ctid::text AS revision
      FROM farm.spools
      WHERE farm_id = ${access.farmId}::uuid AND id = ${spoolId} AND NOT archived
      FOR UPDATE`
    if (!row) return null
    if (row.location === null)
      return {
        outcome: 'already-unlocated' as const,
        spool: physicalSpool(access.farmId, row),
      }
    if (
      row.location !== input.expectedLocation ||
      version(access.farmId, row) !== input.version
    )
      return { outcome: 'changed' as const }
    const [updated] = await tx<SpoolRow[]>`
      UPDATE farm.spools SET location = NULL
      WHERE farm_id = ${access.farmId}::uuid AND id = ${spoolId}
      RETURNING id::float8 AS id, location, xmin::text || ':' || ctid::text AS revision`
    if (!updated) throw new Error('Locked spool disappeared')
    return {
      outcome: 'withdrawn' as const,
      spool: physicalSpool(access.farmId, updated),
    }
  })
}
