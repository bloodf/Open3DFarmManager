import { createHash } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { z } from 'zod'
import {
  type MembershipEvidence,
  type ReadSpoolMembership,
  hasCurrentSpoolObservation,
  prefetchSpoolMembership,
} from '../storage/postgres-inventory-snapshot.ts'

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
  spoolman: z
    .strictObject({
      serviceId: z
        .string()
        .uuid()
        .transform((id) => id.toLowerCase()),
      spoolId: recordId,
    })
    .optional(),
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

async function findGrant(
  sql: Sql | TransactionSql,
  access: Access,
  lock: boolean,
) {
  const [grant] = await sql`
    SELECT g.id FROM farm.integration_apps a
    JOIN farm.integration_app_grants g ON g.app_id = a.id
    JOIN farm.farms f ON f.id = g.farm_id
    WHERE a.id = ${access.appId}::uuid AND g.id = ANY(${access.grantIds}::uuid[])
      AND f.id = ${access.farmId}::uuid AND (NOT a.sandbox OR f.sandbox)
      AND a.revoked_at IS NULL AND g.disabled_at IS NULL
      AND g.printer_assignment_id IS NULL AND ${access.scope} = ANY(g.scopes)
      AND (${access.scope} <> 'inventory:write' OR NOT g.requires_approval)
    ${lock ? sql`FOR SHARE OF a, g` : sql``}`
  return grant
}

async function authorized<T>(
  sql: Sql,
  access: Access,
  work: (tx: TransactionSql) => Promise<T>,
) {
  return sql.begin(async (tx) => {
    const grant = await findGrant(tx, access, true)
    return grant ? await work(tx) : null
  })
}

export async function registerPhysicalSpool(
  sql: Sql,
  access: Access,
  input: z.infer<typeof registration>,
  key: string,
  readMembership?: ReadSpoolMembership,
) {
  let membership: MembershipEvidence[] | undefined
  if (input.spoolman && readMembership) {
    if (!(await findGrant(sql, access, false))) return null
    membership = await prefetchSpoolMembership(
      sql,
      access.farmId,
      input.spoolman,
      readMembership,
    )
  }
  return authorized(sql, access, async (tx) => {
    const hash = createHash('sha256')
      .update(
        JSON.stringify([
          access.farmId,
          input.filamentId,
          input.location,
          input.initialWeightGrams ?? null,
          ...(input.spoolman
            ? [input.spoolman.serviceId, input.spoolman.spoolId]
            : []),
        ]),
      )
      .digest('hex')
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${access.appId + ':' + key}, 0))`
    const [existing] = await tx<
      {
        request_hash: string
        response: ReturnType<typeof physicalSpool> & {
          spoolman?: typeof input.spoolman
        }
      }[]
    >`
      SELECT request_hash, response FROM farm.integration_physical_spool_registrations
      WHERE app_id = ${access.appId}::uuid AND idempotency_key = ${key}`
    if (existing) {
      if (existing.request_hash !== hash)
        return { outcome: 'key-reused' as const }
      const { spoolman: bound, ...spool } = existing.response
      // A receipt outlives its spool. Never replay a deleted one as registered.
      // A reused spool number does not carry the old binding.
      const [current] = bound
        ? await tx`
            SELECT 1 FROM farm.integration_physical_spool_bindings
            WHERE farm_id = ${access.farmId}::uuid AND spool_id = ${spool.spoolId}
              AND spoolman_service_id = ${bound.serviceId}::uuid
              AND spoolman_spool_id = ${bound.spoolId}`
        : await tx`
            SELECT 1 FROM farm.spools
            WHERE farm_id = ${access.farmId}::uuid AND id = ${spool.spoolId}`
      if (!current) return { outcome: 'deleted' as const }
      return { outcome: 'registered' as const, spool }
    }
    const [filament] = await tx`
      SELECT id FROM farm.spool_filaments
      WHERE farm_id = ${access.farmId}::uuid AND id = ${input.filamentId}
      FOR KEY SHARE`
    if (!filament) return null
    if (input.spoolman) {
      const lock = JSON.stringify([
        access.farmId,
        input.spoolman.serviceId,
        input.spoolman.spoolId,
      ])
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'physical-spool-binding:' + lock}, 0))`
      const [duplicate] = await tx`
        SELECT 1 FROM farm.integration_physical_spool_bindings
        WHERE farm_id = ${access.farmId}::uuid
          AND spoolman_service_id = ${input.spoolman.serviceId}::uuid
          AND spoolman_spool_id = ${input.spoolman.spoolId}`
      if (duplicate) return { outcome: 'already-bound' as const }
      if (
        !(await hasCurrentSpoolObservation(
          tx,
          access.farmId,
          input.spoolman,
          membership,
        ))
      )
        return { outcome: 'spool-not-observed' as const }
    }
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
    const spool = physicalSpool(access.farmId, row)
    if (input.spoolman)
      await tx`INSERT INTO farm.integration_physical_spool_bindings
        (farm_id, spool_id, spoolman_service_id, spoolman_spool_id)
        VALUES (${access.farmId}::uuid, ${row.id},
          ${input.spoolman.serviceId}::uuid, ${input.spoolman.spoolId})`
    // The insert-only receipt serves idempotent replay only.
    const receipt = input.spoolman
      ? { ...spool, spoolman: input.spoolman }
      : spool
    await tx`INSERT INTO farm.integration_physical_spool_registrations
      (app_id, idempotency_key, request_hash, response)
      VALUES (${access.appId}::uuid, ${key}, ${hash}, ${tx.json(receipt)})`
    return { outcome: 'registered' as const, spool }
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
