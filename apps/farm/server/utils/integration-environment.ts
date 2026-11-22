import { PrinterState } from '@open3dfarmmanager/farm-protocol'
import {
  uuidPattern,
  type IntegrationPrincipal,
  type IntegrationPrinterRow,
} from './integration-auth.ts'
import type { IntegrationPrinterReader } from './integration-printers.ts'

const cursorPattern = /^[A-Za-z0-9_-]{1,512}$/
const queryKeys = new Set(['farmId', 'limit', 'cursor'])

/** A reading older than this is no longer treated as the current value. */
export const ENVIRONMENT_STALE_AFTER_MS = 60_000

export type EnvironmentKind = 'temperature' | 'humidity' | 'air' | 'power'

export type EnvironmentMeasurement =
  | {
      kind: EnvironmentKind
      state: 'known'
      value: number | boolean
      unit: 'percent' | 'celsius' | 'boolean'
      lastObservedAt: number
    }
  | {
      kind: EnvironmentKind
      state: 'unknown'
      reason: 'never-observed' | 'offline' | 'stale'
      /** Present when something was observed before the value was lost. */
      lastObservedAt?: number
    }
  | { kind: EnvironmentKind; state: 'unsupported' }

export interface EnvironmentPrinter {
  printerId: string
  farmId: string
  printerKey: string
  displayName?: string
  location?: string
  measurements: EnvironmentMeasurement[]
}

/**
 * Today the Connector reports one environment value to the farm: the chamber
 * fan (air/extraction) speed. Chamber temperature, humidity and power-device
 * state are not part of the printer state, so they report `unsupported` rather
 * than a guess. Switching and safety controls are never exposed here.
 */
function airMeasurement(
  row: IntegrationPrinterRow,
  now: number,
): EnvironmentMeasurement {
  const parsed = PrinterState.safeParse(row.state)
  if (!parsed.success) return unknown('never-observed')
  const state = parsed.data
  const observedAt = state.observedAt
  if (state.state === 'offline' || state.linkHealth?.state === 'offline')
    return unknown('offline', observedAt)
  if (now - observedAt > ENVIRONMENT_STALE_AFTER_MS)
    return unknown('stale', observedAt)
  const chamber = state.fans?.chamber
  if (chamber === undefined) return { kind: 'air', state: 'unsupported' }
  return {
    kind: 'air',
    state: 'known',
    value: chamber,
    unit: 'percent',
    lastObservedAt: observedAt,
  }
}

function unknown(
  reason: 'never-observed' | 'offline' | 'stale',
  lastObservedAt?: number,
): EnvironmentMeasurement {
  return {
    kind: 'air',
    state: 'unknown',
    reason,
    ...(lastObservedAt !== undefined ? { lastObservedAt } : {}),
  }
}

export function environmentForPrinter(
  row: IntegrationPrinterRow,
  now: number,
): EnvironmentPrinter {
  return {
    printerId: row.id,
    farmId: row.farmId,
    printerKey: row.printerKey,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.location ? { location: row.location } : {}),
    measurements: [
      { kind: 'temperature', state: 'unsupported' },
      { kind: 'humidity', state: 'unsupported' },
      airMeasurement(row, now),
      { kind: 'power', state: 'unsupported' },
    ],
  }
}

function decodedCursor(cursor: string | null) {
  if (cursor === null) return undefined
  if (!cursorPattern.test(cursor)) return null
  try {
    const bytes = Buffer.from(cursor, 'base64url')
    if (bytes.toString('base64url') !== cursor) return null
    const value = JSON.parse(bytes.toString()) as {
      id?: unknown
      snapshotAt?: unknown
    }
    return typeof value.id === 'string' &&
      uuidPattern.test(value.id) &&
      typeof value.snapshotAt === 'number' &&
      Number.isSafeInteger(value.snapshotAt) &&
      value.snapshotAt >= 0
      ? { id: value.id.toLowerCase(), snapshotAt: value.snapshotAt }
      : null
  } catch {
    return null
  }
}

export async function listIntegrationEnvironment(
  principal: IntegrationPrincipal,
  reader: Pick<IntegrationPrinterReader, 'readPrinters'>,
  query: URLSearchParams,
  now: number = Date.now(),
) {
  if ([...query.keys()].some((key) => !queryKeys.has(key)))
    return { error: 'invalid-request' as const }
  const farmIds = query.getAll('farmId')
  const cursors = query.getAll('cursor')
  const limits = query.getAll('limit')
  if (farmIds.length > 1 || cursors.length > 1 || limits.length > 1)
    return { error: 'invalid-request' as const }
  const farmId = farmIds[0]?.toLowerCase()
  if (farmId !== undefined && !uuidPattern.test(farmId))
    return { error: 'invalid-request' as const }
  const cursor = decodedCursor(cursors[0] ?? null)
  if (cursor === null) return { error: 'invalid-request' as const }
  const rawLimit = limits[0]
  if (rawLimit !== undefined && !/^(?:[1-9]\d?|100)$/.test(rawLimit))
    return { error: 'invalid-request' as const }
  const limit = rawLimit === undefined ? 50 : Number(rawLimit)

  const grants = principal.grants.filter(
    (grant) =>
      grant.scopes.includes('environment:read') &&
      (farmId === undefined || grant.farmId === farmId),
  )
  const farmWideFarmIds = [
    ...new Set(
      grants
        .filter((grant) => grant.printerAssignmentId === null)
        .map((grant) => grant.farmId),
    ),
  ]
  const assignmentIds = [
    ...new Set(
      grants.flatMap((grant) =>
        grant.printerAssignmentId === null ? [] : [grant.printerAssignmentId],
      ),
    ),
  ]
  const grantedFarmIds = [...new Set(grants.map((grant) => grant.farmId))]
  if (!grantedFarmIds.length) return { error: 'not-found' as const }

  const snapshotAt = cursor?.snapshotAt ?? now
  const rows = await reader.readPrinters({
    farmIds: grantedFarmIds,
    farmWideFarmIds,
    assignmentIds,
    ...(farmId ? { farmId } : {}),
    ...(cursor ? { afterId: cursor.id } : {}),
    snapshotAt,
    limit: limit + 1,
  })
  // Defence in depth: never reveal a printer outside the grant.
  const allowed = rows.filter(
    (row) =>
      farmWideFarmIds.includes(row.farmId) || assignmentIds.includes(row.id),
  )
  const data = allowed.slice(0, limit)
  const last = data[data.length - 1]
  return {
    data: data.map((row) => environmentForPrinter(row, now)),
    nextCursor:
      allowed.length > limit && last
        ? Buffer.from(JSON.stringify({ id: last.id, snapshotAt })).toString(
            'base64url',
          )
        : null,
  }
}
