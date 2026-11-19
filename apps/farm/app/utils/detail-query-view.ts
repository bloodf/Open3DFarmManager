// SPDX-License-Identifier: MIT
import {
  MAX_TIMELAPSE_BYTES,
  TIMELAPSE_CHUNK_BYTES,
  type FileListResult,
} from '../../../../packages/farm-protocol/src/file-list.ts'
import type {
  PrinterHistoryJob,
  PrinterHistoryTotals,
} from '../components/printer-detail/history-view.ts'
import type { DetailQueryResponse } from './webrtc/detail-queries.ts'
import {
  mergeSamples,
  type HeaterHistory,
  type HeaterSample,
} from './printer-detail-view.ts'

export type DetailQueryError =
  'unsupported' | 'unavailable' | 'not-found' | 'too-large'
export type DetailQueryState = Readonly<{
  queue?: { state: string; jobs: readonly { id: string; file: string }[] }
  timelapse?: {
    enabled: boolean
    rendering: boolean
    files: readonly string[]
  }
  history?: readonly PrinterHistoryJob[]
  totals?: PrinterHistoryTotals
  /** Last failure per kind; a later answer clears it. */
  errors: Readonly<
    Partial<Record<DetailQueryResponse['kind'], DetailQueryError>>
  >
}>
export const emptyDetailQueries: DetailQueryState = { errors: {} }

const DATA_FIELD: Partial<
  Record<
    DetailQueryResponse['kind'],
    'queue' | 'timelapse' | 'history' | 'totals'
  >
> = {
  'job-queue': 'queue',
  timelapse: 'timelapse',
  history: 'history',
  totals: 'totals',
}

type DataFrame = Extract<DetailQueryResponse, { data: unknown }>
const hasData = (frame: DetailQueryResponse): frame is DataFrame =>
  'data' in frame

/** Folds one answer into the state. Failures keep no stale data of their kind. */
export function applyDetailQuery(
  state: DetailQueryState,
  frame: DetailQueryResponse,
): DetailQueryState {
  if (!hasData(frame)) {
    const next: {
      -readonly [K in keyof DetailQueryState]: DetailQueryState[K]
    } = { ...state, errors: { ...state.errors, [frame.kind]: frame.error } }
    const field = DATA_FIELD[frame.kind]
    if (field) delete next[field]
    return next
  }
  const { [frame.kind]: _cleared, ...errors } = state.errors
  switch (frame.kind) {
    case 'job-queue':
      return {
        ...state,
        queue: frame.data as NonNullable<DetailQueryState['queue']>,
        errors,
      }
    case 'timelapse':
      return {
        ...state,
        timelapse: frame.data as NonNullable<DetailQueryState['timelapse']>,
        errors,
      }
    case 'history':
      return {
        ...state,
        history: frame.data as NonNullable<DetailQueryState['history']>,
        errors,
      }
    case 'totals':
      return {
        ...state,
        totals: frame.data as NonNullable<DetailQueryState['totals']>,
        errors,
      }
    default:
      return { ...state, errors }
  }
}

/**
 * Heater history from a `temperature-store` answer. The Connector stamps
 * samples with its own clock, so the newest sample is pinned to the moment the
 * answer arrived: skew between the two clocks cannot push the graph off the
 * ten-minute window.
 */
export function backfillHistory(
  history: HeaterHistory,
  frame: DetailQueryResponse,
  receivedWall: number,
  now: number,
): HeaterHistory {
  if (!hasData(frame) || frame.kind !== 'temperature-store') return history
  // The protocol validated the data against its kind; the union cannot say so.
  const store = frame.data as readonly {
    name: string
    samples: readonly {
      atMs: number
      temperature: number
      target?: number
    }[]
  }[]
  const newest = Math.max(
    ...store.flatMap((heater) => heater.samples.map(({ atMs }) => atMs)),
  )
  if (!Number.isFinite(newest)) return history
  const shift = receivedWall - newest
  let next = history
  for (const heater of store) {
    const samples: HeaterSample[] = heater.samples.map((sample) => ({
      time: sample.atMs + shift,
      temperature: sample.temperature,
      ...(sample.target === undefined ? {} : { target: sample.target }),
    }))
    next = mergeSamples(next, heater.name, samples, now)
  }
  return next
}

const toHex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

type TimelapseSession = {
  listFiles(
    printerKey: string,
    directory?: string,
    download?: string,
    config?: { timelapse: true; offset?: number },
  ): Promise<FileListResult>
}

/**
 * Reads one rendered timelapse over the file-transfer channel, one chunk per
 * request, and checks size and SHA-256 before handing the bytes over.
 */
export async function downloadTimelapse(
  session: TimelapseSession,
  printerKey: string,
  name: string,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  let bytes: Uint8Array<ArrayBuffer> | undefined
  let sha256 = ''
  let offset = 0
  do {
    signal.throwIfAborted()
    const result = await session.listFiles(printerKey, undefined, name, {
      timelapse: true,
      offset,
    })
    if (!result.ok || result.download === undefined || !result.transfer)
      throw Error('Timelapse indisponível')
    if (!bytes) {
      if (result.transfer.size > MAX_TIMELAPSE_BYTES)
        throw Error('Timelapse grande demais')
      bytes = new Uint8Array(result.transfer.size)
      sha256 = result.transfer.sha256
    }
    const chunk = Uint8Array.from(atob(result.download), (char) =>
      char.charCodeAt(0),
    )
    if (
      result.transfer.sha256 !== sha256 ||
      result.transfer.size !== bytes.length ||
      chunk.length > TIMELAPSE_CHUNK_BYTES ||
      offset + chunk.length > bytes.length ||
      (chunk.length === 0 && offset < bytes.length)
    )
      throw Error('Timelapse incompleto')
    bytes.set(chunk, offset)
    offset += chunk.length
  } while (offset < bytes.length)
  if (toHex(await crypto.subtle.digest('SHA-256', bytes)) !== sha256)
    throw Error('Timelapse alterado')
  return bytes
}
