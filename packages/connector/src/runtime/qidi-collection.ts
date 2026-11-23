import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { parseQidiBinding, readQidiAuth } from '../qidi/config.ts'
import { createQidiAdapter } from '../qidi/index.ts'
import type { RawPrinterObservation } from './farm-snapshot-provider.ts'

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

  async function run() {
    while (!signal.aborted) {
      try {
        const auth = readQidiAuth(binding)
        const { discover, readState } = createQidiAdapter({
          origin: binding.origin,
          ...(auth ? { auth } : {}),
          timeoutMs,
        })
        const info = await discover()
        if (signal.aborted) return
        if (
          info.moonrakerVersion !== binding.expect.moonrakerVersion ||
          !info.klippyConnected ||
          info.klippyState !== 'ready'
        )
          throw Error('Qidi probe did not match the configured ready source')
        const status = State.parse(await readState())
        if (signal.aborted) return
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
              model: binding.expect.model,
              firmware: binding.expect.firmware,
            },
            statusReason: binding.simulated
              ? 'qidi-simulated'
              : 'qidi-unqualified',
            observedAt: Date.now(),
          },
          receivedAtMonoMs: mono,
          fieldObservedAtMonoMs: {
            qidi: {
              state: mono,
              progress: mono,
              identity: mono,
              statusReason: mono,
            },
          },
        })
        unavailable = false
      } catch {
        if (!signal.aborted && !unavailable) {
          unavailable = true
          input.onUnavailable(epoch++)
        }
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
