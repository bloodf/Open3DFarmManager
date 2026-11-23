import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { readPrivateJsonFile } from '../config/local.ts'
import type { PrusaLinkBinding } from '../prusa/config.ts'
import { createPrusaLink } from '../prusa/index.ts'
import type { RawPrinterObservation } from './farm-snapshot-provider.ts'

const Credential = z.strictObject({
  origin: z.string(),
  apiKey: z.string().regex(/^[!-~]{1,256}$/),
})

export function createPrusaLinkCollection(input: {
  binding: PrusaLinkBinding
  signal: AbortSignal
  timeoutMs: number
  onObservation: (observation: RawPrinterObservation) => void
  onUnavailable: (epoch: number) => void
}) {
  const { binding, signal } = input
  const credential = Credential.safeParse(
    readPrivateJsonFile(binding.apiKeyFile, { maxBytes: 8192 }),
  )
  if (!credential.success || credential.data.origin !== binding.origin)
    throw Error('Invalid PrusaLink credential')
  const { discover, status } = createPrusaLink(
    binding.origin,
    credential.data.apiKey,
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
            identity: { vendor: 'Prusa', model: binding.expect.printerType },
            observedAt: Date.now(),
          },
          receivedAtMonoMs: mono,
          fieldObservedAtMonoMs: {
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
