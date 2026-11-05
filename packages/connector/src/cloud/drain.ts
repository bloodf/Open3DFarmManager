import { TelemetryQueue, type QueueLoss } from './queue.ts'

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
        | 'busy'
        | 'cancelled'
        | 'transport'
        | 'acknowledgement'
        | 'oversized'
      loss?: QueueLoss
    }

const active = new WeakSet<TelemetryQueue>()

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
    if (!batch.records.length)
      return queue.depth
        ? { status: 'retained', reason: 'oversized', loss }
        : { status: 'empty', loss }
    const ids = batch.records.map((record) => record.eventId)
    // The immutable serialized body prevents the adapter from changing the acknowledgement target.
    const body = JSON.stringify(batch.records)
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
