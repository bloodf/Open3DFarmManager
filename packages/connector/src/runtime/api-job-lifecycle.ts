import type { PrinterState } from '@open3dfarmmanager/farm-protocol'
import type { RawMoonrakerObservation } from '../moonraker/subscription.ts'

type LastJob = NonNullable<PrinterState['lastJob']>
type Pending = {
  filename: string
  sentAt: number
  sentMono: number
  running: boolean
  ended?: LastJob
  report?: (job: LastJob) => void
  dispose(): void
}

const pending = new Map<string, Pending>()

export function watchApiJob(
  printerKey: string,
  filename: string,
  sentAt: number,
  sentMono: number,
  signal?: AbortSignal,
) {
  pending.get(printerKey)?.dispose()
  const job: Pending = { filename, sentAt, sentMono, running: false, dispose }
  pending.set(printerKey, job)
  signal?.addEventListener('abort', dispose, { once: true })
  if (signal?.aborted) dispose()
  function dispose() {
    if (pending.get(printerKey) === job) pending.delete(printerKey)
    signal?.removeEventListener('abort', dispose)
  }
  return {
    dispose,
    confirmed(report: NonNullable<Pending['report']>) {
      job.report = report
      settle(printerKey, job)
    },
  }
}

function settle(printerKey: string, job: Pending) {
  if (pending.get(printerKey) !== job || !job.ended || !job.report) return
  job.dispose()
  job.report(job.ended)
}

export function observeApiJob(value: RawMoonrakerObservation) {
  const job = pending.get(value.printerKey)
  if (!job || job.ended || value.printer.observedAt < job.sentAt) return
  if (!job.running && value.printer.observedAt - job.sentAt > 60_000) {
    job.dispose()
    return
  }
  if (value.fieldObservedAtMonoMs.printState <= job.sentMono) return
  const stats = value.status.print_stats
  if (stats.state === 'printing' || stats.state === 'paused') {
    if (stats.filename === job.filename) job.running = true
    else if (typeof stats.filename === 'string' && stats.filename) job.dispose()
  } else if (job.running && stats.state === 'standby') job.dispose()
}

export function forgetApiJob(printerKey: string) {
  pending.get(printerKey)?.dispose()
}

export function recordApiJob(printer: PrinterState) {
  const job = pending.get(printer.printerKey)
  const last = printer.lastJob
  if (
    !job?.running ||
    job.ended ||
    !last ||
    last.endedAt < job.sentAt ||
    last.endedAt !== printer.observedAt
  )
    return
  if (last.filename !== job.filename) {
    job.dispose()
    return
  }
  job.ended = last
  settle(printer.printerKey, job)
}
