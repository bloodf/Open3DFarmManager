import { PrinterState } from '@open3dfarmmanager/farm-protocol'
import {
  type IntegrationPrincipal,
  type IntegrationPrinterRow,
  uuidPattern,
} from './integration-auth.ts'
import { observationIsStale } from './integration-environment.ts'
import type { IntegrationPrinterReader } from './integration-printers.ts'
import {
  printerDegradedReason,
  qualifyPrinterState,
  type PrinterDegradedReason,
  type PrinterOperation,
} from './integration-capabilities.ts'

const cursorPattern = /^[A-Za-z0-9_-]{1,512}$/

export interface PrinterReadiness {
  printerId: string
  farmId: string
  printerKey: string
  paired: boolean
  eligible: boolean
  observedAt: number | null
  degradedReason: PrinterDegradedReason | 'firmware-shutdown' | 'stale' | null
  setupPath: string
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
      ? { id: value.id, snapshotAt: value.snapshotAt }
      : null
  } catch {
    return null
  }
}

function encodedCursor(id: string, snapshotAt: number) {
  return Buffer.from(JSON.stringify({ id, snapshotAt })).toString('base64url')
}

function grantedPrinters(principal: IntegrationPrincipal, farmId?: string) {
  const grants = principal.grants.filter(
    (grant) =>
      grant.scopes.includes('printers:read') &&
      (farmId === undefined || grant.farmId === farmId),
  )
  return {
    farmIds: [...new Set(grants.map((grant) => grant.farmId))],
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
          grant.printerAssignmentId === null ? [] : [grant.printerAssignmentId],
        ),
      ),
    ],
  }
}

function shopCanSelect(operation: PrinterOperation) {
  switch (operation) {
    case 'supported-control':
    case 'monitoring-only':
      return true
    case 'unknown-firmware':
    case 'temporarily-unavailable':
    case 'unqualified':
      return false
    default: {
      const unreachable: never = operation
      return unreachable
    }
  }
}

/** Owner path on this OpenFarm server. Not a printer address and not a command. */
export function printerSetupPath(printerKey: string, farmId: string) {
  return `/impressoras/${encodeURIComponent(printerKey)}?farm=${encodeURIComponent(farmId.toLowerCase())}`
}

export function printerReadiness(
  row: IntegrationPrinterRow,
  now = Date.now(),
): PrinterReadiness {
  const parsed = PrinterState.safeParse(row.state)
  const qualification = qualifyPrinterState(row.state)
  const timestamp =
    row.observedAt ?? (parsed.success ? parsed.data.observedAt : null)
  const observedAt = timestamp !== null && timestamp <= now ? timestamp : null
  const degradedReason =
    (parsed.success &&
    parsed.data.state === 'error' &&
    parsed.data.statusReason === 'firmware-shutdown'
      ? ('firmware-shutdown' as const)
      : parsed.success
        ? printerDegradedReason(parsed.data)
        : null) ??
    (observedAt !== null && observationIsStale(observedAt, now)
      ? 'stale'
      : null)
  return {
    printerId: row.id,
    farmId: row.farmId,
    printerKey: row.printerKey,
    paired: true,
    eligible:
      shopCanSelect(qualification.operation) &&
      degradedReason === null &&
      observedAt !== null,
    observedAt,
    degradedReason,
    setupPath: printerSetupPath(row.printerKey, row.farmId),
  }
}

export async function listIntegrationPrinterReadiness(
  principal: IntegrationPrincipal,
  reader: IntegrationPrinterReader,
  query: URLSearchParams,
) {
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
  const limit = rawLimit === undefined ? 50 : Number(rawLimit)
  if (
    rawLimit !== undefined &&
    (!/^\d+$/.test(rawLimit) || limit < 1 || limit > 100)
  )
    return { error: 'invalid-request' as const }

  const grants = grantedPrinters(principal, farmId)
  if (!grants.farmIds.length) return { error: 'not-found' as const }
  const snapshotAt = cursor?.snapshotAt ?? Date.now()
  const rows = await reader.readPrinters({
    ...grants,
    ...(farmId ? { farmId } : {}),
    ...(cursor ? { afterId: cursor.id } : {}),
    snapshotAt,
    limit: limit + 1,
  })
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  return {
    data: page.map((row) => printerReadiness(row)),
    nextCursor: hasMore
      ? encodedCursor(page[page.length - 1]!.id, snapshotAt)
      : null,
  }
}
