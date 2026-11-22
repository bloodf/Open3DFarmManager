import type { z } from 'zod'
import { connectFormlabs, isSupportedFormlabsModel } from '../formlabs/index.ts'
import type { FormlabsBinding } from '../formlabs/config.ts'
import type { RawPrinterObservation } from './farm-snapshot-provider.ts'

/** Host retrieval time is not printer observation time; unknown status fails closed. */
export function createFormlabsCollection(input: {
  binding: z.infer<typeof FormlabsBinding>
  signal: AbortSignal
  onObservation: (value: RawPrinterObservation) => void
  onUnavailable: (epoch: number, reason: string) => void
  pollMs?: number
}) {
  const adapter = connectFormlabs(input.binding)
  let epoch = 1
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
        // No documented printer-side observation timestamp exists: do not publish
        // a cached status as fresh printer telemetry.
        input.onUnavailable(epoch++, 'printer observation time unknown')
      } catch (error) {
        if (!input.signal.aborted)
          input.onUnavailable(
            epoch++,
            error instanceof Error ? error.message : 'host unavailable',
          )
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, input.pollMs ?? 5000)
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
