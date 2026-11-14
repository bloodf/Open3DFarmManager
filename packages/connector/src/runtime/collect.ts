import { createBambuRuntimeSubscription } from '../bambu/runtime.ts'
import type { createBambuTransport } from '../bambu/transport.ts'
import type { RawPrinterObservation } from './farm-snapshot-provider.ts'
import { createKobraLinkRuntimeSubscription } from '../kobralink/runtime.ts'
import { parseLocalCollectorConfig } from '../config/local.ts'
import type { MoonrakerEvent } from '../moonraker/subscription.ts'
import type { KobraLinkFetch } from '../kobralink/client.ts'
import {
  createSpoolmanProvider,
  type SpoolmanSnapshot,
} from './spoolman-provider.ts'
import type { RawMoonrakerUnavailable } from '../moonraker/subscription.ts'
import { join } from 'node:path'
import type { PrinterState } from '@open3dfarmmanager/farm-protocol'
import { TelemetryQueue, type QueueLoss } from '../cloud/queue.ts'
import {
  readLocalCollectorConfig,
  type LocalCollectorConfig,
} from '../config/local.ts'
import { assertUnscopedCollection } from './queue-scope.ts'

export type Diagnostic =
  | { kind: 'queued'; depth: number }
  | { kind: 'queue-lock-recovered' }
  | {
      kind: 'loss'
      phase: 'recovery' | 'retention'
      expired: number
      capacity: number
      partialTail: boolean
    }
  | {
      kind: 'unavailable'
      reason:
        'connecting' | 'offline' | 'stale' | 'not-ready' | 'invalid-response'
    }
  | {
      kind: 'summary'
      queued: number
      expired: number
      capacity: number
      partialTail: boolean
      unavailable: number
    }

/** Local telemetry persistence only. No identity writes, sending or command path. */
export async function collectLocalTelemetry(input: {
  configPath: string
  dataDirectory: string
  signal: AbortSignal
  onDiagnostic: (diagnostic: Diagnostic) => void
}): Promise<void> {
  const config = readLocalCollectorConfig(input.configPath)
  if (input.signal.aborted) return
  const directory = join(input.dataDirectory, 'telemetry')
  assertUnscopedCollection(directory)
  const queue = new TelemetryQueue(
    directory,
    Date.now(),
    {},
    {
      beforeRecovery: () => {
        assertUnscopedCollection(directory)
        return undefined
      },
    },
  )
  try {
    await collectIntoQueue({ ...input, config, queue })
  } finally {
    queue.close()
  }
}

/** Caller owns the already-open queue and its scope/close lifecycle. */
export async function collectIntoQueue(input: {
  bambuTransport?: typeof createBambuTransport
  kobraFetch?: KobraLinkFetch
  config: LocalCollectorConfig
  onInventory?: (snapshot: SpoolmanSnapshot) => void
  onRawObservation?: (observation: RawPrinterObservation) => void
  onRawUnavailable?: (event: RawMoonrakerUnavailable) => void
  queue: TelemetryQueue
  signal: AbortSignal
  onDiagnostic: (diagnostic: Diagnostic) => void
}): Promise<void> {
  const config = parseLocalCollectorConfig(input.config)
  const { queue } = input
  const { createMoonrakerSubscription } =
    await import('../moonraker/subscription.ts')
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  const subscriptions: Array<{ done: Promise<void> }> = []
  let failure: { error: unknown } | undefined
  // Bound terminal diagnostics per run. Collection continues after this budget.
  let diagnosticBudget = 1024
  const totals = {
    queued: 0,
    expired: 0,
    capacity: 0,
    partialTail: false,
    unavailable: 0,
  }
  // Transitions are detected in memory; the first observation after a restart emits none.
  // Changes during unreachability fold into one transition from the last-known state at reconnect.
  const lastState = new Map<string, PrinterState['state']>()
  function diagnostic(value: Diagnostic) {
    if (diagnosticBudget-- > 0) input.onDiagnostic(value)
  }
  function loss(value: QueueLoss, phase: 'recovery' | 'retention') {
    totals.expired += value.expired
    totals.capacity += value.capacity
    totals.partialTail ||= value.partialTail
    if (value.expired || value.capacity || value.partialTail)
      diagnostic({ kind: 'loss', phase, ...value })
  }
  function fail(error: unknown) {
    failure ??= { error }
    controller.abort()
  }
  function onEvent(
    event: MoonrakerEvent | { kind: 'snapshot'; printer: PrinterState },
  ) {
    if (signal.aborted) return
    try {
      if (event.kind === 'unavailable') {
        totals.unavailable++
        diagnostic({ kind: 'unavailable', reason: event.reason })
      } else {
        const now = Date.now()
        const previous = lastState.get(event.printer.printerKey)
        lastState.set(event.printer.printerKey, event.printer.state)
        if (previous !== undefined && previous !== event.printer.state) {
          const transition = queue.enqueueTransition(
            {
              printerKey: event.printer.printerKey,
              from: previous,
              to: event.printer.state,
              observedAt: event.printer.observedAt,
            },
            now,
          )
          totals.queued++
          loss(transition.loss, 'retention')
        }
        const receipt = queue.enqueue(event.printer, now)
        totals.queued++
        loss(receipt.loss, 'retention')
        // enqueue returns only after its append/compaction and fsync succeed.
        diagnostic({ kind: 'queued', depth: queue.depth })
      }
    } catch (error) {
      fail(error)
    }
  }
  try {
    if (queue.recoveredStaleLock) diagnostic({ kind: 'queue-lock-recovered' })
    loss(queue.recovery, 'recovery')
    if (config.spoolman && !signal.aborted) {
      const provider = createSpoolmanProvider({
        config: config.spoolman,
        signal,
        ...(input.onInventory ? { onSnapshot: input.onInventory } : {}),
      })
      subscriptions.push({ done: provider.done.catch(fail) })
    }
    for (const assignment of config.printers) {
      if (signal.aborted) break
      const subscription = createMoonrakerSubscription({
        assignment,
        allowedOrigins: config.allowedOrigins,
        limits: config.limits,
        signal,
        ...(input.onRawObservation
          ? { onRawObservation: input.onRawObservation }
          : {}),
        ...(input.onRawUnavailable
          ? { onRawUnavailable: input.onRawUnavailable }
          : {}),
        onEvent,
      })
      // Attach rejection handling immediately, before starting another printer.
      subscriptions.push({ done: subscription.done.catch(fail) })
    }
    if (config.version === 2) {
      for (const binding of config.kobralink.printers) {
        let epoch = 1
        let sourceTime = -1
        let observedMono = -1
        let disconnectedMono = -1
        const unavailable = () => {
          input.onRawUnavailable?.({
            printerKey: binding.printerKey,
            epoch: epoch++,
          })
          onEvent({
            kind: 'unavailable',
            printerKey: binding.printerKey,
            reason: 'offline',
          })
        }
        const sub = createKobraLinkRuntimeSubscription({
          binding,
          allowedOrigins: config.kobralink.allowedOrigins,
          signal,
          ...(input.kobraFetch ? { fetch: input.kobraFetch } : {}),
          onUnavailable: unavailable,
          onStatus(status) {
            const now = performance.now()
            if (status.availability === 'disconnected') {
              disconnectedMono = now
              const printer: PrinterState = {
                printerKey: binding.printerKey,
                state: 'offline',
                observedAt: Date.now(),
              }
              input.onRawObservation?.({
                printerKey: binding.printerKey,
                epoch,
                printer,
                receivedAtMonoMs: now,
                fieldObservedAtMonoMs: { connection: now },
              })
              onEvent({ kind: 'snapshot', printer })
              return
            }
            const age =
              status.observedAt === null
                ? Infinity
                : Date.now() - status.observedAt
            if (
              status.availability !== 'available' ||
              status.progress === null ||
              status.observedAt === null ||
              age < 0 ||
              age >= 5000 ||
              now - age < disconnectedMono ||
              status.observedAt < sourceTime ||
              status.printState === 'unknown' ||
              status.printState === 'pausing'
            ) {
              unavailable()
              return
            }
            if (status.observedAt > sourceTime) {
              sourceTime = status.observedAt
              observedMono = now - age
            }
            if (observedMono < 0 || now - observedMono >= 5000) {
              unavailable()
              return
            }
            const state =
              status.printState === 'standby' ||
              status.printState === 'complete'
                ? 'idle'
                : status.printState
            const printer: PrinterState = {
              printerKey: binding.printerKey,
              state,
              progress: status.progress,
              observedAt: status.observedAt,
            }
            input.onRawObservation?.({
              printerKey: binding.printerKey,
              epoch,
              printer,
              receivedAtMonoMs: now,
              fieldObservedAtMonoMs: {
                webhooks: observedMono,
                printState: observedMono,
                progress: observedMono,
              },
            })
            onEvent({ kind: 'snapshot', printer, sourceEventtime: sourceTime })
          },
        })
        subscriptions.push({ done: sub.done.catch(fail) })
      }
    }
    if (config.version === 3) {
      for (const binding of config.bambu.printers) {
        if (signal.aborted) break
        let epoch = 1
        const sub = createBambuRuntimeSubscription({
          binding,
          signal,
          staleAfterMs: 5000,
          ...(input.bambuTransport ? { transport: input.bambuTransport } : {}),
          onEvent(event) {
            if (event.kind === 'unavailable') {
              input.onRawUnavailable?.({
                printerKey: binding.printerKey,
                epoch: epoch++,
              })
              onEvent({
                kind: 'unavailable',
                printerKey: binding.printerKey,
                reason: 'offline',
              })
              return
            }
            input.onRawObservation?.({
              printerKey: binding.printerKey,
              epoch,
              printer: event.printer,
              receivedAtMonoMs: performance.now(),
              fieldObservedAtMonoMs: {
                bambu: event.source.fieldObservedAtMonoMs,
              },
            })
            onEvent(event)
          },
        })
        subscriptions.push({ done: sub.done.catch(fail) })
      }
    }
    await Promise.all(subscriptions.map((subscription) => subscription.done))
  } catch (error) {
    fail(error)
  } finally {
    controller.abort()
    await Promise.all(subscriptions.map((subscription) => subscription.done))
    try {
      input.onDiagnostic({ kind: 'summary', ...totals })
    } catch (error) {
      fail(error)
    }
  }
  if (failure) throw failure.error
}
