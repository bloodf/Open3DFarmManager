import { z } from 'zod'
import { QueueOpArguments } from '../../../farm-protocol/src/control-actions.ts'

/**
 * Moonraker adapter for the signed `queue_op` action. The job queue is a
 * Moonraker component, not a Klipper object, so support is detected from
 * `server.info` and carried next to the object list as one marker entry. The
 * request is built only from validated names and ids; refusals are decided
 * from one read of `server.job_queue.status` taken just before the single
 * send, and an uncertain send is never repeated.
 */

/** Marker detection appends to the object list when the component is loaded. */
export const JOB_QUEUE_COMPONENT_MARKER = 'moonraker_component job_queue'
/** Largest queue the Connector will grow; matches the detail view bound. */
export const JOB_QUEUE_MAX_JOBS = 256

export type QueueRefusalReason =
  'state' | 'unsupported-action' | 'invalid-command'

/**
 * Thrown before any write. The dispatcher reads `refusal` and reports a
 * not-sent result with that reason instead of an unknown outcome.
 */
export class QueueRefused extends Error {
  readonly refusal: QueueRefusalReason
  constructor(refusal: QueueRefusalReason) {
    super(`Queue operation refused: ${refusal}`)
    this.name = 'QueueRefused'
    this.refusal = refusal
  }
}

/** True only when the printer's Moonraker lists the job queue component. */
export const queueSupported = (objects: readonly string[] | undefined) =>
  !!objects?.includes(JOB_QUEUE_COMPONENT_MARKER)

const ServerInfo = z.object({ components: z.array(z.string()).max(512) })

/** Read-only request that lists the loaded Moonraker components. */
export const serverInfoWire = (id: number) =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'server.info' })

/** Marker entries for a `server.info` reply; a malformed reply adds none. */
export function queueMarkers(result: unknown): readonly string[] {
  const info = ServerInfo.safeParse(result)
  return info.success && info.data.components.includes('job_queue')
    ? [JOB_QUEUE_COMPONENT_MARKER]
    : []
}

export type QueueCall = Readonly<{
  method: string
  params?: Record<string, unknown>
}>

/** Validates the arguments and maps them to the one JSON-RPC call. */
export function parseQueueOp(args: unknown): {
  op: QueueOpArguments
  call: QueueCall
} {
  const parsed = QueueOpArguments.safeParse(args)
  if (!parsed.success) throw new QueueRefused('invalid-command')
  const op = parsed.data
  switch (op.op) {
    case 'add':
      return {
        op,
        call: {
          method: 'server.job_queue.post_job',
          params: { filenames: [...op.files] },
        },
      }
    case 'remove':
      return {
        op,
        call: {
          method: 'server.job_queue.delete_job',
          params: { job_ids: [...op.job_ids] },
        },
      }
    case 'jump':
      return {
        op,
        call: {
          method: 'server.job_queue.jump',
          params: { job_id: op.job_ids[0] },
        },
      }
    case 'start':
      return { op, call: { method: 'server.job_queue.start' } }
    case 'pause':
      return { op, call: { method: 'server.job_queue.pause' } }
  }
}

/** Read-only query of the queue before an operation that depends on it. */
export const queueStatusWire = (id: number) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'server.job_queue.status',
  })

const Status = z.object({
  queue_state: z.string().min(1).max(32),
  queued_jobs: z
    .array(z.object({ job_id: z.string().min(1).max(64) }))
    .max(JOB_QUEUE_MAX_JOBS),
})
export type QueueStatus = Readonly<{
  state: string
  jobIds: ReadonlySet<string>
}>

/** Anything but a well-formed status is "unknown state", which refuses. */
export function parseQueueStatus(result: unknown): QueueStatus {
  const status = Status.safeParse(result)
  if (!status.success) throw new QueueRefused('state')
  return Object.freeze({
    state: status.data.queue_state,
    jobIds: new Set(status.data.queued_jobs.map(({ job_id }) => job_id)),
  })
}

/** Operations whose result depends on what the queue holds right now. */
export const queueNeedsStatus = (op: QueueOpArguments) => op.op !== 'pause'

/**
 * Connector-side refusal from the live queue: remove and jump name only jobs
 * that exist, start needs a job to start, and add never grows the queue past
 * its bound. Pausing is always allowed.
 */
export function refuseQueueOp(
  op: QueueOpArguments,
  status: QueueStatus | undefined,
): void {
  if (op.op === 'pause') return
  if (!status) throw new QueueRefused('state')
  switch (op.op) {
    case 'add':
      if (status.jobIds.size + op.files.length > JOB_QUEUE_MAX_JOBS)
        throw new QueueRefused('state')
      return
    case 'remove':
    case 'jump':
      if (op.job_ids.some((id) => !status.jobIds.has(id)))
        throw new QueueRefused('state')
      return
    case 'start':
      if (status.jobIds.size === 0) throw new QueueRefused('state')
  }
}
