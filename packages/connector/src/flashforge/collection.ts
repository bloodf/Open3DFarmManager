import { setTimeout as delay } from 'node:timers/promises'
import type { RawPrinterObservation } from '../runtime/farm-snapshot-provider.ts'
import {
  FlashforgeBindingSchema,
  readFlashforgeCredentials,
  type FlashforgeBinding,
} from './config.ts'
import { createFlashforgeAdapter } from './index.ts'

type Printer = Omit<RawPrinterObservation['printer'], 'statusReason'> & {
  statusReason: 'flashforge-simulated' | 'flashforge-unqualified'
}
export type FlashforgeObservation = Omit<
  RawPrinterObservation,
  'printer' | 'fieldObservedAtMonoMs'
> & {
  printer: Printer
  fieldObservedAtMonoMs: { flashforge: Partial<Record<keyof Printer, number>> }
}

export function createFlashforgeCollection(input: {
  binding: FlashforgeBinding
  allowedOrigins: readonly string[]
  signal: AbortSignal
  timeoutMs: number
  onObservation: (observation: FlashforgeObservation) => void
  onUnavailable: (epoch: number) => void
}) {
  const binding = FlashforgeBindingSchema.parse(input.binding)
  if (!input.allowedOrigins.includes(binding.origin)) {
    throw new Error('Flashforge collector origin not allowlisted')
  }
  const url = new URL(binding.origin)
  const { readStatus } = createFlashforgeAdapter({
    host: url.hostname,
    port: Number(url.port),
    timeoutMs: input.timeoutMs,
    ...readFlashforgeCredentials(binding),
  })
  const { signal } = input
  let epoch = 1
  let unavailable = false

  async function poll() {
    const result = await readStatus()
    if (result.model !== binding.expect.model)
      throw new Error('Flashforge model mismatch')
    const state =
      result.status === 'printing'
        ? 'printing'
        : result.status === 'pause'
          ? 'paused'
          : result.status === 'ready' ||
              result.status === 'completed' ||
              result.status === 'cancel'
            ? 'idle'
            : result.status === 'error'
              ? 'error'
              : 'unknown'
    const mono = performance.now()
    const progress = result.progress
    if (
      progress === undefined &&
      (state === 'printing' || state === 'paused')
    ) {
      throw new Error('Flashforge job progress unavailable')
    }
    return {
      printerKey: binding.printerKey,
      epoch,
      printer: {
        printerKey: binding.printerKey,
        state,
        ...(progress === undefined ? {} : { progress }),
        identity: { vendor: 'Flashforge', model: result.model },
        statusReason: binding.simulated
          ? 'flashforge-simulated'
          : 'flashforge-unqualified',
        observedAt: Date.now(),
      },
      receivedAtMonoMs: mono,
      fieldObservedAtMonoMs: {
        flashforge: {
          state: mono,
          identity: mono,
          statusReason: mono,
          ...(progress === undefined ? {} : { progress: mono }),
        },
      },
    } satisfies FlashforgeObservation
  }

  async function run() {
    while (!signal.aborted) {
      const observation = await poll().catch(() => undefined)
      if (signal.aborted) return
      if (observation) {
        input.onObservation(observation)
        unavailable = false
      } else if (!unavailable) {
        unavailable = true
        input.onUnavailable(epoch++)
      }
      try {
        await delay(2000, undefined, { signal })
      } catch (error) {
        if (!signal.aborted) throw error
      }
    }
  }

  return { done: run() }
}
