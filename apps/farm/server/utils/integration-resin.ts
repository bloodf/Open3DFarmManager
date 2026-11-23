import { uuidPattern, type IntegrationPrincipal } from './integration-auth.ts'
import type { ResinLedgerRecord } from './resin-ledger/record.ts'

const cursorPattern = /^[A-Za-z0-9_-]{1,512}$/
const queryKeys = new Set(['farmId', 'limit', 'cursor'])

/** The ledger says `reported` for what the Connector observed; the API says `measured`. */
export type ResinSource = 'manual' | 'measured'
export type ResinQuantityState = 'known' | 'unknown'

/** One printer's ledger as the reader found it. `records` are newest first. */
export interface ResinPrinterLedger {
  printerId: string
  farmId: string
  printerKey: string
  records: ResinLedgerRecord[]
}

export interface ResinRunRow {
  id: string
  printerId: string
  outcome: 'completed' | 'cancelled' | 'failed'
  endedAt: number
}

export interface IntegrationResinReader {
  /** Printers that have a ledger, ordered by id, restricted to the given scope. */
  readLedgers(input: {
    farmWideFarmIds: string[]
    assignmentIds: string[]
    farmId?: string
    afterId?: string
    limit: number
  }): Promise<ResinPrinterLedger[]>
  /** Most recent finished runs of the given printers, newest first. */
  readRuns(printerIds: string[]): Promise<ResinRunRow[]>
}

export interface ResinQuantity {
  quantity: number | null
  unit: 'ml'
  quantityState: ResinQuantityState
  source: ResinSource
  /** When the ledger entry carrying this state was recorded or reported. */
  observedAt: number
}

export interface ResinLot extends ResinQuantity {
  /** The label the operator or Connector gave the bottle; the ledger has no other lot identity. */
  lotRef: string
}

export interface ResinVat extends ResinQuantity {
  vatRef: string
  current: boolean
}

export interface ResinReading {
  target: 'vat' | 'bottle'
  ref: string
  quantity: number
  unit: 'ml'
  source: ResinSource
  observedAt: number
}

export interface ResinRunConsumption {
  runRef: string
  outcome: ResinRunRow['outcome']
  endedAt: number
  /** The ledger never links a reading to a run, so consumption is never inferred. */
  consumption: { state: 'unknown' }
}

const sourceOf = (source: 'manual' | 'reported'): ResinSource =>
  source === 'reported' ? 'measured' : 'manual'

type Page<T> = { data: T[]; nextCursor: string | null }

export function resinGrantScope(
  principal: IntegrationPrincipal,
  farmId?: string,
) {
  const grants = principal.grants.filter(
    (grant) =>
      grant.scopes.includes('inventory:read') &&
      (farmId === undefined || grant.farmId === farmId),
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
          grant.printerAssignmentId === null ? [] : [grant.printerAssignmentId],
        ),
      ),
    ],
  }
}

function covers(
  scope: ReturnType<typeof resinGrantScope>,
  row: { farmId: string; printerId: string },
) {
  return (
    scope.farmWideFarmIds.includes(row.farmId) ||
    scope.assignmentIds.includes(row.printerId)
  )
}

function decodedCursor(cursor: string | null) {
  if (cursor === null) return undefined
  if (!cursorPattern.test(cursor)) return null
  try {
    const bytes = Buffer.from(cursor, 'base64url')
    if (bytes.toString('base64url') !== cursor) return null
    const value = JSON.parse(bytes.toString()) as { id?: unknown }
    return typeof value.id === 'string' && uuidPattern.test(value.id)
      ? value.id.toLowerCase()
      : null
  } catch {
    return null
  }
}

const encodedCursor = (id: string) =>
  Buffer.from(JSON.stringify({ id })).toString('base64url')

export function parseResinQuery(query: URLSearchParams):
  | ResinError
  | {
      error?: undefined
      farmId: string | undefined
      afterId: string | undefined
      limit: number
    } {
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
  const afterId = decodedCursor(cursors[0] ?? null)
  if (afterId === null) return { error: 'invalid-request' as const }
  const rawLimit = limits[0]
  if (rawLimit !== undefined && !/^(?:[1-9]\d?|100)$/.test(rawLimit))
    return { error: 'invalid-request' as const }
  return {
    farmId,
    afterId,
    limit: rawLimit === undefined ? 50 : Number(rawLimit),
  }
}

/**
 * Latest state of every bottle. The newest entry for a name wins; a bottle
 * recorded without a volume stays unknown rather than reading zero.
 */
export function resinLots(records: readonly ResinLedgerRecord[]): ResinLot[] {
  const lots = new Map<string, ResinLot>()
  for (const { entry, recordedAt } of newestFirst(records)) {
    if (
      entry.kind !== 'bottle' &&
      !(entry.kind === 'volume' && entry.target === 'bottle')
    )
      continue
    if (lots.has(entry.name)) continue
    const quantity = entry.volumeMl
    lots.set(entry.name, {
      lotRef: entry.name,
      quantity,
      unit: 'ml',
      quantityState: quantity === null ? 'unknown' : 'known',
      source: sourceOf(entry.source),
      observedAt: recordedAt,
    })
  }
  return [...lots.values()].sort(byRef((lot) => lot.lotRef))
}

/**
 * Every vat the ledger names. The newest vat change is the current vat. A
 * volume reading only counts when it is not older than the vat's latest change,
 * so a refilled or swapped vat never inherits an earlier amount.
 */
export function resinVats(records: readonly ResinLedgerRecord[]): ResinVat[] {
  const ordered = newestFirst(records)
  const changes = new Map<string, { source: ResinSource; observedAt: number }>()
  let current: string | undefined
  for (const { entry, recordedAt } of ordered) {
    if (entry.kind !== 'vat') continue
    current ??= entry.name
    if (!changes.has(entry.name))
      changes.set(entry.name, {
        source: sourceOf(entry.source),
        observedAt: recordedAt,
      })
  }
  const volumes = ordered.flatMap(({ entry, recordedAt }) =>
    entry.kind === 'volume' && entry.target === 'vat'
      ? [
          {
            name: entry.name,
            volumeMl: entry.volumeMl,
            source: sourceOf(entry.source),
            recordedAt,
          },
        ]
      : [],
  )
  const vats: ResinVat[] = []
  for (const [name, change] of changes) {
    const reading = volumes.find(
      (volume) =>
        volume.name === name && volume.recordedAt >= change.observedAt,
    )
    vats.push({
      vatRef: name,
      current: name === current,
      quantity: reading?.volumeMl ?? null,
      unit: 'ml',
      quantityState: reading ? 'known' : 'unknown',
      source: reading?.source ?? change.source,
      observedAt: reading?.recordedAt ?? change.observedAt,
    })
  }
  return vats.sort(byRef((vat) => vat.vatRef))
}

/** Observed amounts over time, so a reviewer can compare readings without guessing. */
export function resinReadings(
  records: readonly ResinLedgerRecord[],
  limit = 50,
): ResinReading[] {
  const readings: ResinReading[] = []
  for (const { entry, recordedAt } of newestFirst(records)) {
    if (readings.length >= limit) break
    if (entry.kind === 'volume')
      readings.push({
        target: entry.target,
        ref: entry.name,
        quantity: entry.volumeMl,
        unit: 'ml',
        source: sourceOf(entry.source),
        observedAt: recordedAt,
      })
    else if (entry.kind === 'bottle' && entry.volumeMl !== null)
      readings.push({
        target: 'bottle',
        ref: entry.name,
        quantity: entry.volumeMl,
        unit: 'ml',
        source: sourceOf(entry.source),
        observedAt: recordedAt,
      })
  }
  return readings
}

export function resinRunConsumption(
  runs: readonly ResinRunRow[],
): ResinRunConsumption[] {
  return runs.map((run) => ({
    runRef: run.id,
    outcome: run.outcome,
    endedAt: run.endedAt,
    consumption: { state: 'unknown' },
  }))
}

function newestFirst(records: readonly ResinLedgerRecord[]) {
  return [...records].sort(
    (a, b) => b.recordedAt - a.recordedAt || b.id.localeCompare(a.id),
  )
}

const byRef =
  <T>(ref: (value: T) => string) =>
  (a: T, b: T) =>
    ref(a).localeCompare(ref(b), 'pt-BR')

type ResinError = { error: 'invalid-request' | 'not-found' }

async function page(
  principal: IntegrationPrincipal,
  reader: IntegrationResinReader,
  query: URLSearchParams,
): Promise<
  | ResinError
  | {
      error?: undefined
      printers: ResinPrinterLedger[]
      nextCursor: string | null
    }
> {
  const parsed = parseResinQuery(query)
  if (parsed.error) return { error: parsed.error }
  const scope = resinGrantScope(principal, parsed.farmId)
  if (!scope.farmWideFarmIds.length && !scope.assignmentIds.length)
    return { error: 'not-found' as const }
  const rows = await reader.readLedgers({
    ...scope,
    ...(parsed.farmId ? { farmId: parsed.farmId } : {}),
    ...(parsed.afterId ? { afterId: parsed.afterId } : {}),
    limit: parsed.limit + 1,
  })
  // The reader is trusted to filter, but never reveal a printer outside the grant.
  const allowed = rows.filter((row) => covers(scope, row))
  const printers = allowed.slice(0, parsed.limit)
  const hasMore = allowed.length > parsed.limit
  return {
    printers,
    nextCursor:
      hasMore && printers.length
        ? encodedCursor(printers[printers.length - 1]!.printerId)
        : null,
  }
}

const identity = (printer: ResinPrinterLedger) => ({
  printerId: printer.printerId,
  farmId: printer.farmId,
  printerKey: printer.printerKey,
})

export async function listIntegrationResinLots(
  principal: IntegrationPrincipal,
  reader: IntegrationResinReader,
  query: URLSearchParams,
): Promise<
  ResinError | Page<ReturnType<typeof identity> & { lots: ResinLot[] }>
> {
  const result = await page(principal, reader, query)
  if (result.error) return { error: result.error }
  return {
    data: result.printers.map((printer) => ({
      ...identity(printer),
      lots: resinLots(printer.records),
    })),
    nextCursor: result.nextCursor,
  }
}

export async function listIntegrationResinVats(
  principal: IntegrationPrincipal,
  reader: IntegrationResinReader,
  query: URLSearchParams,
): Promise<
  ResinError | Page<ReturnType<typeof identity> & { vats: ResinVat[] }>
> {
  const result = await page(principal, reader, query)
  if (result.error) return { error: result.error }
  return {
    data: result.printers.map((printer) => ({
      ...identity(printer),
      vats: resinVats(printer.records),
    })),
    nextCursor: result.nextCursor,
  }
}

export async function listIntegrationResinUsage(
  principal: IntegrationPrincipal,
  reader: IntegrationResinReader,
  query: URLSearchParams,
): Promise<
  | ResinError
  | Page<
      ReturnType<typeof identity> & {
        readings: ResinReading[]
        runs: ResinRunConsumption[]
      }
    >
> {
  const result = await page(principal, reader, query)
  if (result.error) return { error: result.error }
  const ids = new Set(result.printers.map((printer) => printer.printerId))
  const runs = ids.size
    ? (await reader.readRuns([...ids])).filter((run) => ids.has(run.printerId))
    : []
  return {
    data: result.printers.map((printer) => ({
      ...identity(printer),
      readings: resinReadings(printer.records),
      runs: resinRunConsumption(
        runs.filter((run) => run.printerId === printer.printerId),
      ),
    })),
    nextCursor: result.nextCursor,
  }
}
