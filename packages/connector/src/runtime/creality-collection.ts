import { createCrealityTelemetryClient } from '../creality/index.ts'
import type { CrealityCollectorConfig } from '../config/creality.ts'
import type { RawPrinterObservation } from './farm-snapshot-provider.ts'
import { PrinterState } from '../../../farm-protocol/src/state.ts'

/** Partial frames retain only their own evidence within the current epoch. */
export function createCrealityCollection(input: {
  binding: CrealityCollectorConfig['creality']['printers'][number]
  signal: AbortSignal
  onObservation: (value: RawPrinterObservation) => void
  onUnavailable: (epoch: number) => void
}) {
  let epoch = 1
  let timer: ReturnType<typeof setTimeout> | undefined
  let values: Partial<PrinterState> = {}
  let stamps: Partial<Record<keyof PrinterState, number>> = {}
  const invalidate = () => {
    values = {}
    stamps = {}
    clearTimeout(timer)
    if (!input.signal.aborted) input.onUnavailable(epoch++)
  }
  if (input.signal.aborted) return { done: Promise.resolve() }
  const client = createCrealityTelemetryClient({
    ...input.binding,
    onDisconnect: invalidate,
    onTelemetry(report) {
      if (input.signal.aborted) return
      const now = performance.now()
      const delta = {
        printerKey: input.binding.printerKey,
        ...(report.state === undefined ? {} : { state: report.state }),
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
      }
      for (const key of Object.keys(delta) as (keyof typeof delta)[]) {
        if (key === 'printerKey') continue
        Object.assign(values, { [key]: delta[key] })
        stamps[key] = now
      }
      if (!values.state || values.progress === undefined) return
      const printer = PrinterState.safeParse({
        ...values,
        printerKey: input.binding.printerKey,
        observedAt: Date.now(),
      })
      if (!printer.success) {
        invalidate()
        return
      }
      input.onObservation({
        printerKey: input.binding.printerKey,
        epoch,
        printer: printer.data,
        receivedAtMonoMs: now,
        fieldObservedAtMonoMs: { creality: { ...stamps } },
      })
      clearTimeout(timer)
      timer = setTimeout(
        invalidate,
        Math.max(1, (stamps.state ?? now) + 5000 - now),
      )
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
