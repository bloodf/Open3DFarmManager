import { z } from 'zod'
import { encodeApiEnvelopeResultFrame } from '../../../farm-protocol/src/api-envelope.ts'
import type { RawMoonrakerObservation } from '../moonraker/subscription.ts'
import type { PrinterState } from '@open3dfarmmanager/farm-protocol'
import {
  readPrivateJson,
  writePrivateJsonAtomic,
} from '../provisioning/private-fs.ts'

const startWindowMs = 60_000
const unknown = 'outcome-unknown'
const ending = z.object({
  outcome: z.enum(['completed', 'cancelled', 'failed', unknown]),
  at: z.number().int().nonnegative(),
})
const storedJob = z.object({
  cmdId: z.uuid(),
  printerKey: z.string(),
  filename: z.string(),
  sentAt: z.number().int().nonnegative(),
  running: z.boolean(),
  duration: z.number().nonnegative().optional(),
  firstActiveAt: z.number().int().nonnegative().optional(),
  sourceStartedAt: z.number().nonnegative().optional(),
  jobId: z.string().optional(),
  end: ending.optional(),
  startedSent: z.boolean(),
})
type Job = z.infer<typeof storedJob>
export type ApiRunEvidence = Readonly<{
  filename?: string | undefined
  duration?: number | undefined
  info?: unknown
  sourceTime: number
}>

function moonrakerJobId(info: unknown) {
  return info &&
    typeof info === 'object' &&
    'job_id' in info &&
    typeof info.job_id === 'string'
    ? info.job_id
    : undefined
}

// Both fields use the printer's monotonic clock, avoiding network and wall clock skew.
function sourceStart(
  sourceTime: number | undefined,
  duration: number | undefined,
) {
  if (
    sourceTime === undefined ||
    duration === undefined ||
    duration > sourceTime
  )
    return undefined
  return sourceTime - duration
}

function sameStart(a: number, b: number) {
  return Math.abs(a - b) <= 0.000001
}

type Watch = {
  job: Job
  sentMono: number
  confirmed: boolean
  continuous: boolean
  dirty?: boolean
}

export function openApiJobLifecycle(
  options: {
    path?: string
    onError?: (error: unknown) => void
  } = {},
) {
  const { path, onError } = options
  let jobs: Job[] = []
  let writable = true
  if (path) {
    try {
      const document = readPrivateJson(path)
      if (document !== null) jobs = storedJob.array().parse(document)
    } catch (error) {
      writable = false
      onError?.(error)
    }
  }
  const watches = new Map<string, Watch>()
  for (const job of jobs)
    if (!job.end)
      watches.set(job.printerKey, {
        job,
        sentMono: -Infinity,
        confirmed: true,
        continuous: false,
      })
  let report: ((wire: string) => Promise<void>) | undefined
  let busy = false

  function save(next: Job[]) {
    if (!writable) throw new Error('API job journal unavailable')
    if (path) writePrivateJsonAtomic(path, next)
    jobs = next
  }

  function persist(watch: Watch, job: Job) {
    watch.job = job
    if (watch.confirmed) {
      try {
        save([...jobs.filter(({ cmdId }) => cmdId !== job.cmdId), job])
      } catch (error) {
        if (!watch.dirty) onError?.(error)
        watch.dirty = true
        return false
      }
      watch.dirty = false
      if (job.end) watches.delete(job.printerKey)
    }
    flush()
    return true
  }

  const needsReport = (job: Job) => !job.startedSent || job.end !== undefined

  // The Farm deduplicates results by command ID if a crash interrupts local cleanup.
  function flush() {
    const send = report
    if (!send || busy || !jobs.some(needsReport)) return
    busy = true
    void (async () => {
      while (send === report) {
        const job = jobs.find(needsReport)
        if (!job) break
        const end = job.startedSent ? job.end : undefined
        await send(
          encodeApiEnvelopeResultFrame({
            v: 1,
            t: 'api-envelope.result',
            cmd_id: job.cmdId,
            outcome:
              end?.outcome === unknown ? 'failed' : (end?.outcome ?? 'started'),
            at: end?.at ?? job.sentAt,
            // The existing result protocol carries uncertainty as failure detail.
            ...(end?.outcome === unknown
              ? { detail: unknown }
              : end
                ? { history_entry_id: `0${end.at}` }
                : {}),
          }),
        )
        const current = jobs.find(({ cmdId }) => cmdId === job.cmdId)
        if (!current) continue
        const next = jobs.filter(({ cmdId }) => cmdId !== job.cmdId)
        if (!end) {
          const updated = { ...current, startedSent: true }
          save([...next, updated])
          const watch = watches.get(current.printerKey)
          if (watch?.job.cmdId === updated.cmdId)
            watch.job = { ...watch.job, startedSent: true }
        } else save(next)
      }
    })()
      .catch((error: unknown) => {
        if (report === send) report = undefined
        onError?.(error)
      })
      .finally(() => {
        busy = false
        flush()
      })
  }

  function finish(
    watch: Watch,
    outcome: z.infer<typeof ending>['outcome'],
    at: number,
  ) {
    return persist(watch, { ...watch.job, end: { outcome, at } })
  }

  return {
    attach(send: (wire: string) => Promise<void>) {
      report = send
      flush()
      return () => {
        if (report === send) report = undefined
      }
    },
    watch(
      printerKey: string,
      filename: string,
      cmdId: string,
      sentAt: number,
      sentMono: number,
    ) {
      // Keep space in the bounded private document for later run evidence.
      if (
        !writable ||
        jobs.length + watches.size >= 96 ||
        Buffer.byteLength(JSON.stringify(jobs)) > 48 * 1024
      )
        throw new Error('API job journal unavailable')
      // Verify the local journal is writable before permitting the RPC.
      save(jobs)
      const previous = watches.get(printerKey)
      if (previous && !finish(previous, unknown, sentAt))
        throw new Error('API job journal unavailable')
      const watch: Watch = {
        confirmed: false,
        continuous: true,
        sentMono,
        job: {
          cmdId,
          printerKey,
          filename,
          sentAt,
          running: false,
          startedSent: false,
        },
      }
      watches.set(printerKey, watch)
      return {
        dispose() {
          if (watches.get(printerKey) === watch && !watch.confirmed)
            watches.delete(printerKey)
        },
        confirm() {
          if (watches.get(printerKey) !== watch) return
          save([...jobs, watch.job])
          watch.confirmed = true
          if (watch.job.end) watches.delete(printerKey)
          flush()
        },
      }
    },
    unavailable(printerKey: string) {
      const watch = watches.get(printerKey)
      if (watch) watch.continuous = false
    },
    observe(value: RawMoonrakerObservation) {
      const watch = watches.get(value.printerKey)
      if (!watch) return
      if (watch.dirty) persist(watch, watch.job)
      if (
        watch.job.end ||
        value.status.webhooks.state !== 'ready' ||
        value.fieldObservedAtMonoMs.printState <= watch.sentMono
      )
        return
      const job = watch.job
      const at = value.printer.observedAt
      if (at < job.sentAt) return
      const stats = value.status.print_stats
      const id = moonrakerJobId(stats.info)
      const duration =
        typeof stats.total_duration === 'number' &&
        Number.isFinite(stats.total_duration) &&
        stats.total_duration >= 0
          ? stats.total_duration
          : undefined
      const sameId = id !== undefined && id === job.jobId
      const sourceStartedAt = sourceStart(value.durationSourceTime, duration)
      const sameSource =
        job.sourceStartedAt !== undefined &&
        sourceStartedAt !== undefined &&
        sameStart(job.sourceStartedAt, sourceStartedAt)
      if (stats.state === 'printing' || stats.state === 'paused') {
        if (
          stats.filename !== job.filename ||
          (job.jobId && id && job.jobId !== id) ||
          (!job.running &&
            (at - job.sentAt > startWindowMs ||
              (duration !== undefined && at - duration * 1000 < job.sentAt))) ||
          (job.running &&
            !watch.continuous &&
            !sameId &&
            !sameSource &&
            (duration === undefined ||
              job.firstActiveAt === undefined ||
              at - duration * 1000 > job.firstActiveAt + 2000)) ||
          (job.running &&
            !sameId &&
            duration !== undefined &&
            job.duration !== undefined &&
            duration < job.duration)
        ) {
          finish(watch, unknown, at)
        } else if (
          !job.running ||
          (id && !job.jobId) ||
          (duration !== undefined &&
            (job.duration === undefined || duration >= job.duration + 30))
        ) {
          persist(watch, {
            ...job,
            running: true,
            firstActiveAt: job.firstActiveAt ?? at,
            sourceStartedAt: job.running
              ? job.sourceStartedAt
              : sourceStartedAt,
            jobId: id ?? job.jobId,
            duration,
          })
        }
        watch.continuous = true
      } else if (
        (!job.running &&
          (stats.state === 'error' || at - job.sentAt > startWindowMs)) ||
        (job.running &&
          (stats.state === 'standby' ||
            (!watch.continuous && !sameId) ||
            stats.filename !== job.filename ||
            (job.jobId && id && job.jobId !== id) ||
            (duration !== undefined &&
              job.duration !== undefined &&
              duration < job.duration)))
      ) {
        finish(watch, unknown, at)
      }
    },
    matchesActiveRun(
      printerKey: string,
      cmdId: string,
      evidence: ApiRunEvidence,
    ) {
      const watch = watches.get(printerKey)
      if (
        !watch?.confirmed ||
        !watch.continuous ||
        watch.dirty ||
        !watch.job.running ||
        watch.job.end ||
        watch.job.cmdId !== cmdId ||
        watch.job.filename !== evidence.filename
      )
        return false
      const job = watch.job
      const id = moonrakerJobId(evidence.info)
      if (job.jobId !== undefined || id !== undefined)
        return id !== undefined && job.jobId === id
      const startedAt = sourceStart(evidence.sourceTime, evidence.duration)
      return (
        startedAt !== undefined &&
        job.sourceStartedAt !== undefined &&
        sameStart(startedAt, job.sourceStartedAt)
      )
    },
    hasRunning(printerKey: string) {
      const job = watches.get(printerKey)?.job
      return !!job?.running && !job.end
    },
    record(printer: PrinterState) {
      const watch = watches.get(printer.printerKey)
      const last = printer.lastJob
      if (
        !watch?.job.running ||
        watch.job.end ||
        !last ||
        last.endedAt < watch.job.sentAt ||
        last.endedAt !== printer.observedAt
      )
        return
      finish(
        watch,
        last.filename === watch.job.filename ? last.outcome : unknown,
        last.endedAt,
      )
    },
  }
}

export type ApiJobLifecycle = ReturnType<typeof openApiJobLifecycle>
