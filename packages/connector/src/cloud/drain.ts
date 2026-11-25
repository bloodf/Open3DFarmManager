import {
  parseBoundedJson,
  TELEMETRY_BATCH_JSON_LIMITS,
  TelemetryBatch,
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
  | { status: 'dropped'; loss: QueueLoss }
  | { status: 'delivered'; count: number; loss: QueueLoss }
  | {
      status: 'retained'
      reason: 'busy' | 'cancelled' | 'transport' | 'acknowledgement'
      loss?: QueueLoss
    }

const active = new WeakSet<TelemetryQueue>()
const MAX_BATCH_RECORDS = 100

function withSendAge(record: TelemetryRecord, now: number): TelemetryRecord {
  if (record.kind !== 'printer-state' && record.kind !== 'inventory-snapshot')
    return record
  const observedAt =
    record.kind === 'printer-state'
      ? record.state.observedAt
      : record.inventory.observedAt
  if (observedAt > now || record.queuedAt > now) return record
  return { ...record, ageAtSendMs: now - Math.min(observedAt, record.queuedAt) }
}

function withinBatchLimits(records: readonly TelemetryRecord[]): boolean {
  try {
    TelemetryBatch.parse(
      parseBoundedJson(JSON.stringify(records), TELEMETRY_BATCH_JSON_LIMITS),
    )
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
  onDrop: () => void = () => console.warn('telemetry-entry-dropped'),
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
    let records: readonly TelemetryRecord[]
    for (let dropped = 0; ; dropped++) {
      if (loss && (dropped === MAX_BATCH_RECORDS || queue.storageDegraded))
        return { status: 'dropped', loss }
      if (signal.aborted)
        return {
          status: 'retained',
          reason: 'cancelled',
          ...(loss && { loss }),
        }
      let batch
      let batchNow
      try {
        batchNow = now()
        batch = queue.batch(
          batchNow,
          MAX_BATCH_RECORDS,
          TELEMETRY_BATCH_JSON_LIMITS.maxBytes,
        )
      } catch {
        return { status: 'uncertain', reason: 'queue', ...(loss && { loss }) }
      }
      if (loss) {
        loss.expired += batch.loss.expired
        loss.capacity += batch.loss.capacity
        loss.partialTail ||= batch.loss.partialTail
      } else {
        loss = batch.loss
      }
      if (signal.aborted)
        return { status: 'retained', reason: 'cancelled', loss }
      records = fittingPrefix(
        batch.records.map((record) => withSendAge(record, batchNow)),
      )
      if (records.length) break
      if (!queue.depth) return { status: 'empty', loss }
      // Batch preparation and removal are synchronous. The unencodable head
      // has not reached the sender and cannot be fixed by retrying it.
      try {
        queue.discardHead(batchNow)
      } catch {
        return { status: 'uncertain', reason: 'queue', loss }
      }
      onDrop()
    }
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
