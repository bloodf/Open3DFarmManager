import {
  PrinterState,
  activeSpoolsFromMaterials,
} from '@open3dfarmmanager/farm-protocol'
import {
  type IntegrationPrincipal,
  type IntegrationPrinterRow,
  uuidPattern,
} from '../integration-auth.ts'
import type { IntegrationPrinterReader } from '../integration-printers.ts'
import type { FarmAlertKind } from '../../../app/utils/farm-alerts.ts'
import { alertsForPrinter, type ApiPrinterAlert } from './printer-alerts.ts'

const cursorPattern = /^[A-Za-z0-9_-]{1,512}$/

export interface BulkPrinterStatus {
  printerId: string
  farmId: string
  printerKey: string
  displayName?: string | null
  groupName?: string | null
  location?: string | null
  state: string
  progress?: number
  filename?: string
  estimatedRemainingSeconds?: number
  temperatures?: { toolCelsius?: number; bedCelsius?: number }
  vendor?: string
  model?: string
  activeSpools?: ReturnType<typeof activeSpoolsFromMaterials>
  observedAt?: number
  alerts: ApiPrinterAlert[]
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

function authorizedRows(principal: IntegrationPrincipal, farmId?: string) {
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

function toStatus(
  row: IntegrationPrinterRow,
  nowWall: number,
  disabled: ReadonlySet<FarmAlertKind> | undefined,
): BulkPrinterStatus {
  const status: BulkPrinterStatus = {
    printerId: row.id,
    farmId: row.farmId,
    printerKey: row.printerKey,
    state: 'unknown',
    alerts: alertsForPrinter(row, nowWall).filter(
      (alert) => !disabled?.has(alert.kind),
    ),
  }
  if (row.displayName !== undefined) status.displayName = row.displayName
  if (row.groupName !== undefined) status.groupName = row.groupName
  if (row.location !== undefined) status.location = row.location
  const parsed = PrinterState.safeParse(row.state)
  if (parsed.success) {
    status.state = parsed.data.state
    if (parsed.data.progress !== undefined)
      status.progress = parsed.data.progress
    if (parsed.data.filename !== undefined)
      status.filename = parsed.data.filename
    if (parsed.data.estimatedRemainingSeconds !== undefined)
      status.estimatedRemainingSeconds = parsed.data.estimatedRemainingSeconds
    const temperatures: { toolCelsius?: number; bedCelsius?: number } = {}
    if (parsed.data.toolTemperatureCelsius !== undefined)
      temperatures.toolCelsius = parsed.data.toolTemperatureCelsius
    if (parsed.data.bedTemperatureCelsius !== undefined)
      temperatures.bedCelsius = parsed.data.bedTemperatureCelsius
    if (Object.keys(temperatures).length) status.temperatures = temperatures
    const { vendor, model } = parsed.data.identity ?? {}
    if (vendor !== undefined) status.vendor = vendor
    if (model !== undefined) status.model = model
    const activeSpools = activeSpoolsFromMaterials(parsed.data.materials)
    if (activeSpools?.length) status.activeSpools = activeSpools
  }
  if (row.observedAt !== null) status.observedAt = row.observedAt
  return status
}

export async function listBulkPrinterStatus(
  principal: IntegrationPrincipal,
  reader: IntegrationPrinterReader,
  query: URLSearchParams,
  nowWall = Date.now(),
  readDisabled?: (
    farmIds: string[],
  ) => Promise<{ farmId: string; kind: FarmAlertKind }[]>,
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

  const grants = authorizedRows(principal, farmId)
  if (!grants.farmIds.length) return { error: 'not-found' as const }
  const snapshotAt = cursor?.snapshotAt ?? nowWall
  const rows = await reader.readPrinters({
    ...grants,
    ...(farmId ? { farmId } : {}),
    ...(cursor ? { afterId: cursor.id } : {}),
    snapshotAt,
    limit: limit + 1,
  })
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  const disabled = new Map<string, Set<FarmAlertKind>>()
  if (readDisabled && page.length) {
    const overrides = await readDisabled([
      ...new Set(page.map((row) => row.farmId)),
    ])
    for (const { farmId, kind } of overrides) {
      const kinds = disabled.get(farmId) ?? new Set<FarmAlertKind>()
      kinds.add(kind)
      disabled.set(farmId, kinds)
    }
  }
  return {
    data: page.map((row) => toStatus(row, nowWall, disabled.get(row.farmId))),
    nextCursor: hasMore
      ? encodedCursor(page[page.length - 1]!.id, snapshotAt)
      : null,
  }
}
