// SPDX-License-Identifier: MIT
import type { JobHistoryItem } from '../../utils/job-history-view.ts'
import { formatDateTime, formatDuration } from '../../utils/ui-format.ts'

/** One `server.history.list` job as the detail `history` query returns it. */
export type PrinterHistoryJob = {
  id: string
  file: string
  state: string
  startedAtMs: number
  durationSeconds: number
}
/** The detail `totals` query result. */
export type PrinterHistoryTotals = {
  jobs: number
  printSeconds: number
  filamentMm: number
  longestJobSeconds?: number
}

/** Rows shown per page. */
export const HISTORY_PAGE_SIZE = 20
/** Hard ceiling on merged rows, whatever either source sends. */
export const HISTORY_MAX_ROWS = 256
/** A recorded end is observed late; ends this close are the same job. */
export const HISTORY_MATCH_TOLERANCE_MS = 120_000

export type HistorySource = 'moonraker' | 'openfarm' | 'both'
export type HistoryRow = {
  key: string
  filename: string
  outcome: string
  endedAtMs: number
  ended: string
  duration: string
  source: HistorySource
  sourceLabel: string
  /** Library version of the linked OpenFarm job; replay needs it. */
  librarySha256?: string
  openfarmJobId?: string
}

const outcomeLabels: Readonly<Record<string, string>> = {
  completed: 'Concluído',
  cancelled: 'Cancelado',
  in_progress: 'Em andamento',
}
const sourceLabels: Readonly<Record<HistorySource, string>> = {
  moonraker: 'Impressora',
  openfarm: 'OpenFarm',
  both: 'Impressora e OpenFarm',
}
const openfarmOutcome = {
  completed: 'Concluído',
  cancelled: 'Cancelado',
  failed: 'Falhou',
} as const

/** pt-BR outcome for a Moonraker history status; anything else failed. */
export function moonrakerOutcomeLabel(state: string): string {
  return outcomeLabels[state] ?? 'Falhou'
}

export function durationText(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0)
    return 'Não informada'
  const total = Math.round(seconds)
  return total < 60 ? `${total} s` : (formatDuration(total) ?? 'Não informada')
}

export function filamentText(millimetres: number | undefined): string {
  return millimetres === undefined || !Number.isFinite(millimetres)
    ? 'Não informado'
    : `${(millimetres / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} m`
}

/** The wire carries start and total duration, so the end is derived. */
const endOf = (job: PrinterHistoryJob) =>
  job.startedAtMs + Math.round(job.durationSeconds * 1000)

/**
 * Merges the printer's own history with the OpenFarm job history of the same
 * printer. A job both know (same file, ends within the tolerance) is one row
 * carrying the OpenFarm library link. Newest first, never more than
 * HISTORY_MAX_ROWS.
 */
export function mergeHistory(
  printerJobs: readonly PrinterHistoryJob[],
  openfarmJobs: readonly JobHistoryItem[],
): HistoryRow[] {
  const free = new Map(openfarmJobs.map((job) => [job.id, job]))
  const rows: HistoryRow[] = []
  for (const job of printerJobs.slice(0, HISTORY_MAX_ROWS)) {
    const end = endOf(job)
    let best: JobHistoryItem | undefined
    for (const candidate of free.values()) {
      const gap = Math.abs(candidate.endedAt - end)
      if (
        candidate.filename === job.file &&
        gap <= HISTORY_MATCH_TOLERANCE_MS &&
        (!best || gap < Math.abs(best.endedAt - end))
      )
        best = candidate
    }
    if (best) free.delete(best.id)
    rows.push({
      key: `moonraker:${job.id}`,
      filename: job.file,
      outcome: moonrakerOutcomeLabel(job.state),
      endedAtMs: end,
      ended: formatDateTime(end) ?? 'Não informado',
      duration: durationText(job.durationSeconds),
      source: best ? 'both' : 'moonraker',
      sourceLabel: sourceLabels[best ? 'both' : 'moonraker'],
      ...(best?.librarySha256 ? { librarySha256: best.librarySha256 } : {}),
      ...(best ? { openfarmJobId: best.id } : {}),
    })
  }
  for (const job of free.values())
    rows.push({
      key: `openfarm:${job.id}`,
      filename: job.filename ?? 'Arquivo desconhecido',
      outcome: openfarmOutcome[job.outcome],
      endedAtMs: job.endedAt,
      ended: formatDateTime(job.endedAt) ?? 'Não informado',
      duration: durationText(
        job.printDurationSeconds ?? job.totalDurationSeconds,
      ),
      source: 'openfarm',
      sourceLabel: sourceLabels.openfarm,
      ...(job.librarySha256 ? { librarySha256: job.librarySha256 } : {}),
      openfarmJobId: job.id,
    })
  return rows
    .sort((a, b) => b.endedAtMs - a.endedAtMs)
    .slice(0, HISTORY_MAX_ROWS)
}

/** One bounded page of rows; the page number is clamped into range. */
export function historyPage<T>(rows: readonly T[], requested: number) {
  const pages = Math.max(1, Math.ceil(rows.length / HISTORY_PAGE_SIZE))
  const page = Math.min(pages, Math.max(1, Math.trunc(requested) || 1))
  return {
    page,
    pages,
    rows: rows.slice((page - 1) * HISTORY_PAGE_SIZE, page * HISTORY_PAGE_SIZE),
  }
}
