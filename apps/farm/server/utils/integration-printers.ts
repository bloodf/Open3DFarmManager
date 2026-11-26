import {
  PrinterState,
  activeSpoolsFromMaterials,
} from '@open3dfarmmanager/farm-protocol'
import {
  type IntegrationPrincipal,
  type IntegrationPrinterRow,
  uuidPattern,
} from './integration-auth.ts'
import { integrationGrantFor } from './integration-auth-http.ts'

const cursorPattern = /^[A-Za-z0-9_-]{1,512}$/

export interface IntegrationPrinterReader {
  readPrinters(input: {
    farmIds: string[]
    farmWideFarmIds: string[]
    assignmentIds: string[]
    farmId?: string
    afterId?: string
    snapshotAt: number
    limit: number
  }): Promise<IntegrationPrinterRow[]>
  readPrinter(printerId: string): Promise<IntegrationPrinterRow | null>
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

const PLATE_ATTEMPT_ID = /^(?:0|[1-9][0-9]{0,15})$/

/**
 * Plate occupancy derived from the controls the Connector last advertised.
 * `confirm_collection` is offered only while a finished run still holds the
 * bed, and `lastJob.endedAt` is the attempt id that release must name.
 */
export function awaitingCollectionPlate(
  state:
    | {
        controls?: readonly string[] | undefined
        lastJob?: { endedAt?: number | undefined } | undefined
      }
    | undefined,
): { state: 'awaiting-collection'; attemptId?: string } | undefined {
  if (!state?.controls?.includes('confirm_collection')) return undefined
  const attemptId =
    state.lastJob?.endedAt === undefined ? '' : String(state.lastJob.endedAt)
  return {
    state: 'awaiting-collection',
    ...(PLATE_ATTEMPT_ID.test(attemptId) ? { attemptId } : {}),
  }
}

function parsedState(row: IntegrationPrinterRow) {
  return PrinterState.safeParse(row.state)
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

export interface IntegrationPrinterSpecs {
  buildVolumeMm?: { x: number; y: number; z: number }
  nozzles?: { diameterMm: number }[]
  spoolSlots?: number
  multicolor?: boolean
}

/**
 * Read-only physical specs from what the Connector reported (`machine` and
 * `materials`). Unknown members are omitted, never guessed; `undefined` means
 * nothing is known.
 */
export function printerSpecs(
  state: ReturnType<typeof parsedState>,
): IntegrationPrinterSpecs | undefined {
  if (!state.success) return undefined
  const { machine, materials } = state.data
  const specs: IntegrationPrinterSpecs = {}
  if (machine?.bedSizeMm) {
    const { x, y, z } = machine.bedSizeMm
    specs.buildVolumeMm = { x, y, z }
  }
  if (machine?.nozzleDiametersMm?.length)
    specs.nozzles = machine.nozzleDiametersMm.map((diameterMm) => ({
      diameterMm,
    }))
  const slots = materials?.length
    ? new Set(materials.map((material) => material.slot)).size
    : undefined
  if (slots !== undefined) specs.spoolSlots = slots
  const tools = machine?.toolCount ?? machine?.nozzleDiametersMm?.length
  if ((tools !== undefined && tools > 1) || (slots !== undefined && slots > 1))
    specs.multicolor = true
  else if (tools === 1 && slots === 1) specs.multicolor = false
  return Object.keys(specs).length ? specs : undefined
}

function toPrinter(row: IntegrationPrinterRow, mayStop: boolean) {
  const parsed = parsedState(row)
  const data = {
    id: row.id,
    farmId: row.farmId,
    printerKey: row.printerKey,
    // `clear_hold` is a browser-only operator action, never an API action.
    // `emergency_stop` is offered only to an app granted control:emergency.
    controls: parsed.success
      ? (parsed.data.controls ?? []).filter(
          (action) =>
            action !== 'clear_hold' && (mayStop || action !== 'emergency_stop'),
        )
      : [],
    sandbox: row.sandbox,
  } as Record<string, unknown>
  if (parsed.success) {
    const { vendor, model } = parsed.data.identity ?? {}
    if (vendor !== undefined) data.vendor = vendor
    if (model !== undefined) data.model = model
    const specs = printerSpecs(parsed)
    if (specs) data.specs = specs
  }
  return data
}

export async function listIntegrationPrinters(
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

  const grants = authorizedRows(principal, farmId)
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
    data: page.map((row) =>
      toPrinter(
        row,
        !!integrationGrantFor(
          {
            ...principal,
            grants: principal.emergencyGrants ?? principal.grants,
          },
          'control:emergency',
          row.farmId,
          row.id,
        ),
      ),
    ),
    nextCursor: hasMore
      ? encodedCursor(page[page.length - 1]!.id, snapshotAt)
      : null,
  }
}

export async function getIntegrationPrinterStatus(
  principal: IntegrationPrincipal,
  reader: Pick<IntegrationPrinterReader, 'readPrinter'>,
  printerId: string,
) {
  if (!uuidPattern.test(printerId)) return { error: 'not-found' as const }
  const row = await reader.readPrinter(printerId)
  if (
    !row ||
    !integrationGrantFor(principal, 'printers:read', row.farmId, row.id)
  )
    return { error: 'not-found' as const }

  const status: {
    printerId: string
    farmId: string
    printerKey: string
    state: string
    progress?: number
    statusReason?: PrinterState['statusReason']
    filename?: string
    estimatedRemainingSeconds?: number
    temperatures?: { toolCelsius?: number; bedCelsius?: number }
    vendor?: string
    model?: string
    activeSpools?: ReturnType<typeof activeSpoolsFromMaterials>
    observedAt?: number
    timestampSkewed?: boolean
    plate?: { state: 'awaiting-collection'; attemptId?: string }
  } = {
    printerId: row.id,
    farmId: row.farmId,
    printerKey: row.printerKey,
    state: 'unknown',
  }
  const parsed = parsedState(row)
  if (parsed.success) {
    status.state = parsed.data.state
    if (parsed.data.statusReason !== undefined)
      status.statusReason = parsed.data.statusReason
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
    const plate = awaitingCollectionPlate(parsed.data)
    if (plate) status.plate = plate
  }
  if (row.observedAt !== null) {
    if (row.observedAt <= Date.now()) status.observedAt = row.observedAt
    else status.timestampSkewed = true
  }
  return status
}
