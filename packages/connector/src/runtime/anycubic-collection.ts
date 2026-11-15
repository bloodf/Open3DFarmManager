import { mapAnycubicFirmware } from '../anycubic/firmware.ts'
import { readFileSync } from 'node:fs'
import {
  createAnycubicLanClient,
  decodeAnycubicReport,
} from '../anycubic/index.ts'
import type { AnycubicCollectorConfig } from '../config/anycubic.ts'
import { readPrivateJsonFile } from '../config/local.ts'
import { PrinterState } from '../../../farm-protocol/src/state.ts'
import type { RawPrinterObservation } from './farm-snapshot-provider.ts'

export function createAnycubicCollection(input: {
  binding: AnycubicCollectorConfig['anycubic']['printers'][number]
  signal: AbortSignal
  onObservation: (value: RawPrinterObservation) => void
  onUnavailable: (epoch: number) => void
  transport?: typeof createAnycubicLanClient
}) {
  if (input.signal.aborted) return { done: Promise.resolve() }
  let password: unknown
  try {
    password = readPrivateJsonFile(input.binding.passwordFile, {
      maxBytes: 4096,
    })
  } catch {
    throw Error('Invalid Anycubic credential file')
  }
  if (typeof password !== 'string' || !password || password.length > 2048)
    throw Error('Invalid Anycubic credential file')
  let firmwareObservation: RawPrinterObservation['firmwareObservation']
  let epoch = 1
  let timer: ReturnType<typeof setTimeout> | undefined
  let values: Record<string, unknown> = {}
  let times: Partial<Record<keyof PrinterState, number>> = {}
  const invalidate = () => {
    firmwareObservation = undefined
    clearTimeout(timer)
    values = {}
    times = {}
    if (!input.signal.aborted) input.onUnavailable(epoch++)
  }
  const client = (input.transport ?? createAnycubicLanClient)({
    host: input.binding.host,
    port: input.binding.port,
    serial: input.binding.modelId + '/' + input.binding.deviceId,
    ...(input.binding.caFile
      ? { caPem: readFileSync(input.binding.caFile, 'utf8') }
      : {}),
    ...(input.binding.pinSha256 ? { pinSha256: input.binding.pinSha256 } : {}),
    credentials: { username: input.binding.username, password },
    limits: {
      maxFrameBytes: 65536,
      connectTimeoutMs: 5000,
      maxInflight: 16,
      reconnectDelayMs: 1000,
      maxReconnects: 100,
    },
    signal: input.signal,
    onConnection(state) {
      if (state !== 'connected') invalidate()
    },
    onReport(payload) {
      const report = decodeAnycubicReport(payload)
      if (report.kind === 'invalid') return
      const now = performance.now()
      const firmware = mapAnycubicFirmware(JSON.parse(payload.toString('utf8')))
      if (firmware) firmwareObservation = { firmware, observedAtMonoMs: now }
      if (report.kind === 'ignored' && !firmware) return
      for (const [key, value] of Object.entries(
        report as Record<string, unknown>,
      )) {
        if (key === 'kind') continue
        values[key] =
          key === 'progress'
            ? Number(value) / 100
            : key === 'state' && value === 'finished'
              ? 'idle'
              : value
        times[key as keyof PrinterState] = now
      }
      if (!values.state) return
      const parsed = PrinterState.safeParse({
        ...values,
        printerKey: input.binding.printerKey,
        observedAt: Date.now(),
      })
      if (!parsed.success) {
        invalidate()
        return
      }
      input.onObservation({
        printerKey: input.binding.printerKey,
        epoch,
        ...(firmwareObservation ? { firmwareObservation } : {}),
        printer: parsed.data,
        receivedAtMonoMs: now,
        fieldObservedAtMonoMs: { anycubic: { ...times } },
      })
      clearTimeout(timer)
      timer = setTimeout(
        invalidate,
        Math.max(1, (times.state ?? now) + 5000 - now),
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
