import { setTimeout as delay } from 'node:timers/promises'
import { readPrusaLinkApiKey, type PrusaLinkBinding } from '../prusa/config.ts'
import { createPrusaLink } from '../prusa/index.ts'
import type { RawPrinterObservation } from './farm-snapshot-provider.ts'

export function createPrusaLinkCollection(input: {
  binding: PrusaLinkBinding
  signal: AbortSignal
  timeoutMs: number
  onObservation: (observation: RawPrinterObservation) => void
  onUnavailable: (epoch: number) => void
}) {
  const { binding, signal } = input
  const { discover, status } = createPrusaLink(
    binding.origin,
    readPrusaLinkApiKey(binding),
    input.timeoutMs,
  )
  let epoch = 1
  let unavailable = false

  async function run() {
    while (!signal.aborted) {
      try {
        const { version, info } = await discover()
        if (signal.aborted) return
        // Buddy encodes the model as a type/version/subversion tuple.
        if (
          version.printer !== binding.expect.printerType ||
          info.serial !== binding.expect.serial
        )
          throw Error('PrusaLink identity mismatch')
        const result = await status()
        if (signal.aborted) return
        const state = result.printer.state
        // No normalized state fits these two, so they stay `unknown` and the
        // wire word travels with them. Buddy's ATTENTION covers both a stopped
        // and a still moving print, so it is not mapped to `paused`.
        // prusa3d/Prusa-Firmware-Buddy @
        // b1043d68be188ad27ea72a14e160140e30e589f0,
        // src/state/printer_state.cpp (get_state, get_print_state, to_str)
        const needsWord = state === 'BUSY' || state === 'ATTENTION'
        const mono = performance.now()
        input.onObservation({
          printerKey: binding.printerKey,
          epoch,
          printer: {
            printerKey: binding.printerKey,
            state:
              state === 'PRINTING'
                ? 'printing'
                : state === 'PAUSED'
                  ? 'paused'
                  : state === 'IDLE' ||
                      state === 'FINISHED' ||
                      state === 'STOPPED'
                    ? 'idle'
                    : state === 'ERROR'
                      ? 'error'
                      : 'unknown',
            statusReason: 'prusa-link-unqualified',
            ...(needsWord ? { statusMessage: state } : {}),
            identity: { vendor: 'Prusa', model: binding.expect.printerType },
            observedAt: Date.now(),
          },
          receivedAtMonoMs: mono,
          fieldObservedAtMonoMs: {
            // The diagnostic word belongs to the same observation as state.
            prusaLink: { state: mono, identity: mono, statusReason: mono },
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
