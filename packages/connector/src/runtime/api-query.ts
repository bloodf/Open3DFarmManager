import { z } from 'zod'
import {
  INITIAL_COLLECTION_ATTEMPT,
  type QueueCollectionJournal,
} from '../control/queue-collection-journal.ts'
import {
  ApiQueryFile,
  ApiQueryMacro,
  MAX_API_QUERY_ITEMS,
  MAX_API_QUERY_RESULT_BYTES,
  type ApiDispatchObservation,
  type ApiQueryReply,
  type ApiSpoolMembership,
  type ApiQueryRequest,
  type ApiQueryResult,
} from '../../../farm-protocol/src/api-query.ts'
import { PrinterFile } from '../../../farm-protocol/src/file-list.ts'
import type { AgentRuntimeConfig } from '../config/runtime.ts'
import { readRuntimePrinterBinding } from '../control/printer-binding.ts'
import { validateMoonrakerInput } from '../config/moonraker.ts'
import { MoonrakerObjectList } from '../moonraker/control-support.ts'
import { listMoonrakerMacros } from '../moonraker/macros.ts'
import { createFileTargets } from './file-targets.ts'
import { readPrinterFiles, type FileListTarget } from './file-list.ts'
import { moonrakerQueryClient } from './api-query-moonraker.ts'
import { SPOOL_INVENTORY_STALE_MS } from '../../../farm-protocol/src/inventory.ts'
import type { SpoolmanSnapshot } from './spoolman-provider.ts'

export function createSpoolMembershipReader() {
  let current:
    | {
        inventory: NonNullable<SpoolmanSnapshot['inventory']>
        deadline: number
        observedAt: number
      }
    | undefined
  return {
    update(snapshot: SpoolmanSnapshot) {
      const { inventory, ageMs } = snapshot
      current = undefined
      if (snapshot.kind !== 'observed' || !inventory || ageMs === null) return
      const now = Date.now()
      const observedAt = Math.min(
        inventory.observedFrom,
        Math.floor(now - ageMs),
      )
      current = {
        inventory,
        observedAt,
        deadline:
          performance.now() + SPOOL_INVENTORY_STALE_MS - (now - observedAt),
      }
    },
    read(
      query: Extract<ApiQueryRequest, { kind: 'spool-membership' }>,
    ): ApiSpoolMembership | undefined {
      if (!current) return undefined
      const { inventory, deadline, observedAt } = current
      if (
        inventory.farmId.toLowerCase() !== query.farmId ||
        inventory.serviceId.toLowerCase() !== query.serviceId ||
        observedAt < 0 ||
        performance.now() >= deadline
      )
        return undefined
      return {
        kind: query.kind,
        serviceId: query.serviceId,
        spoolId: query.spoolId,
        present: inventory.items.some(({ id }) => id === query.spoolId),
        observedAt,
      }
    },
  }
}

export function createApiQueryReader(
  config: AgentRuntimeConfig,
  dataDirectory: string,
  collectionJournal?: QueueCollectionJournal,
  readSpoolMembership?: ReturnType<typeof createSpoolMembershipReader>['read'],
) {
  return async (query: ApiQueryRequest, signal: AbortSignal) => {
    if (query.kind === 'spool-membership') {
      const membership = readSpoolMembership?.(query)
      return membership ? { membership } : undefined
    }
    const binding = config.bindingFor(query.assignment_id)
    const assignment = binding && readRuntimePrinterBinding(binding)
    if (!assignment || assignment.assignment_id !== query.assignment_id)
      throw Error('Query assignment unavailable')
    const { collection } = config
    if ('moonraker_origin' in assignment && assignment.moonraker_origin) {
      const printer = collection.printers.find(
        (item) => item.printerKey === assignment.printer_key,
      )
      if (!printer) throw Error('Moonraker assignment unavailable')
      const selected = validateMoonrakerInput({
        assignment: printer,
        allowedOrigins: collection.allowedOrigins,
        limits: collection.limits,
      })
      if (selected.origin !== assignment.moonraker_origin)
        throw Error('Moonraker binding mismatch')
      const client = moonrakerQueryClient(
        selected.origin,
        selected.limits,
        signal,
      )
      if (query.kind === 'dispatch') {
        return {
          dispatch: await readDispatchObservation(
            () => client.request('printer.objects.query.dispatch'),
            () => collectionJournal?.read(assignment.printer_key),
          ),
        }
      }
      if (query.kind === 'macros') {
        const { objects } = MoonrakerObjectList.parse(
          await client.request('printer.objects.list'),
        )
        return { macros: listMoonrakerMacros(objects) }
      }
      return { files: { backend: 'moonraker' as const, client } }
    }
    if (query.kind !== 'files') return undefined
    const files = createFileTargets({
      config,
      assignmentId: assignment.assignment_id,
      dataDirectory,
    }).fileList.targetFor(assignment.printer_key)
    if (!files) throw Error('File target unavailable')
    return { files }
  }
}

const DispatchStatus = z.object({
  status: z.object({
    webhooks: z.object({ state: z.string() }),
    print_stats: z.object({ state: z.string() }),
  }),
})

export async function readDispatchObservation(
  query: () => Promise<unknown>,
  readCollection: () => ReturnType<QueueCollectionJournal['read']> | undefined,
  now: () => number = Date.now,
): Promise<ApiDispatchObservation> {
  const { status } = DispatchStatus.parse(await query())
  const state = status.print_stats.state
  const busy = state === 'printing' || state === 'paused'
  const printerState =
    status.webhooks.state !== 'ready'
      ? 'not-ready'
      : busy
        ? 'busy'
        : ['standby', 'complete', 'cancelled'].includes(state)
          ? 'idle'
          : 'not-ready'
  const observedAt = now()
  try {
    const collection = readCollection()
    const awaiting = collection?.attempts.findLast(
      (attempt) => attempt.status === 'awaiting-collection',
    )
    if (awaiting)
      return {
        printerState,
        observedAt,
        plateState: 'awaiting-collection',
        attemptId: awaiting.id,
      }
    const latest = collection?.attempts.at(-1)
    if (
      printerState === 'idle' &&
      collection &&
      !latest &&
      collection.dispatchedAt === undefined
    )
      return {
        printerState,
        observedAt,
        plateState: 'unknown',
        attemptId: INITIAL_COLLECTION_ATTEMPT,
      }
    if (
      printerState === 'idle' &&
      collection?.dispatchedAt === undefined &&
      latest?.status === 'collected'
    )
      return {
        printerState,
        observedAt,
        plateState: 'operator-confirmed',
        attemptId: latest.id,
      }
  } catch {
    // A failed journal cannot establish clearance.
  }
  return { printerState, observedAt, plateState: 'unknown' }
}

type QuerySource =
  | { files: FileListTarget }
  | { macros: readonly string[] }
  | { dispatch: ApiDispatchObservation }
  | { membership: ApiSpoolMembership }
  | undefined

export async function answerApiQuery(
  query: ApiQueryRequest,
  read: (query: ApiQueryRequest, signal: AbortSignal) => Promise<QuerySource>,
  signal: AbortSignal,
): Promise<ApiQueryReply> {
  let wire: string
  try {
    signal.throwIfAborted()
    const source = await read(query, signal)
    if (
      !source ||
      ('files' in source &&
        ['creality', 'anycubic'].includes(source.files.backend))
    ) {
      wire = JSON.stringify({
        kind: 'error',
        error: 'unsupported',
      } satisfies ApiQueryResult)
    } else if (query.kind === 'spool-membership' && 'membership' in source) {
      wire = JSON.stringify(source.membership)
    } else if (query.kind === 'dispatch' && 'dispatch' in source) {
      wire = JSON.stringify({
        kind: 'dispatch',
        data: [source.dispatch],
        nextOffset: null,
      } satisfies ApiQueryResult)
    } else if (query.kind === 'files' && 'files' in source) {
      const entries = await readPrinterFiles(source.files, {
        signal,
        authorized: () => !signal.aborted,
        previews: false,
      })
      const files = entries.flatMap((entry) => {
        const file = PrinterFile.safeParse(entry)
        if (!file.success) return []
        const data = ApiQueryFile.safeParse({
          name: file.data.name,
          sizeBytes: file.data.size,
          modifiedAt: Math.round(file.data.modified * 1000),
          ...(file.data.estimatedTime !== undefined
            ? { estimatedSeconds: file.data.estimatedTime }
            : {}),
        })
        return data.success ? [data.data] : []
      })
      if (
        source.files.backend === 'kobralink' &&
        new Set(files.map(({ name }) => name)).size !== files.length
      )
        throw Error('Ambiguous library filenames')
      wire = pageWire({ kind: 'files', data: files, nextOffset: null }, query)
    } else if (query.kind === 'macros' && 'macros' in source) {
      const macros = source.macros.flatMap((name) => {
        const macro = ApiQueryMacro.safeParse({ name })
        return macro.success ? [macro.data] : []
      })
      wire = pageWire({ kind: 'macros', data: macros, nextOffset: null }, query)
    } else {
      throw Error('Unexpected query source')
    }
    signal.throwIfAborted()
  } catch {
    wire = JSON.stringify({
      kind: 'error',
      error: 'connector-unavailable',
    } satisfies ApiQueryResult)
  }
  return {
    v: 1,
    t: 'connector.api-query-result',
    request_id: query.request_id,
    wire,
  }
}

function pageWire(
  page: Extract<ApiQueryResult, { kind: 'files' | 'macros' }>,
  query: Extract<ApiQueryRequest, { assignment_id: string }>,
) {
  const total = Math.min(page.data.length, MAX_API_QUERY_ITEMS)
  let end = Math.min(query.offset + query.limit, total)
  while (true) {
    const wire = JSON.stringify({
      kind: page.kind,
      data: page.data.slice(query.offset, end),
      nextOffset: end < total ? end : null,
    })
    if (Buffer.byteLength(wire) <= MAX_API_QUERY_RESULT_BYTES) return wire
    if (end <= query.offset + 1)
      throw Error('Query entry exceeds transfer budget')
    end--
  }
}
