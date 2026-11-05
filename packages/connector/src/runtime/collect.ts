import type {
  RawMoonrakerObservation,
  RawMoonrakerUnavailable,
} from '../moonraker/subscription.ts'
import { join } from 'node:path'
import { TelemetryQueue, type QueueLoss } from '../cloud/queue.ts'
import {
  readLocalCollectorConfig,
  type LocalCollectorConfig,
} from '../config/local.ts'
import { assertUnscopedCollection } from './queue-scope.ts'

export type Diagnostic =
  | { kind: 'queued'; depth: number }
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
        | 'connecting'
        | 'offline'
        | 'stale'
        | 'not-ready'
        | 'invalid-response'
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
  config: LocalCollectorConfig
  onRawObservation?: (observation: RawMoonrakerObservation) => void
  onRawUnavailable?: (event: RawMoonrakerUnavailable) => void
  queue: TelemetryQueue
  signal: AbortSignal
  onDiagnostic: (diagnostic: Diagnostic) => void
}): Promise<void> {
  const { config, queue } = input
  const { createMoonrakerSubscription } = await import(
    '../moonraker/subscription.ts'
  )
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
  try {
    loss(queue.recovery, 'recovery')
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
        onEvent(event) {
          if (signal.aborted) return
          try {
            if (event.kind === 'unavailable') {
              totals.unavailable++
              diagnostic({ kind: 'unavailable', reason: event.reason })
            } else {
              const receipt = queue.enqueue(event.printer, Date.now())
              totals.queued++
              loss(receipt.loss, 'retention')
              // enqueue returns only after its append/compaction and fsync succeed.
              diagnostic({ kind: 'queued', depth: queue.depth })
            }
          } catch (error) {
            fail(error)
          }
        },
      })
      // Attach rejection handling immediately, before starting another printer.
      subscriptions.push({ done: subscription.done.catch(fail) })
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
