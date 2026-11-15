import { createCrealityTelemetryClient } from '../creality/index.ts'
import type { CrealityCollectorConfig } from '../config/creality.ts'
import type { RawPrinterObservation } from './farm-snapshot-provider.ts'
import { PrinterState } from '../../../farm-protocol/src/state.ts'

/** Each frame must independently prove state and progress, including after reconnect. */
export function createCrealityCollection(input: {
  binding: CrealityCollectorConfig['creality']['printers'][number]
  signal: AbortSignal
  onObservation: (value: RawPrinterObservation) => void
  onUnavailable: (epoch: number) => void
}) {
  let epoch = 1
  let timer: ReturnType<typeof setTimeout> | undefined
  const invalidate = () => {
    clearTimeout(timer)
    if (!input.signal.aborted) input.onUnavailable(epoch++)
  }
  if (input.signal.aborted) return { done: Promise.resolve() }
  const client = createCrealityTelemetryClient({
    ...input.binding,
    onTelemetry(report) {
      if (input.signal.aborted) return
      const printer = PrinterState.safeParse({
        printerKey: input.binding.printerKey,
        state: report.state,
        ...(report.progress === undefined
          ? {}
          : { progress: report.progress / 100 }),
        ...(report.filename === undefined ? {} : { filename: report.filename }),
        ...(report.layer === undefined ? {} : { currentLayer: report.layer }),
        ...(report.totalLayer === undefined
          ? {}
          : { totalLayer: report.totalLayer }),
        ...(report.estimatedRemainingSeconds === undefined
          ? {}
          : { estimatedRemainingSeconds: report.estimatedRemainingSeconds }),
        ...(report.nozzleTemp === undefined
          ? {}
          : { toolTemperatureCelsius: report.nozzleTemp }),
        ...(report.bedTemp === undefined
          ? {}
          : { bedTemperatureCelsius: report.bedTemp }),
        ...(report.fans === undefined ? {} : { fans: report.fans }),
        ...(report.light === undefined ? {} : { light: report.light }),
        ...(report.materials === undefined
          ? {}
          : { materials: report.materials }),
        observedAt: Date.now(),
      })
      if (!printer.success) {
        invalidate()
        return
      }
      const now = performance.now()
      const times: Partial<Record<keyof PrinterState, number>> = {}
      for (const key of Object.keys(printer.data) as (keyof PrinterState)[])
        if (key !== 'printerKey' && key !== 'observedAt') times[key] = now
      input.onObservation({
        printerKey: input.binding.printerKey,
        epoch,
        printer: printer.data,
        receivedAtMonoMs: now,
        fieldObservedAtMonoMs: { creality: times },
      })
      clearTimeout(timer)
      timer = setTimeout(invalidate, 5000)
    },
  })
  const abort = () => {
    clearTimeout(timer)
    void client.close()
  }
  input.signal.addEventListener('abort', abort, { once: true })
  return {
    done: client.done.finally(() => {
      clearTimeout(timer)
      input.signal.removeEventListener('abort', abort)
    }),
  }
}
