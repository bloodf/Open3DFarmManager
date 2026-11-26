import { setTimeout as delay } from 'node:timers/promises'
import type { RawPrinterObservation } from '../runtime/farm-snapshot-provider.ts'
import {
  READ_ONLY_POLL_BUDGET_MS,
  READ_ONLY_POLL_MS,
} from '../runtime/snapshot-window.ts'
import {
  parseHalotBinding,
  readHalotPassword,
  type HalotBinding,
} from './config.ts'
import {
  HalotTokenError,
  openHalotSession,
  type HalotSession,
} from './session.ts'
import { halotStatus } from './status.ts'

export type HalotObservation = Omit<RawPrinterObservation, 'printer'> & {
  printer: Omit<RawPrinterObservation['printer'], 'statusReason'> & {
    statusReason: 'halot-simulated' | 'halot-unqualified'
  }
}

/** A refused password will not heal by itself; do not hammer the printer. */
export const HALOT_REFUSED_RETRY_MS = 30_000

export function createHalotCollection(input: {
  binding: HalotBinding
  allowedOrigins: readonly string[]
  signal: AbortSignal
  timeoutMs: number
  pollMs?: number
  /** True once the Connector advertises controls for this printer. */
  controllable?: () => boolean
  onObservation: (observation: HalotObservation) => void
  onUnavailable: (epoch: number) => void
}) {
  const { signal } = input
  const binding = parseHalotBinding(input.binding, input.allowedOrigins)
  const password = readHalotPassword(binding)
  const origin = new URL(binding.origin)
  const statusReason = binding.simulated
    ? 'halot-simulated'
    : 'halot-unqualified'
  let epoch = 1
  let unavailable = false
  let session: HalotSession | undefined

  function publish(reply: Parameters<typeof halotStatus>[0]) {
    const status = halotStatus(reply)
    // Advertised controls require a progress value (PrinterState).
    if (status.state === 'idle' && input.controllable?.()) status.progress = 0
    const mono = performance.now()
    const printer: HalotObservation['printer'] = {
      printerKey: binding.printerKey,
      ...status,
      // The model is the owner's declaration; no reply names it.
      identity: { vendor: 'Creality', model: binding.expect.model },
      controls: [],
      statusReason,
      observedAt: Date.now(),
    }
    input.onObservation({
      printerKey: binding.printerKey,
      epoch,
      printer,
      receivedAtMonoMs: mono,
      fieldObservedAtMonoMs: {
        halot: Object.fromEntries(
          Object.keys(printer)
            .filter(
              (key) => !['printerKey', 'controls', 'observedAt'].includes(key),
            )
            .map((key) => [key, mono]),
        ),
      },
    })
    unavailable = false
  }

  function disconnect() {
    session?.close()
    session = undefined
  }

  async function run() {
    while (!signal.aborted) {
      let wait = input.pollMs ?? READ_ONLY_POLL_MS
      try {
        session ??= await openHalotSession({
          host: origin.hostname,
          port: Number(origin.port || 80),
          password,
          timeoutMs: Math.min(input.timeoutMs, READ_ONLY_POLL_BUDGET_MS),
          signal,
        })
        const reply = await session.readStatus()
        if (signal.aborted) return
        publish(reply)
      } catch (error) {
        disconnect()
        if (error instanceof HalotTokenError)
          wait = Math.max(wait, HALOT_REFUSED_RETRY_MS)
        if (!signal.aborted && !unavailable) {
          unavailable = true
          input.onUnavailable(epoch++)
        }
      }
      try {
        await delay(wait, undefined, { signal })
      } catch (error) {
        if (!signal.aborted) throw error
      }
    }
  }

  return { done: run().finally(disconnect) }
}
