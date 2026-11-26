import { mapAnycubicFirmware } from '../anycubic/firmware.ts'
import { readFileSync } from 'node:fs'
import {
  createAnycubicLanClient,
  decodeAnycubicReport,
} from '../anycubic/index.ts'
import {
  mergeAnycubicMaterials,
  type AnycubicMaterial,
} from '../anycubic/ace.ts'
import type { AnycubicAlert } from '../anycubic/alerts.ts'
import type { AnycubicCollectorConfig } from '../config/anycubic.ts'
import { readKobraClientCertMaterial } from '../config/kobra-x-cert.ts'
import { readPrivateJsonFile } from '../config/local.ts'
import { PrinterState } from '../../../farm-protocol/src/state.ts'
import type { RawPrinterObservation } from './farm-snapshot-provider.ts'

const REPORT_FRESHNESS_MS = 5000

export function createAnycubicCollection(input: {
  binding: AnycubicCollectorConfig['anycubic']['printers'][number]
  signal: AbortSignal
  onObservation: (value: RawPrinterObservation) => void
  onUnavailable: (epoch: number) => void
  transport?: typeof createAnycubicLanClient
}) {
  if (input.signal.aborted) return { done: Promise.resolve() }
  let clientCert: { certificatePem: string; keyPem: string } | undefined
  if (input.binding.clientCertFile) {
    const loaded = readKobraClientCertMaterial(input.binding.clientCertFile)
    if (!loaded.ok) {
      const now = performance.now()
      input.onObservation({
        printerKey: input.binding.printerKey,
        epoch: 1,
        printer: PrinterState.parse({
          printerKey: input.binding.printerKey,
          state: 'offline',
          statusReason: 'client-certificate-missing',
          observedAt: Date.now(),
        }),
        receivedAtMonoMs: now,
        fieldObservedAtMonoMs: { connection: now },
      })
      return { done: Promise.resolve() }
    }
    clientCert = loaded.cert
  }
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
  let estimateActive = false
  let activeJob = false
  let activeFilename: string | undefined
  // Repeated in every observation until the next job starts, so a telemetry
  // batch that misses the transition report still carries the finished job.
  let lastJob: PrinterState['lastJob']
  // An end fault stays until a new job; a pause reason until the pause ends.
  let alert: AnycubicAlert | undefined
  let epoch = 1
  let timer: ReturnType<typeof setTimeout> | undefined
  let values: Record<string, unknown> = {}
  let times: Partial<Record<keyof PrinterState, number>> = {}
  const invalidate = () => {
    firmwareObservation = undefined
    estimateActive = false
    activeJob = false
    activeFilename = undefined
    alert = undefined
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
    ...(clientCert
      ? { certPem: clientCert.certificatePem, keyPem: clientCert.keyPem }
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
      const report = decodeAnycubicReport(payload, input.binding.modelId)
      if (report.kind === 'invalid') return
      const now = performance.now()
      const firmware = mapAnycubicFirmware(JSON.parse(payload.toString('utf8')))
      if (firmware) firmwareObservation = { firmware, observedAtMonoMs: now }
      const observation: Record<string, unknown> = report
      const { kind, estimateBlocked, alert: reported, ...fields } = observation
      if (kind === 'ignored' && !firmware) return
      const state = fields.state
      if (reported) alert = reported as AnycubicAlert
      else if (
        state !== undefined &&
        (state === 'printing' ||
          (alert?.kind === 'paused') !== (state === 'paused'))
      )
        alert = undefined
      const printing = state === 'printing' || state === 'paused'
      // Set when this report stops the job; its old numbers no longer apply.
      let stopped = false
      // An explicit phase can withdraw the estimate without ending the job.
      if (state !== undefined || estimateBlocked) estimateActive = printing
      if (printing) {
        activeJob = true
        // A new job starts: the previous end is no longer the last one.
        lastJob = undefined
        const name = fields.filename
        if (typeof name === 'string' && name && name.length <= 255)
          activeFilename = name
      } else if (
        activeJob &&
        (state === 'finished' || state === 'idle' || state === 'error')
      ) {
        lastJob = {
          outcome:
            state === 'finished'
              ? 'completed'
              : state === 'error'
                ? 'failed'
                : 'cancelled',
          endedAt: Date.now(),
          ...(activeFilename ? { filename: activeFilename } : {}),
        }
        // A failure without the printer's own reason keeps its numbers: the
        // report would otherwise have nothing publishable.
        stopped =
          lastJob.outcome === 'cancelled' ||
          (lastJob.outcome === 'failed' && alert !== undefined)
        activeJob = false
        activeFilename = undefined
      }
      const filenameChanged =
        typeof fields.filename === 'string' &&
        typeof values.filename === 'string' &&
        fields.filename !== values.filename
      const estimateAt = times.estimatedRemainingSeconds
      if (
        !estimateActive ||
        filenameChanged ||
        (estimateAt !== undefined && now - estimateAt >= REPORT_FRESHNESS_MS)
      ) {
        delete values.estimatedRemainingSeconds
        delete times.estimatedRemainingSeconds
      }
      for (const [key, value] of Object.entries(fields)) {
        if (key === 'estimatedRemainingSeconds' && !estimateActive) continue
        values[key] =
          key === 'progress'
            ? Number(value) / 100
            : key === 'state' && value === 'finished'
              ? 'idle'
              : key === 'materials'
                ? mergeAnycubicMaterials(
                    values.materials as AnycubicMaterial[] | undefined,
                    value as AnycubicMaterial[],
                  )
                : value
        times[key as keyof PrinterState] = now
      }
      if (stopped) {
        for (const key of ['progress', 'currentLayer', 'totalLayer'] as const) {
          if (fields[key] !== undefined) continue
          delete values[key]
          delete times[key]
        }
      }
      const faultOnly =
        values.progress === undefined &&
        alert !== undefined &&
        (values.state === 'error' || values.state === 'paused')
      if (
        !values.state ||
        (values.state !== 'offline' &&
          !(values.state === 'idle' && lastJob) &&
          values.progress === undefined &&
          !faultOnly)
      )
        return
      const parsed = PrinterState.safeParse({
        ...values,
        ...(lastJob ? { lastJob } : {}),
        ...(alert ? { statusMessage: alert.message } : {}),
        ...(faultOnly ? { statusReason: 'printer-fault' } : {}),
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
        fieldObservedAtMonoMs: {
          anycubic: {
            ...times,
            ...(faultOnly && times.state !== undefined
              ? { statusReason: times.state }
              : {}),
          },
        },
      })
      clearTimeout(timer)
      timer = setTimeout(
        invalidate,
        Math.max(1, (times.state ?? now) + REPORT_FRESHNESS_MS - now),
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
