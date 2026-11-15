import { formatJobTime } from './farm-job-view.ts'

export interface JobHistoryItem {
  id: string
  printerKey: string
  outcome: 'completed' | 'cancelled' | 'failed'
  filename?: string
  printDurationSeconds?: number
  totalDurationSeconds?: number
  endedAt: number
}
export const jobOutcomeLabel = {
  completed: 'Concluído',
  cancelled: 'Cancelado',
  failed: 'Falhou',
} as const

const dateFormat = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'medium',
  timeZone: 'America/Sao_Paulo',
})
/** Display row for one finished job; duration prefers print time, then total time. */
export function jobHistoryRow(job: JobHistoryItem) {
  return {
    id: job.id,
    printerKey: job.printerKey,
    outcome: jobOutcomeLabel[job.outcome],
    filename: job.filename ?? 'Arquivo desconhecido',
    endedAt: dateFormat.format(new Date(job.endedAt)),
    duration:
      formatJobTime(job.printDurationSeconds ?? job.totalDurationSeconds) ??
      'Não informada',
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
