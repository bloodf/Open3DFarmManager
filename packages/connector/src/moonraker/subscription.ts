import { z } from 'zod'
import type { PrinterState } from '@open3dfarmmanager/farm-protocol'
import {
  parseTemperatureFields,
  type TemperatureFields,
} from './temperature-observation.ts'
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
export type RawMoonrakerObservation = Readonly<{
  printerKey: string
  epoch: number
  printer: Readonly<PrinterState>
  status: Readonly<{
    [Key in keyof z.infer<typeof Status>]: Readonly<z.infer<typeof Status>[Key]>
  }>
  fieldObservedAtMonoMs: Readonly<{
    webhooks: number
    printState: number
    progress: number
  }>
  receivedAtMonoMs: number
  temperatureObservation?: Readonly<{
    fields: TemperatureFields
    observedAtMonoMs: number
  }>
}>
export type RawMoonrakerUnavailable = Readonly<{
  printerKey: string
  epoch: number
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
const TemperatureSnapshot = Snapshot.extend({
  status: Status.extend({
    extruder: z.unknown().optional(),
    heater_bed: z.unknown().optional(),
  }),
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
  onRawObservation?: (observation: RawMoonrakerObservation) => void
  onRawUnavailable?: (event: RawMoonrakerUnavailable) => void
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
  function rawCallback(callback: () => unknown) {
    try {
      const result = callback()
      if (result !== undefined) {
        if (result instanceof Promise) void result.catch(() => {})
        throw Error('Raw callbacks must return synchronously with undefined')
      }
    } catch (error) {
      callbackFailure = { error }
      controller.abort()
      throw error
    }
  }
  let epoch = 0
  async function run() {
    let backoff = limits.reconnectMinMs
    emit({ kind: 'unavailable', printerKey, reason: 'connecting' })
    while (!signal.aborted) {
      if (++epoch > Number.MAX_SAFE_INTEGER) throw Error('Epoch exhausted')
      const currentEpoch = epoch
      let invalidated = false
      let fieldTimes:
        RawMoonrakerObservation['fieldObservedAtMonoMs'] | undefined
      function invalidate() {
        if (invalidated) return
        invalidated = true
        rawCallback(() =>
          input.onRawUnavailable?.(
            Object.freeze({ printerKey, epoch: currentEpoch }),
          ),
        )
      }
      let client: ReturnType<typeof openMoonrakerClient> | undefined
      let staleTimer: ReturnType<typeof setTimeout> | undefined
      let stale = false
      let baseline: z.infer<typeof Snapshot> | undefined
      let fingerprint: string | undefined
      function publish(
        value: z.infer<typeof Snapshot>,
        temperatureObservation?: RawMoonrakerObservation['temperatureObservation'],
      ) {
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
        if (input.onRawObservation && fieldTimes && !invalidated) {
          const observedTimes = fieldTimes
          rawCallback(() =>
            input.onRawObservation?.(
              Object.freeze({
                printerKey,
                epoch: currentEpoch,
                printer: Object.freeze({ ...parsed.printer }),
                status: Object.freeze({
                  webhooks: Object.freeze({ ...value.status.webhooks }),
                  print_stats: Object.freeze({ ...value.status.print_stats }),
                  virtual_sdcard: Object.freeze({
                    ...value.status.virtual_sdcard,
                  }),
                }),
                fieldObservedAtMonoMs: Object.freeze({ ...observedTimes }),
                receivedAtMonoMs: performance.now(),
                ...(temperatureObservation
                  ? {
                      temperatureObservation: Object.freeze({
                        observedAtMonoMs:
                          temperatureObservation.observedAtMonoMs,
                        fields: Object.freeze({
                          tool: Object.freeze({
                            ...temperatureObservation.fields.tool,
                          }),
                          bed: Object.freeze({
                            ...temperatureObservation.fields.bed,
                          }),
                        }),
                      }),
                    }
                  : {}),
              }),
            ),
          )
        }
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
          ...(input.onRawObservation
            ? {
                onInvalidated: invalidate,
                onComplete(
                  observation: import('./client.ts').MoonrakerCompleteObservation,
                ) {
                  const complete = TemperatureSnapshot.parse(observation.result)
                  const value = Snapshot.parse(complete)
                  if (
                    baseline &&
                    (value.eventtime < baseline.eventtime ||
                      (value.eventtime === baseline.eventtime &&
                        JSON.stringify(value.status) !==
                          JSON.stringify(baseline.status)))
                  )
                    throw Error('Ambiguous complete response ordering')
                  const stamp = observation.requestStartedAtMonoMs
                  // A delta received during this query has a newer local field
                  // observation. Discard this overlapping response rather than
                  // regress evidence or advance its conservative request anchor.
                  // The next fixed query is still scheduled by the client.
                  if (
                    fieldTimes &&
                    stamp < Math.max(...Object.values(fieldTimes))
                  )
                    return
                  fieldTimes = {
                    webhooks: stamp,
                    printState: stamp,
                    progress: stamp,
                  }
                  publish(value, {
                    fields: parseTemperatureFields(complete.status),
                    observedAtMonoMs: stamp,
                  })
                },
              }
            : {}),
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
            if (fieldTimes) {
              const now = performance.now()
              if (now < Math.max(...Object.values(fieldTimes)))
                throw Error('Clock regression')
              fieldTimes = {
                webhooks:
                  delta.webhooks?.state === undefined
                    ? fieldTimes.webhooks
                    : now,
                printState:
                  delta.print_stats?.state === undefined
                    ? fieldTimes.printState
                    : now,
                progress:
                  delta.virtual_sdcard?.progress === undefined
                    ? fieldTimes.progress
                    : now,
              }
            }
            publish({ eventtime, status })
          },
        })
        const initial = Snapshot.parse(await client.snapshot)
        if (!input.onRawObservation) publish(initial)
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
        try {
          invalidate()
        } finally {
          clearTimeout(staleTimer)
          if (client) {
            client.close()
            await client.closed
          }
          baseline = undefined
        }
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
