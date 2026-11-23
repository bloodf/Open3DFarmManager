import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { PrinterState } from '@open3dfarmmanager/farm-protocol'
import {
  parseTemperatureFields,
  isChamberTemperatureObject,
  observedTemperatureDetails,
  type TemperatureFields,
} from './temperature-observation.ts'
import { moonrakerLastJob } from './normalize.ts'
import { parseMoonrakerSnapshot } from './parse.ts'
import { hasMoonrakerPendingDispatch } from './pending-dispatch.ts'
import {
  SNAPMAKER_U1_STATUS_OBJECTS,
  isSnapmakerU1Model,
  isSnapmakerU1StatusObject,
  mapSnapmakerU1Tools,
} from './u1-tools.ts'
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
  /** Locally declared model; "Snapmaker U1" opts into the U1 tool mapping. */
  model?: string | undefined
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
  /** Source time of the duration sample, when it was in this status update. */
  durationSourceTime?: number
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
const OptionalTelemetry = z
  .record(z.string(), z.unknown())
  .transform((status) => {
    const fields: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(status)) {
      if (/^extruder(?:[1-9][0-9]{0,2})?$/.test(name)) {
        if (typeof value === 'object' && value !== null && 'target' in value)
          fields[name] = { target: value.target }
      } else if (
        name === 'fan' ||
        name.startsWith('fan_generic ') ||
        name === 'output_pin caselight' ||
        isChamberTemperatureObject(name)
      )
        fields[name] = value
    }
    return fields
  })
const Status = z
  .object({
    webhooks: z.object({ state: webhookState }),
    print_stats: z.object({
      state: printState,
      filename: z.unknown().optional(),
      print_duration: z.unknown().optional(),
      total_duration: z.unknown().optional(),
      filament_used: z.unknown().optional(),
      info: z.unknown().optional(),
    }),
    virtual_sdcard: z.object({ progress }),
  })
  .catchall(z.unknown())
const Snapshot = z.object({
  eventtime: z.number().finite().nonnegative(),
  status: Status.transform((status) => ({
    webhooks: status.webhooks,
    print_stats: status.print_stats,
    virtual_sdcard: status.virtual_sdcard,
    ...OptionalTelemetry.parse(status),
  })),
})
const TemperatureSnapshot = Snapshot.extend({
  status: Status.extend({
    extruder: z.unknown().optional(),
    heater_bed: z.unknown().optional(),
  }),
})
const Delta = z.tuple([
  z
    .object({
      webhooks: z.object({ state: webhookState.optional() }).optional(),
      print_stats: z
        .object({
          state: printState.optional(),
          filename: z.unknown().optional(),
          print_duration: z.unknown().optional(),
          total_duration: z.unknown().optional(),
          filament_used: z.unknown().optional(),
          info: z.unknown().optional(),
        })
        .optional(),
      virtual_sdcard: z.object({ progress: progress.optional() }).optional(),
    })
    .catchall(z.unknown()),
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
export type MoonrakerLinkHealth = {
  success(startedAtMonoMs: number, receivedAtMonoMs: number): void
  failure(code: string): void
  reconnect(): void
}

export function createMoonrakerSubscription(input: {
  assignment: MoonrakerAssignment
  allowedOrigins: readonly string[]
  limits: MoonrakerLimits
  discoverObjects?: boolean
  /** Request job fields and report the last job this subscription watched end. */
  jobFields?: boolean
  /**
   * Whether OpenFarm has a pending dispatch for this printer. Defaults to the
   * registered resolvers (see `pending-dispatch.ts`).
   */
  hasPendingDispatch?: () => boolean
  linkHealth?: MoonrakerLinkHealth
  onEvent: (event: MoonrakerEvent) => void
  onRawObservation?: (observation: RawMoonrakerObservation) => void
  onRawUnavailable?: (event: RawMoonrakerUnavailable) => void
  signal: AbortSignal
}): { done: Promise<void> } {
  const { printerKey, origin, limits } = validateMoonrakerInput(input)
  const snapmakerU1 = isSnapmakerU1Model(input.assignment.model)
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
  // Keep the latest watched finish, or a first terminal snapshot when OpenFarm
  // has a pending dispatch on this printer; other unwatched ends come from the
  // history import. Reconnects must not assign a new end time to terminal
  // status that Moonraker retains.
  let lastJob: PrinterState['lastJob']
  let hasObservedStatus = false
  async function run() {
    let backoff = limits.reconnectMinMs
    emit({ kind: 'unavailable', printerKey, reason: 'connecting' })
    while (!signal.aborted) {
      if (epoch > 0) input.linkHealth?.reconnect()
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
      // Reset per connection: an end seen only after a reconnect is unwatched.
      let watchingJob = false
      // U1 only: latest per-tool status, and every tool seen active while the
      // watched job ran (`null` when the printer did not say).
      const toolStatus: Record<string, Record<string, unknown>> = {}
      const jobTools = new Set<string | null>()
      function observeTools(status: unknown) {
        if (!snapmakerU1 || !status || typeof status !== 'object') return
        for (const [name, value] of Object.entries(status)) {
          if (
            !isSnapmakerU1StatusObject(name) ||
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value)
          )
            continue
          toolStatus[name] = { ...toolStatus[name], ...value }
        }
      }
      function u1Materials(): PrinterState['materials'] {
        if (!snapmakerU1) return undefined
        return mapSnapmakerU1Tools(toolStatus).tools.map((tool) => ({
          slot: tool.tool,
          ...(tool.active === null ? {} : { active: tool.active }),
        }))
      }
      function publish(
        value: z.infer<typeof Snapshot>,
        temperatureObservation?: RawMoonrakerObservation['temperatureObservation'],
        durationSourceTime?: number,
      ) {
        if (signal.aborted) return
        const firstObservation = !hasObservedStatus
        hasObservedStatus = true
        baseline = value
        clearTimeout(staleTimer)
        staleTimer = setTimeout(() => {
          stale = true
          client?.close()
        }, limits.staleAfterMs)
        const parsed = parseMoonrakerSnapshot(
          JSON.stringify({
            result: {
              ...value,
              status: {
                ...value.status,
                print_stats: {
                  state: value.status.print_stats.state,
                  ...(input.jobFields
                    ? {
                        info: value.status.print_stats.info,
                        print_duration: value.status.print_stats.print_duration,
                      }
                    : {}),
                },
              },
            },
          }),
          {
            printerKey,
            observedAt: Date.now(),
          },
        )
        const materials = u1Materials()
        if (input.onRawObservation && fieldTimes && !invalidated) {
          const observedTimes = fieldTimes
          rawCallback(() =>
            input.onRawObservation?.(
              Object.freeze({
                printerKey,
                epoch: currentEpoch,
                printer: Object.freeze({
                  ...parsed.printer,
                  ...(materials ? { materials } : {}),
                }),
                status: Object.freeze({
                  webhooks: Object.freeze({ ...value.status.webhooks }),
                  print_stats: Object.freeze({ ...value.status.print_stats }),
                  virtual_sdcard: Object.freeze({
                    ...value.status.virtual_sdcard,
                  }),
                }),
                fieldObservedAtMonoMs: Object.freeze({ ...observedTimes }),
                receivedAtMonoMs: performance.now(),
                ...(durationSourceTime === undefined
                  ? {}
                  : { durationSourceTime }),
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
        const jobState = value.status.print_stats.state
        if (!input.jobFields) watchingJob = false
        else if (jobState === 'printing' || jobState === 'paused') {
          if (!watchingJob) jobTools.clear()
          watchingJob = true
          if (materials)
            jobTools.add(
              materials.some((tool) => tool.active === undefined)
                ? null
                : (materials.find((tool) => tool.active)?.slot ?? null),
            )
        } else if (
          watchingJob ||
          (firstObservation &&
            (input.hasPendingDispatch
              ? input.hasPendingDispatch()
              : hasMoonrakerPendingDispatch(printerKey)))
        ) {
          const ended = moonrakerLastJob(
            value.status,
            parsed.printer.observedAt,
          )
          if (ended) {
            // A U1 reports one total length for all tools: it is attributed
            // to a tool only when that tool alone was active for the whole job.
            const [only] = jobTools
            lastJob =
              materials && ended.filamentUsedMillimetres !== undefined
                ? {
                    ...ended,
                    filamentUsage: [
                      {
                        tool:
                          jobTools.size === 1 && typeof only === 'string'
                            ? only
                            : 'unknown',
                        millimetres: ended.filamentUsedMillimetres,
                      },
                    ],
                  }
                : ended
            watchingJob = false
          }
        }
        const temperatures = input.jobFields
          ? observedTemperatureDetails(value.status)
          : undefined
        const nextFingerprint = JSON.stringify([
          parsed.printer.state,
          parsed.printer.progress,
          parsed.printer.fans,
          parsed.printer.light,
          parsed.printer.currentLayer,
          parsed.printer.totalLayer,
          parsed.printer.printDuration,
          temperatures,
          materials,
          lastJob?.endedAt,
        ])
        if (nextFingerprint === fingerprint) return
        fingerprint = nextFingerprint
        const printer = {
          ...parsed.printer,
          ...temperatures,
          ...(materials ? { materials } : {}),
        }
        emit({
          kind: 'snapshot',
          ...parsed,
          printer: lastJob ? { ...printer, lastJob } : printer,
        })
      }
      try {
        await readMoonrakerReady({ origin, limits, signal })
        if (signal.aborted) break
        client = openMoonrakerClient({
          origin,
          limits,
          ...(input.linkHealth
            ? { onRequestSuccess: input.linkHealth.success }
            : {}),
          signal,
          ...(input.discoverObjects ? { discoverObjects: true } : {}),
          ...(input.jobFields ? { jobFields: true } : {}),
          ...(snapmakerU1 ? { extraObjects: SNAPMAKER_U1_STATUS_OBJECTS } : {}),
          ...(input.onRawObservation
            ? {
                onInvalidated: invalidate,
                onComplete(
                  observation: import('./client.ts').MoonrakerCompleteObservation,
                ) {
                  const complete = TemperatureSnapshot.parse(observation.result)
                  observeTools(complete.status)
                  const value = Snapshot.parse(complete)
                  const stamp = observation.requestStartedAtMonoMs
                  const fields = parseTemperatureFields(
                    complete.status,
                    observation.activeToolQuery,
                  )
                  // A delta received during this query has a newer local field
                  // observation. Discard this overlapping response rather than
                  // regress evidence or advance its conservative request anchor.
                  // The next fixed query is still scheduled by the client.
                  if (
                    fieldTimes &&
                    stamp < Math.max(...Object.values(fieldTimes))
                  ) {
                    // A changing progress delta must win over this query. The
                    // same query can still conservatively confirm unchanged
                    // fields that have not received a newer delta. Publish no
                    // stale values; the next delta carries these field clocks.
                    if (baseline) {
                      fieldTimes = {
                        webhooks:
                          stamp >= fieldTimes.webhooks &&
                          value.status.webhooks.state ===
                            baseline.status.webhooks.state
                            ? stamp
                            : fieldTimes.webhooks,
                        printState:
                          stamp >= fieldTimes.printState &&
                          value.status.print_stats.state ===
                            baseline.status.print_stats.state
                            ? stamp
                            : fieldTimes.printState,
                        progress:
                          stamp >= fieldTimes.progress &&
                          value.status.virtual_sdcard.progress ===
                            baseline.status.virtual_sdcard.progress
                            ? stamp
                            : fieldTimes.progress,
                      }
                      // Temperature is independent display evidence from this
                      // complete query. Keep the newer delta's state/progress
                      // while publishing those conservatively timed readings.
                      publish(baseline, { fields, observedAtMonoMs: stamp })
                    }
                    return
                  }
                  if (
                    baseline &&
                    (value.eventtime < baseline.eventtime ||
                      (value.eventtime === baseline.eventtime &&
                        !isDeepStrictEqual(value.status, baseline.status)))
                  )
                    throw Error('Ambiguous complete response ordering')
                  fieldTimes = {
                    webhooks: stamp,
                    printState: stamp,
                    progress: stamp,
                  }
                  publish(
                    value,
                    { fields, observedAtMonoMs: stamp },
                    value.eventtime,
                  )
                },
              }
            : {}),
          onStatus(params) {
            const [delta, eventtime] = Delta.parse(params)
            if (!baseline) throw new Error('No baseline')
            if (eventtime >= baseline.eventtime) observeTools(delta)
            const optional = OptionalTelemetry.parse(delta)
            const optionalStatus = OptionalTelemetry.parse(baseline.status)
            for (const [name, fields] of Object.entries(optional)) {
              const previous = optionalStatus[name]
              optionalStatus[name] =
                fields &&
                previous &&
                typeof fields === 'object' &&
                typeof previous === 'object' &&
                !Array.isArray(fields) &&
                !Array.isArray(previous)
                  ? { ...previous, ...fields }
                  : fields
            }
            const status = {
              ...optionalStatus,
              webhooks: {
                state: delta.webhooks?.state ?? baseline.status.webhooks.state,
              },
              print_stats: {
                ...baseline.status.print_stats,
                ...delta.print_stats,
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
              if (!isDeepStrictEqual(status, baseline.status))
                throw new Error('Conflicting source time')
              return
            }
            // Empty/unselected deltas cannot establish freshness of selected fields.
            if (
              Object.keys(optional).length === 0 &&
              delta.webhooks?.state === undefined &&
              delta.print_stats === undefined &&
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
            publish(
              { eventtime, status },
              undefined,
              delta.print_stats?.total_duration === undefined
                ? undefined
                : eventtime,
            )
          },
        })
        const raw = await client.snapshot
        const initial = Snapshot.parse(raw)
        observeTools((raw as { status?: unknown }).status)
        if (!input.onRawObservation) publish(initial)
        backoff = limits.reconnectMinMs
        const reason = await client.closed
        if (!signal.aborted) {
          const code = stale ? 'stale' : reason
          input.linkHealth?.failure(code)
          emit({ kind: 'unavailable', printerKey, reason: code })
        }
      } catch (error) {
        if (!signal.aborted) {
          const reason =
            error instanceof MoonrakerClientError
              ? error.reason
              : 'invalid-response'
          input.linkHealth?.failure(reason)
          emit({ kind: 'unavailable', printerKey, reason })
        }
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
