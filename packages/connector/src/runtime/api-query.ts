import {
  ApiQueryFile,
  ApiQueryMacro,
  MAX_API_QUERY_ITEMS,
  MAX_API_QUERY_RESULT_BYTES,
  type ApiQueryReply,
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

export function createApiQueryReader(
  config: AgentRuntimeConfig,
  dataDirectory: string,
) {
  return async (query: ApiQueryRequest, signal: AbortSignal) => {
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
      if (query.kind === 'macros') {
        const { objects } = MoonrakerObjectList.parse(
          await client.request('printer.objects.list'),
        )
        return { macros: listMoonrakerMacros(objects) }
      }
      return { files: { backend: 'moonraker' as const, client } }
    }
    if (query.kind === 'macros') return undefined
    const files = createFileTargets({
      config,
      assignmentId: assignment.assignment_id,
      dataDirectory,
    }).fileList.targetFor(assignment.printer_key)
    if (!files) throw Error('File target unavailable')
    return { files }
  }
}

type QuerySource =
  { files: FileListTarget } | { macros: readonly string[] } | undefined

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
  page: Exclude<ApiQueryResult, { kind: 'error' }>,
  query: ApiQueryRequest,
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
