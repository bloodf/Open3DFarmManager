import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { parseQidiBinding, readQidiAuth } from '../qidi/config.ts'
import { createQidiAdapter } from '../qidi/index.ts'
import { qidiReadings } from '../qidi/readings.ts'
import type { RawPrinterObservation } from './farm-snapshot-provider.ts'
import {
  READ_ONLY_POLL_BUDGET_MS,
  READ_ONLY_POLL_MS,
} from './snapshot-window.ts'

type QidiPrinter = Omit<RawPrinterObservation['printer'], 'statusReason'> & {
  statusReason: 'qidi-simulated' | 'qidi-unqualified'
}
export type QidiObservation = Omit<
  RawPrinterObservation,
  'printer' | 'fieldObservedAtMonoMs'
> & {
  printer: QidiPrinter
  fieldObservedAtMonoMs: { qidi: Partial<Record<keyof QidiPrinter, number>> }
}

const State = z.object({
  printStats: z.object({
    state: z.enum([
      'standby',
      'printing',
      'paused',
      'complete',
      'cancelled',
      'error',
    ]),
  }),
  virtualSdcard: z.object({ progress: z.number().min(0).max(1) }),
})
const states = {
  standby: 'idle',
  printing: 'printing',
  paused: 'paused',
  complete: 'idle',
  cancelled: 'idle',
  error: 'error',
} satisfies Record<
  z.infer<typeof State>['printStats']['state'],
  QidiPrinter['state']
>

export function createQidiCollection(input: {
  binding: unknown
  allowedOrigins: readonly string[]
  signal: AbortSignal
  timeoutMs: number
  onObservation: (observation: QidiObservation) => void
  onUnavailable: (epoch: number) => void
}) {
  const { signal } = input
  const binding = parseQidiBinding(input.binding, input.allowedOrigins)
  const timeoutMs = z.number().int().min(1).max(3000).parse(input.timeoutMs)
  let epoch = 1
  let unavailable = false
  // Holds the private credential until a poll fails.
  let adapter: ReturnType<typeof createQidiAdapter> | undefined

  function connect() {
    const auth = readQidiAuth(binding)
    return createQidiAdapter({
      origin: binding.origin,
      ...(binding.expect.model ? { model: binding.expect.model } : {}),
      ...(auth ? { auth } : {}),
      timeoutMs: Math.min(timeoutMs, READ_ONLY_POLL_BUDGET_MS),
    })
  }

  async function run() {
    while (!signal.aborted) {
      try {
        const cycle = AbortSignal.any([
          signal,
          AbortSignal.timeout(READ_ONLY_POLL_BUDGET_MS),
        ])
        adapter ??= connect()
        // Probed every poll: it is the only proof Klippy is still ready.
        const info = await adapter.discover(cycle)
        if (signal.aborted) return
        if (
          info.moonrakerVersion !== binding.expect.moonrakerVersion ||
          !info.klippyConnected ||
          info.klippyState !== 'ready'
        )
          throw Error('Qidi probe did not match the configured ready source')
        const state = await adapter.readState(cycle)
        const status = State.parse(state)
        if (signal.aborted) return
        const { model } = binding.expect
        const readings = model ? qidiReadings(model, state) : {}
        const mono = performance.now()
        input.onObservation({
          printerKey: binding.printerKey,
          epoch,
          printer: {
            printerKey: binding.printerKey,
            state: states[status.printStats.state],
            progress: status.virtualSdcard.progress,
            identity: {
              vendor: 'Qidi',
            },
            statusReason: binding.simulated
              ? 'qidi-simulated'
              : 'qidi-unqualified',
            ...readings,
            observedAt: Date.now(),
          },
          receivedAtMonoMs: mono,
          fieldObservedAtMonoMs: {
            qidi: {
              state: mono,
              progress: mono,
              identity: mono,
              statusReason: mono,
              // Only these optional fields carry their own stamp.
              ...(readings.fans ? { fans: mono } : {}),
              ...(readings.materials ? { materials: mono } : {}),
            },
          },
        })
        unavailable = false
      } catch {
        adapter = undefined
        if (!signal.aborted && !unavailable) {
          unavailable = true
          input.onUnavailable(epoch++)
        }
      }
      try {
        await delay(READ_ONLY_POLL_MS, undefined, { signal })
      } catch (error) {
        if (!signal.aborted) throw error
      }
    }
  }

  return { done: run() }
}
