import type { Sql } from 'postgres'
import { uuidPattern } from './integration-auth.ts'

export function spoolLedgerQuery(query: URLSearchParams, fields: string[]) {
  const allowed = ['farmId', 'limit', ...fields]
  if (
    [...query.keys()].some(
      (key) => !allowed.includes(key) || query.getAll(key).length > 1,
    )
  )
    return null
  const farmId = query.get('farmId')?.toLowerCase()
  const limit = query.get('limit') ?? '50'
  if (
    (farmId !== undefined && !uuidPattern.test(farmId)) ||
    !/^(?:[1-9]\d?|100)$/.test(limit)
  )
    return null
  return { farmId, limit: Number(limit) }
}

export function spoolSearchQuery(query: URLSearchParams) {
  const base = spoolLedgerQuery(query, [
    'color',
    'material',
    'availability',
    'minRemainingGrams',
  ])
  const color = query.get('color')?.replace(/^#/, '') ?? null
  const material = query.get('material')?.trim() ?? null
  const availability = query.get('availability') ?? 'any'
  const minimum = query.get('minRemainingGrams')
  const minRemainingGrams = minimum === null ? null : Number(minimum)
  if (
    !base ||
    (color !== null && !/^[0-9a-f]{6}$/i.test(color)) ||
    (material !== null &&
      (!material || material.length > 64 || material.includes('\0'))) ||
    !['any', 'stored', 'loaded'].includes(availability) ||
    (minimum !== null &&
      (!/^\d+(?:\.\d+)?$/.test(minimum) || !Number.isFinite(minRemainingGrams)))
  )
    return null
  return { ...base, color, material, availability, minRemainingGrams }
}

function channel(hex: string, start: number) {
  return parseInt(hex.slice(start, start + 2), 16)
}

export async function searchIntegrationSpools(
  sql: Sql,
  farmIds: string[],
  query: NonNullable<ReturnType<typeof spoolSearchQuery>>,
) {
  const { color, material, availability, minRemainingGrams, limit } = query
  const red = color === null ? null : channel(color, 0)
  const green = color === null ? null : channel(color, 2)
  const blue = color === null ? null : channel(color, 4)
  const rows = await sql`
    WITH stock AS (
      SELECT s.farm_id, s.id, f.name, f.material, f.color_hex, NULLIF(btrim(s.location), '') AS location,
        CASE WHEN COALESCE(s.initial_weight, f.weight) IS NOT NULL
          THEN greatest(COALESCE(s.initial_weight, f.weight) - s.used_weight, 0) END AS remaining,
        CASE WHEN ${red}::int IS NOT NULL AND f.color_hex IS NOT NULL THEN sqrt(
          power(('x' || substr(f.color_hex, 1, 2))::bit(8)::int - ${red}::int, 2) +
          power(('x' || substr(f.color_hex, 3, 2))::bit(8)::int - ${green}::int, 2) +
          power(('x' || substr(f.color_hex, 5, 2))::bit(8)::int - ${blue}::int, 2)
        ) END AS distance,
        slots.loaded_at
      FROM farm.spools s
      JOIN farm.spool_filaments f ON f.farm_id = s.farm_id AND f.id = s.filament_id
      CROSS JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'printerId', a.printer_id, 'slotKind', a.slot_kind,
          'slotIndex', a.slot_index, 'assignedAt', a.assigned_at
        ) ORDER BY a.printer_id, a.slot_kind, a.slot_index) AS loaded_at
        FROM farm.spool_slot_assignments a
        JOIN farm.printer_assignments p
          ON p.farm_id = a.farm_id AND p.id = a.printer_id AND p.revoked_at IS NULL
        WHERE a.farm_id = s.farm_id AND a.spool_id = s.id AND a.unassigned_at IS NULL
      ) slots
      WHERE s.farm_id = ANY(${farmIds}::uuid[]) AND NOT s.archived
        AND (${material}::text IS NULL OR lower(f.material) = lower(${material}::text))
        AND (${red}::int IS NULL OR f.color_hex IS NOT NULL)
    )
    SELECT farm_id::text AS "farmId", id::float8 AS "spoolId", name, material,
      color_hex AS "colorHex", location, remaining AS "remainingGrams",
      distance::float8 AS "colorDistance", loaded_at IS NOT NULL AS loaded,
      COALESCE(loaded_at, '[]'::jsonb) AS "loadedAt"
    FROM stock
    WHERE (${minRemainingGrams}::float8 IS NULL OR remaining >= ${minRemainingGrams}::float8)
      AND (${availability} = 'any' OR (loaded_at IS NOT NULL) = (${availability} = 'loaded'))
    ORDER BY distance NULLS LAST, farm_id, id
    LIMIT ${limit}`
  return { data: rows, assessedAt: Date.now() }
}

export function spoolUsageQuery(query: URLSearchParams) {
  const base = spoolLedgerQuery(query, ['jobId', 'cursor'])
  const jobId = query.get('jobId')
  const cursor = query.get('cursor')?.toLowerCase() ?? null
  if (
    !base ||
    !jobId ||
    !/^[1-9]\d{0,18}$/.test(jobId) ||
    BigInt(jobId) > 9223372036854775807n ||
    (cursor !== null && !uuidPattern.test(cursor))
  )
    return null
  return { ...base, jobId, cursor }
}

export async function listIntegrationSpoolUsage(
  sql: Sql,
  farmIds: string[],
  { jobId, cursor, limit }: NonNullable<ReturnType<typeof spoolUsageQuery>>,
) {
  const rows = await sql<{ usageId: string }[]>`
    SELECT u.id::text AS "usageId", u.farm_id::text AS "farmId",
      u.job_id::text AS "jobId", u.spool_id::float8 AS "spoolId",
      u.printer_id::text AS "printerId", u.grams, u.source,
      u.created_at::float8 AS "observedAt", u.corrected_by IS NOT NULL AS corrected
    FROM farm.spool_usage_records u
    WHERE u.farm_id = ANY(${farmIds}::uuid[]) AND u.job_id = ${jobId}::bigint
      AND (${cursor}::uuid IS NULL OR u.id > ${cursor}::uuid)
    ORDER BY u.id LIMIT ${limit + 1}`
  const data = rows.slice(0, limit)
  return { data, nextCursor: rows.length > limit ? data.at(-1)!.usageId : null }
}
