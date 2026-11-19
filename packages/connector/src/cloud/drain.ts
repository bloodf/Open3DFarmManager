import {
  parseBoundedJson,
  TELEMETRY_BATCH_JSON_LIMITS,
} from '@open3dfarmmanager/farm-protocol'
import {
  TelemetryQueue,
  type QueueLoss,
  type TelemetryRecord,
} from './queue.ts'

/** Internal adapter boundary only; no HTTP response format or authentication is defined. */
export type TelemetrySender = (
  body: string,
  signal: AbortSignal,
) => Promise<unknown>
export type DrainResult =
  | { status: 'uncertain'; reason: 'queue'; loss?: QueueLoss }
  | { status: 'empty'; loss: QueueLoss }
  | { status: 'delivered'; count: number; loss: QueueLoss }
  | {
      status: 'retained'
      reason:
        'busy' | 'cancelled' | 'transport' | 'acknowledgement' | 'oversized'
      loss?: QueueLoss
    }

const active = new WeakSet<TelemetryQueue>()

function withinBatchLimits(records: readonly TelemetryRecord[]): boolean {
  try {
    parseBoundedJson(JSON.stringify(records), TELEMETRY_BATCH_JSON_LIMITS)
    return true
  } catch {
    return false
  }
}

/**
 * The queue bounds a batch by count and bytes only; the upload also bounds
 * its JSON value count. Send the longest prefix that fits, so a batch of
 * value-rich records drains in smaller steps instead of being refused forever.
 */
function fittingPrefix(
  records: readonly TelemetryRecord[],
): readonly TelemetryRecord[] {
  if (withinBatchLimits(records)) return records
  let fits = 0
  let low = 1
  let high = records.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (withinBatchLimits(records.slice(0, middle))) {
      fits = middle
      low = middle + 1
    } else high = middle - 1
  }
  return records.slice(0, fits)
}

/**
 * One bounded attempt. Sender returns the exact ordered event-ID array only after
 * authenticated durable acceptance. No command payloads, implicit retries or HTTP client.
 * Caller supplies a deadline-bearing signal; server deduplication by event ID is required.
 */
export async function drainTelemetryOnce(
  queue: TelemetryQueue,
  send: TelemetrySender,
  now: () => number,
  signal: AbortSignal,
): Promise<DrainResult> {
  if (active.has(queue)) return { status: 'retained', reason: 'busy' }
  if (signal.aborted) return { status: 'retained', reason: 'cancelled' }
  active.add(queue)
  let loss: QueueLoss | undefined
  let abort: (() => void) | undefined
  let delivery: Promise<unknown> | undefined
  let deliverySettled = false
  let finished = false
  try {
    let batch
    try {
      batch = queue.batch(now(), 100, 64 * 1024)
      loss = batch.loss
    } catch {
      return { status: 'uncertain', reason: 'queue' }
    }
    const records = fittingPrefix(batch.records)
    if (!records.length)
      return queue.depth
        ? { status: 'retained', reason: 'oversized', loss }
        : { status: 'empty', loss }
    const ids = records.map((record) => record.eventId)
    // The immutable serialized body prevents the adapter from changing the acknowledgement target.
    const body = JSON.stringify(records)
    let accepted: unknown
    try {
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(new Error('Telemetry delivery cancelled'))
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
      delivery = Promise.resolve().then(() => {
        if (signal.aborted) throw new Error('Telemetry delivery cancelled')
        return send(body, signal)
      })
      const settled = () => {
        deliverySettled = true
        if (finished) active.delete(queue)
      }
      // A cancelled caller can return immediately, but the sender still owns its slot
      // until it actually settles. Handle late rejection without acknowledging data.
      void delivery.then(settled, settled)
      accepted = await Promise.race([delivery, cancelled])
    } catch {
      return {
        status: 'retained',
        reason: signal.aborted ? 'cancelled' : 'transport',
        loss,
      }
    }
    if (signal.aborted) return { status: 'retained', reason: 'cancelled', loss }
    try {
      if (
        !Array.isArray(accepted) ||
        accepted.length !== ids.length ||
        ids.some(
          (id, index) =>
            !Object.hasOwn(accepted, index) || accepted[index] !== id,
        )
      )
        return { status: 'retained', reason: 'acknowledgement', loss }
    } catch {
      return { status: 'retained', reason: 'acknowledgement', loss }
    }
    try {
      queue.acknowledge(ids, now())
    } catch {
      return { status: 'uncertain', reason: 'queue', loss }
    }
    return { status: 'delivered', count: ids.length, loss }
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
    finished = true
    if (!delivery || deliverySettled) active.delete(queue)
  }
}
