import { createHash } from 'node:crypto'
import { createError, type RequestEvent } from 'nuxt/server'
import { authResponse, sealedSessionRecordId } from './authenticated-session.ts'
import { authRuntime, type AuthRuntime } from '../utils/auth/runtime.ts'
import { inventoryUuid } from '../storage/postgres-connector-inventory.ts'
import {
  printerStatesRuntime,
  type PrinterStateReader,
} from '../utils/printer-states/runtime.ts'
import type {
  PrinterStateRow,
  PrinterStatesFailure,
} from './printer-states-core.ts'

/** Upper bound of printers in one response, so the payload stays bounded. */
export const STATUS_SUMMARY_MAX_PRINTERS = 500

export interface StatusSummaryPrinter {
  assignmentId: string
  printerKey: string
  displayName: string | null
  groupName: string | null
  location: string | null
  state: PrinterStateRow['state']
  /** Absent when the printer reported no progress; never coerced to zero. */
  progress?: number
  temperatures: { toolCelsius?: number; bedCelsius?: number }
  observedAt: number
  dataAgeMs: number
}

export interface StatusSummary {
  generatedAt: number
  total: number
  counts: Record<string, number>
  truncated: boolean
  printers: StatusSummaryPrinter[]
}

function failure(reason: PrinterStatesFailure['reason']): never {
  switch (reason) {
    case 'invalid-input':
      throw createError({ status: 400, message: 'Farm inválida.' })
    case 'unauthorized':
      throw createError({
        status: 401,
        message: 'Entre novamente para consultar o painel.',
      })
    case 'forbidden':
      // A farm the caller cannot see does not exist for the caller.
      throw createError({
        status: 404,
        message: 'Farm indisponível para esta conta.',
      })
    case 'storage-unavailable':
      throw createError({
        status: 503,
        message: 'Resumo de status indisponível. Tente novamente.',
      })
  }
}

const text = (value: string | null | undefined) => value ?? null

/** Deterministic order: group, sort order, display name, then key. */
function compareRows(a: PrinterStateRow, b: PrinterStateRow): number {
  const key = (r: PrinterStateRow) =>
    [
      text(r.groupName) ?? '',
      String(r.sortOrder ?? 0).padStart(6, '0'),
      text(r.displayName) ?? r.printerKey,
      r.printerKey,
      r.assignmentId,
    ].join('\u0000')
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0
}

export function buildStatusSummary(
  rows: readonly PrinterStateRow[],
  now: number,
): StatusSummary {
  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1
  const printers = [...rows]
    .sort(compareRows)
    .slice(0, STATUS_SUMMARY_MAX_PRINTERS)
    .map((row) => ({
      assignmentId: row.assignmentId,
      printerKey: row.printerKey,
      displayName: text(row.displayName),
      groupName: text(row.groupName),
      location: text(row.location),
      state: row.state,
      ...(row.progress !== undefined ? { progress: row.progress } : {}),
      temperatures: {
        ...(row.toolTemperatureCelsius !== undefined
          ? { toolCelsius: row.toolTemperatureCelsius }
          : {}),
        ...(row.bedTemperatureCelsius !== undefined
          ? { bedCelsius: row.bedTemperatureCelsius }
          : {}),
      },
      observedAt: row.observedAt,
      dataAgeMs: Math.max(0, now - row.observedAt),
    }))
  return {
    generatedAt: now,
    total: rows.length,
    counts,
    truncated: rows.length > printers.length,
    printers,
  }
}

/**
 * The tag covers the stored data only. The age fields change on every request,
 * so they stay out of it: a poll of an unchanged farm answers 304 and the wall
 * recomputes the age from `observedAt`.
 */
export function summaryEtag(summary: StatusSummary): string {
  const stable = {
    total: summary.total,
    counts: summary.counts,
    printers: summary.printers.map(({ dataAgeMs: _age, ...rest }) => rest),
  }
  const digest = createHash('sha256')
    .update(JSON.stringify(stable))
    .digest('base64url')
  return `W/"${digest}"`
}

function matches(header: string | null, etag: string): boolean {
  if (!header) return false
  const weak = (tag: string) => tag.trim().replace(/^W\//, '')
  return header
    .split(',')
    .some((tag) => tag.trim() === '*' || weak(tag) === weak(etag))
}

export async function statusSummary(
  event: Pick<RequestEvent, 'req' | 'res'>,
  farmId: string,
  dependencies?: {
    auth: AuthRuntime
    reader: PrinterStateReader
    clock?: () => number
  },
) {
  authResponse(event)
  event.res.headers.set('Referrer-Policy', 'no-referrer')
  // Member data: stored only after revalidation, never shared.
  event.res.headers.set('Cache-Control', 'private, no-cache')
  event.res.headers.set('Vary', 'Cookie')
  if (event.req.method !== 'GET')
    throw createError({ status: 405, message: 'Método não permitido.' })
  if (!inventoryUuid.test(farmId))
    throw createError({ status: 400, message: 'Farm inválida.' })
  const auth = dependencies?.auth ?? authRuntime()
  const sessionRecordId = await sealedSessionRecordId(event, auth)
  const reader = dependencies?.reader ?? printerStatesRuntime()
  const result = await reader.list({
    farmId,
    sessionRecordId,
    policy: { idleTimeoutMs: auth.idleTimeoutMs },
  })
  if (!result.ok) return failure(result.reason)
  const summary = buildStatusSummary(
    result.states,
    (dependencies?.clock ?? Date.now)(),
  )
  const etag = summaryEtag(summary)
  event.res.headers.set('ETag', etag)
  if (matches(event.req.headers.get('if-none-match'), etag))
    return new Response(null, { status: 304, headers: { ETag: etag } })
  return summary
}
