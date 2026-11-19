import { formatDateTime } from './ui-format.ts'
import { formatJobTime } from './farm-job-view.ts'

export interface JobHistoryItem {
  id: string
  printerKey: string
  outcome: 'completed' | 'cancelled' | 'failed'
  filename?: string
  printDurationSeconds?: number
  totalDurationSeconds?: number
  /** Library version that was printed; absent for unlinked jobs. */
  librarySha256?: string
  plate?: number
  endedAt: number
}
export const jobOutcomeLabel = {
  completed: 'Concluído',
  cancelled: 'Cancelado',
  failed: 'Falhou',
} as const

/** pt-BR text for the library link of a job; null when it was not started from the library. */
export function jobLibraryLabel(job: {
  librarySha256?: string | undefined
  plate?: number | undefined
}): string | null {
  if (!job.librarySha256) return null
  const version = `Biblioteca · versão ${job.librarySha256.slice(0, 12)}`
  return job.plate === undefined ? version : `${version} · placa ${job.plate}`
}
/** Display row for one finished job; duration prefers print time, then total time. */
export function jobHistoryRow(job: JobHistoryItem) {
  return {
    id: job.id,
    printerKey: job.printerKey,
    outcome: jobOutcomeLabel[job.outcome],
    filename: job.filename ?? 'Arquivo desconhecido',
    endedAt: formatDateTime(job.endedAt) ?? 'Não informada',
    duration:
      formatJobTime(job.printDurationSeconds ?? job.totalDurationSeconds) ??
      'Não informada',
    library: jobLibraryLabel(job) ?? 'Fora da biblioteca',
  }
}
/** Page status text: loading wins over error, empty only when neither applies. */
export function jobHistoryStatus(state: {
  pending: boolean
  error: string
  count: number
}): string {
  if (state.pending) return 'Consultando histórico…'
  if (state.error) return ''
  return state.count ? '' : 'Nenhum trabalho finalizado registrado.'
}
