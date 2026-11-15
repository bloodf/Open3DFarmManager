import type { PrinterState } from '../../../../packages/farm-protocol/src/state.ts'
import { formatJobTime } from './farm-job-view.ts'

export function farmJobOutcome(state: PrinterState) {
  const job = state.lastJob
  if (!job || state.state === 'printing' || state.state === 'paused')
    return undefined
  return {
    label: { completed: 'Concluído', cancelled: 'Cancelado', failed: 'Falhou' }[
      job.outcome
    ],
    filename: job.filename || undefined,
    endedAt:
      job.endedAt <= 8_640_000_000_000_000
        ? new Date(job.endedAt).toLocaleString('pt-BR')
        : 'Horário não confirmado',
    duration: formatJobTime(job.printDuration ?? job.totalDuration),
  }
}
