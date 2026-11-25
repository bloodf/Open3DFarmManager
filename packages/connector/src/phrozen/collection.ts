import { setTimeout as delay } from 'node:timers/promises'
import type { RawPrinterObservation } from '../runtime/farm-snapshot-provider.ts'
import { parsePhrozenBinding, type PhrozenBinding } from './config.ts'
import { connectPhrozen } from './index.ts'
import { phrozenPrintState } from './operations.ts'
import type { PhrozenSession } from './transport.ts'
import {
  READ_ONLY_POLL_BUDGET_MS,
  READ_ONLY_POLL_MS,
} from '../runtime/snapshot-window.ts'

export type PhrozenObservation = Omit<RawPrinterObservation, 'printer'> & {
  printer: Omit<RawPrinterObservation['printer'], 'statusReason'> & {
    statusReason: 'phrozen-simulated' | 'phrozen-unqualified'
  }
}

/** SDCP "PrintInfo > CurrentLayer / TotalLayer". Display only. */
function layerFraction(info: unknown) {
  const { CurrentLayer, TotalLayer } = (info ?? {}) as Record<string, unknown>
  return typeof CurrentLayer === 'number' &&
    typeof TotalLayer === 'number' &&
    CurrentLayer >= 0 &&
    TotalLayer > 0 &&
    CurrentLayer <= TotalLayer
    ? CurrentLayer / TotalLayer
    : undefined
}

export function createPhrozenCollection(input: {
  binding: PhrozenBinding
  allowedOrigins: readonly string[]
  signal: AbortSignal
  timeoutMs: number
  pollMs?: number
  /** True once the Connector advertises controls for this printer. */
  controllable?: () => boolean
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
  // Discovery repeats every poll to recheck identity; the socket is kept.
  const session: PhrozenSession = {}
  const disconnect = () => {
    session.socket?.close()
    session.socket = undefined
  }

  async function run() {
    while (!signal.aborted) {
      try {
        const adapter = await connectPhrozen(origin.hostname, {
          udpPort: binding.discoveryPort,
          wsPort: Number(origin.port || 80),
          timeoutMs: Math.min(input.timeoutMs, READ_ONLY_POLL_BUDGET_MS),
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(READ_ONLY_POLL_BUDGET_MS),
          ]),
          session,
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
        const reported = phrozenPrintState(status).state
        const state =
          Array.isArray(current) && current.includes(1)
            ? reported === 'paused'
              ? 'paused'
              : 'printing'
            : Array.isArray(current) && current.length === 1 && current[0] === 0
              ? 'idle'
              : 'unknown'
        // Controls require progress (PrinterState); read-only reports none.
        const progress =
          input.controllable?.() && state !== 'unknown'
            ? state === 'idle'
              ? 0
              : layerFraction(status.PrintInfo)
            : undefined
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
            ...(progress === undefined ? {} : { progress }),
            observedAt: Date.now(),
          },
          receivedAtMonoMs: mono,
          fieldObservedAtMonoMs: {
            phrozen: {
              state: mono,
              identity: mono,
              statusReason: mono,
              ...(progress === undefined ? {} : { progress: mono }),
            },
          },
        })
        unavailable = false
      } catch {
        disconnect()
        if (!signal.aborted && !unavailable) {
          unavailable = true
          input.onUnavailable(epoch++)
        }
      }
      try {
        await delay(input.pollMs ?? READ_ONLY_POLL_MS, undefined, { signal })
      } catch (error) {
        if (!signal.aborted) throw error
      }
    }
  }

  return { done: run().finally(disconnect) }
}
