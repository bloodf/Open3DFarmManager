import { boundPrinterString } from '@open3dfarmmanager/farm-protocol'
import type { z } from 'zod'
import {
  connectFormlabs,
  isSupportedFormlabsModel,
  matchesBoundFormlabsModel,
} from '../formlabs/index.ts'
import type { FormlabsBinding } from '../formlabs/config.ts'
import type { RawPrinterObservation } from './farm-snapshot-provider.ts'

/** A successful read establishes only what the PreForm host reported. */
export function createFormlabsCollection(input: {
  binding: z.infer<typeof FormlabsBinding>
  signal: AbortSignal
  onObservation: (value: RawPrinterObservation) => void
  onUnavailable: (epoch: number, reason: string) => void
  pollMs?: number
}) {
  const adapter = connectFormlabs(input.binding)
  let epoch = 1
  let unavailable = false
  async function run() {
    while (!input.signal.aborted) {
      try {
        const result = await adapter.refresh()
        const device = result.devices.find(
          (d) => d.id === input.binding.deviceId,
        )
        if (!device || !device.is_connected) throw Error('offline')
        if (!isSupportedFormlabsModel(device.product_name))
          throw Error('unsupported model')
        if (
          !matchesBoundFormlabsModel(device.product_name, input.binding.model)
        )
          throw Error('model mismatch')
        if (input.signal.aborted) return
        const mono = performance.now()
        const firmware = device.firmware_version?.trim()
        const remainingMs = device.estimated_print_time_remaining_ms
        // Zero means no current print. It does not tell idle from an error,
        // so state stays unknown and only a positive estimate is published.
        const remaining =
          remainingMs !== undefined && remainingMs > 0
            ? { estimatedRemainingSeconds: Math.round(remainingMs / 1000) }
            : {}
        input.onObservation({
          printerKey: input.binding.printerKey,
          epoch,
          printer: {
            printerKey: input.binding.printerKey,
            state: 'unknown',
            preformStatus: boundPrinterString(device.status),
            identity: {
              vendor: 'Formlabs',
              model: input.binding.model,
              ...(firmware ? { firmware: boundPrinterString(firmware) } : {}),
            },
            ...remaining,
            observedAt: result.retrievedAt,
          },
          receivedAtMonoMs: mono,
          fieldObservedAtMonoMs: {
            formlabs: {
              state: mono,
              preformStatus: mono,
              identity: mono,
              ...('estimatedRemainingSeconds' in remaining
                ? { estimatedRemainingSeconds: mono }
                : {}),
            },
          },
        })
        unavailable = false
      } catch (error) {
        if (!input.signal.aborted && !unavailable) {
          unavailable = true
          input.onUnavailable(
            epoch++,
            error instanceof Error ? error.message : 'host unavailable',
          )
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, input.pollMs ?? 2000)
        function done() {
          clearTimeout(timer)
          input.signal.removeEventListener('abort', done)
          resolve()
        }
        input.signal.addEventListener('abort', done, { once: true })
        if (input.signal.aborted) done()
      })
    }
  }
  return { done: run() }
}
