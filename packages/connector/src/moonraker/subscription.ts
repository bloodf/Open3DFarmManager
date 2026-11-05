import { z } from 'zod'
import type { PrinterState } from '@open3dfarmmanager/farm-protocol'
import { parseMoonrakerSnapshot } from './parse.ts'
import {
  MoonrakerClientError,
  openMoonrakerClient,
  readMoonrakerReady,
  validateMoonrakerInput,
  type MoonrakerFailureReason,
  type MoonrakerLimits,
} from './client.ts'

export type MoonrakerAssignment = Readonly<{
  printerKey: string
  origin: string
}>
export type MoonrakerEvent =
  | { kind: 'snapshot'; printer: PrinterState; sourceEventtime: number }
  | {
      kind: 'unavailable'
      printerKey: string
      reason: 'connecting' | MoonrakerFailureReason
    }

const webhookState = z.enum(['ready', 'startup', 'shutdown', 'error'])
const printState = z.enum([
  'standby',
  'printing',
  'paused',
  'error',
  'complete',
  'cancelled',
])
const progress = z.number().finite().min(0).max(1)
const Status = z.object({
  webhooks: z.object({ state: webhookState }),
  print_stats: z.object({ state: printState }),
  virtual_sdcard: z.object({ progress }),
})
const Snapshot = z.object({
  eventtime: z.number().finite().nonnegative(),
  status: Status,
})
const Delta = z.tuple([
  z.object({
    webhooks: z.object({ state: webhookState.optional() }).optional(),
    print_stats: z.object({ state: printState.optional() }).optional(),
    virtual_sdcard: z.object({ progress: progress.optional() }).optional(),
  }),
  z.number().finite().nonnegative(),
])

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })
}

/** Local configuration only. This does not register or authorize a 0015 assignment. */
export function createMoonrakerSubscription(input: {
  assignment: MoonrakerAssignment
  allowedOrigins: readonly string[]
  limits: MoonrakerLimits
  onEvent: (event: MoonrakerEvent) => void
  signal: AbortSignal
}): { done: Promise<void> } {
  const { printerKey, origin, limits } = validateMoonrakerInput(input)
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  let callbackFailure: { error: unknown } | undefined
  let lastUnavailable: string | undefined
  function emit(event: MoonrakerEvent) {
    if (signal.aborted) return
    if (event.kind === 'unavailable') {
      if (event.reason === lastUnavailable) return
      lastUnavailable = event.reason
    } else lastUnavailable = undefined
    try {
      const result: unknown = input.onEvent(event)
      if (result !== undefined) {
        if (result instanceof Promise) void result.catch(() => {})
        throw new Error(
          'Moonraker onEvent must return synchronously with undefined',
        )
      }
    } catch (error) {
      callbackFailure = { error }
      controller.abort()
    }
  }
  async function run() {
    let backoff = limits.reconnectMinMs
    emit({ kind: 'unavailable', printerKey, reason: 'connecting' })
    while (!signal.aborted) {
      let client: ReturnType<typeof openMoonrakerClient> | undefined
      let staleTimer: ReturnType<typeof setTimeout> | undefined
      let stale = false
      let baseline: z.infer<typeof Snapshot> | undefined
      let fingerprint: string | undefined
      function publish(value: z.infer<typeof Snapshot>) {
        if (signal.aborted) return
        baseline = value
        clearTimeout(staleTimer)
        staleTimer = setTimeout(() => {
          stale = true
          client?.close()
        }, limits.staleAfterMs)
        const parsed = parseMoonrakerSnapshot(
          JSON.stringify({ result: value }),
          {
            printerKey,
            observedAt: Date.now(),
          },
        )
        const nextFingerprint = JSON.stringify([
          parsed.printer.state,
          parsed.printer.progress,
        ])
        if (nextFingerprint === fingerprint) return
        fingerprint = nextFingerprint
        emit({ kind: 'snapshot', ...parsed })
      }
      try {
        await readMoonrakerReady({ origin, limits, signal })
        if (signal.aborted) break
        client = openMoonrakerClient({
          origin,
          limits,
          signal,
          onStatus(params) {
            const [delta, eventtime] = Delta.parse(params)
            if (!baseline) throw new Error('No baseline')
            const status = {
              webhooks: {
                state: delta.webhooks?.state ?? baseline.status.webhooks.state,
              },
              print_stats: {
                state:
                  delta.print_stats?.state ?? baseline.status.print_stats.state,
              },
              virtual_sdcard: {
                progress:
                  delta.virtual_sdcard?.progress ??
                  baseline.status.virtual_sdcard.progress,
              },
            }
            if (eventtime < baseline.eventtime) return
            if (eventtime === baseline.eventtime) {
              if (JSON.stringify(status) !== JSON.stringify(baseline.status))
                throw new Error('Conflicting source time')
              return
            }
            // Empty/unselected deltas cannot establish freshness of selected fields.
            if (
              delta.webhooks?.state === undefined &&
              delta.print_stats?.state === undefined &&
              delta.virtual_sdcard?.progress === undefined
            )
              return
            publish({ eventtime, status })
          },
        })
        publish(Snapshot.parse(await client.snapshot))
        backoff = limits.reconnectMinMs
        const reason = await client.closed
        if (!signal.aborted)
          emit({
            kind: 'unavailable',
            printerKey,
            reason: stale ? 'stale' : reason,
          })
      } catch (error) {
        if (!signal.aborted)
          emit({
            kind: 'unavailable',
            printerKey,
            reason:
              error instanceof MoonrakerClientError
                ? error.reason
                : 'invalid-response',
          })
      } finally {
        clearTimeout(staleTimer)
        if (client) {
          client.close()
          await client.closed
        }
        baseline = undefined
      }
      if (!signal.aborted) {
        await delay(backoff, signal)
        backoff = Math.min(limits.reconnectMaxMs, backoff * 2)
      }
    }
    if (callbackFailure) throw callbackFailure.error
  }
  return { done: run() }
}
