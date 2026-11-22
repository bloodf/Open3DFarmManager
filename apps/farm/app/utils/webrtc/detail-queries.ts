// SPDX-License-Identifier: MIT
import type { z } from 'zod'
import type {
  PrinterDetailStreamCapability,
  PrinterDetailStreamQueryResponse,
} from '../../../../../packages/farm-protocol/src/printer-detail.ts'

export type DetailQueryResponse = z.infer<
  typeof PrinterDetailStreamQueryResponse
>
type Capability = z.infer<typeof PrinterDetailStreamCapability>
export type DetailQueryKind =
  'temperature-store' | 'job-queue' | 'history' | 'totals' | 'timelapse'

/** Queries the printer's advertised areas call for, in request order. */
const QUERIES: readonly (readonly [Capability, DetailQueryKind])[] = [
  ['heaters', 'temperature-store'],
  ['job-queue', 'job-queue'],
  ['job', 'history'],
  ['job', 'totals'],
  ['timelapse', 'timelapse'],
]
/** Milliseconds before a kind is asked again; `Infinity` asks once. */
const REFRESH_MS: Record<DetailQueryKind, number> = {
  'temperature-store': 60_000,
  'job-queue': 5000,
  timelapse: 5000,
  history: 30_000,
  totals: 30_000,
}
/** The Connector drops queries beyond four per session; the console keeps one. */
export const MAX_DETAIL_QUERIES_IN_FLIGHT = 2
/** A query the Connector never answered is forgotten and asked again later. */
export const DETAIL_QUERY_TIMEOUT_MS = 10_000

export function queryKindsFor(
  capabilities: readonly Capability[],
): DetailQueryKind[] {
  return QUERIES.filter(([capability]) =>
    capabilities.includes(capability),
  ).map(([, kind]) => kind)
}

/**
 * Asks the detail channel for what the printer advertises and routes the
 * answers. Each update frame is a chance to refresh; one request per kind and
 * at most two in flight keep it inside the Connector's per-session bound.
 */
export function createDetailQueries(input: {
  printerKey: string
  send: (wire: string) => void
  onResponse: (frame: DetailQueryResponse) => void
  clock?: () => number
}) {
  const clock = input.clock ?? (() => performance.now())
  const pending = new Map<DetailQueryKind, { id: string; at: number }>()
  const done = new Map<DetailQueryKind, number>()
  let counter = 0
  let latest: readonly Capability[] = []
  const api = {
    /** Call with the capabilities of each update frame. */
    update(capabilities: readonly Capability[]) {
      latest = capabilities
      const now = clock()
      for (const [kind, started] of pending)
        if (now - started.at >= DETAIL_QUERY_TIMEOUT_MS) pending.delete(kind)
      for (const kind of queryKindsFor(capabilities)) {
        if (pending.size >= MAX_DETAIL_QUERIES_IN_FLIGHT) return
        const last = done.get(kind)
        if (
          pending.has(kind) ||
          (last !== undefined && now - last < REFRESH_MS[kind])
        )
          continue
        const id = `q-${kind}-${counter++}`
        pending.set(kind, { id, at: now })
        input.send(
          JSON.stringify({
            v: 1,
            t: 'query.request',
            printerKey: input.printerKey,
            requestId: id,
            kind,
          }),
        )
      }
    },
    /** True when the frame answered one of these queries. */
    receive(frame: DetailQueryResponse) {
      for (const [kind, request] of pending) {
        if (request.id !== frame.requestId || kind !== frame.kind) continue
        pending.delete(kind)
        // An unsupported kind is not asked again; any other failure is retried later.
        done.set(
          kind,
          'error' in frame && frame.error === 'unsupported'
            ? Infinity
            : clock(),
        )
        input.onResponse(frame)
        // A slot is free: ask for what the in-flight bound held back.
        api.update(latest)
        return true
      }
      return false
    },
    /** Asks again for whatever is due, as an idle printer sends no update frames. */
    refresh() {
      api.update(latest)
    },
  }
  return api
}
