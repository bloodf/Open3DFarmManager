import { setTimeout as delay } from 'node:timers/promises'
import type { RawPrinterObservation } from '../runtime/farm-snapshot-provider.ts'
import { parsePhrozenBinding, type PhrozenBinding } from './config.ts'
import { connectPhrozen } from './index.ts'

export type PhrozenObservation = Omit<RawPrinterObservation, 'printer'> & {
  printer: Omit<RawPrinterObservation['printer'], 'statusReason'> & {
    statusReason: 'phrozen-simulated' | 'phrozen-unqualified'
  }
}

export function createPhrozenCollection(input: {
  binding: PhrozenBinding
  allowedOrigins: readonly string[]
  signal: AbortSignal
  timeoutMs: number
  pollMs?: number
  onObservation: (observation: PhrozenObservation) => void
  onUnavailable: (epoch: number) => void
}) {
  const { signal } = input
  const binding = parsePhrozenBinding(input.binding, input.allowedOrigins)
  const origin = new URL(binding.origin)
  const statusReason = binding.simulated
    ? 'phrozen-simulated'
    : 'phrozen-unqualified'
  let epoch = 1
  let unavailable = false

  async function run() {
    while (!signal.aborted) {
      try {
        const adapter = await connectPhrozen(origin.hostname, {
          udpPort: binding.discoveryPort,
          wsPort: Number(origin.port || 80),
          timeoutMs: input.timeoutMs,
        })
        if (signal.aborted) return
        const { id, board, model, firmware } = adapter.identity
        const expected = binding.expect
        if (
          id !== expected.id ||
          board !== expected.board ||
          model !== expected.model ||
          firmware !== expected.firmware
        )
          throw Error('Phrozen identity mismatch')
        const status = await adapter.readStatus()
        if (signal.aborted) return
        const current = status.CurrentStatus
        const state =
          Array.isArray(current) && current.includes(1)
            ? 'printing'
            : Array.isArray(current) && current.length === 1 && current[0] === 0
              ? 'idle'
              : 'unknown'
        const mono = performance.now()
        input.onObservation({
          printerKey: binding.printerKey,
          epoch,
          printer: {
            printerKey: binding.printerKey,
            state,
            identity: { vendor: 'Phrozen', model, firmware },
            controls: [],
            statusReason,
            observedAt: Date.now(),
          },
          receivedAtMonoMs: mono,
          fieldObservedAtMonoMs: {
            sdcp: {
              state: mono,
              identity: mono,
              controls: mono,
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
        await delay(input.pollMs ?? 2000, undefined, { signal })
      } catch (error) {
        if (!signal.aborted) throw error
      }
    }
  }

  return { done: run() }
}
