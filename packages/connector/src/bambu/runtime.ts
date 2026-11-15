import { mapBambuFirmware } from './firmware.ts'
import { decodeBambuVersion } from './version.ts'
import type { RawPrinterObservation } from '../runtime/farm-snapshot-provider.ts'
import { readFileSync } from 'node:fs'
import { PrinterState } from '@open3dfarmmanager/farm-protocol'
import { parseBambuBinding, type BambuBinding } from './configuration.ts'
import { readBambuCredentials } from './credentials.ts'
import { decodeBambuReport } from './report.ts'
import {
  createBambuTransport,
  type BambuTransportOptions,
} from './transport.ts'

type Fields = Omit<PrinterState, 'printerKey' | 'observedAt'>
export type BambuRuntimeEvent =
  | {
      kind: 'snapshot'
      printer: PrinterState
      firmwareObservation?: RawPrinterObservation['firmwareObservation']
      source: {
        serial: string
        epoch: number
        fieldObservedAtMonoMs: Readonly<Partial<Record<keyof Fields, number>>>
      }
    }
  | {
      kind: 'unavailable'
      printerKey: string
      reason:
        | 'connecting'
        | 'disconnected'
        | 'stale'
        | 'invalid-response'
        | 'unavailable'
    }

export function createBambuRuntimeSubscription(input: {
  binding: BambuBinding
  signal: AbortSignal
  onEvent: (event: BambuRuntimeEvent) => void
  staleAfterMs?: number
  transport?: (
    options: BambuTransportOptions,
  ) => Pick<ReturnType<typeof createBambuTransport>, 'done' | 'close'>
}) {
  const binding = parseBambuBinding({
    ...input.binding,
    allowedEndpoints: [{ host: input.binding.host, port: input.binding.port }],
  })
  const ttl = input.staleAfterMs ?? 30_000
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 300_000)
    throw Error('Invalid Bambu expiry')
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  let firmwareObservation: RawPrinterObservation['firmwareObservation']
  let version: unknown
  let upgradeReport: unknown
  let epoch = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let fields: Partial<Fields> = {}
  let times: Partial<Record<keyof Fields, number>> = {}
  let connected = false
  let activeJob = false
  const clear = () => {
    firmwareObservation = undefined
    version = undefined
    upgradeReport = undefined
    fields = {}
    times = {}
    activeJob = false
    clearTimeout(timer)
  }
  const unavailable = (
    reason: Extract<BambuRuntimeEvent, { kind: 'unavailable' }>['reason'],
  ) => {
    if (!signal.aborted)
      input.onEvent({
        kind: 'unavailable',
        printerKey: binding.printerKey,
        reason,
      })
  }
  function publish() {
    clearTimeout(timer)
    const now = performance.now()
    for (const key of Object.keys(times) as (keyof Fields)[]) {
      const stamp = times[key]
      if (stamp !== undefined && now - stamp >= ttl) {
        delete times[key]
        delete fields[key]
      }
    }
    const parsed = PrinterState.safeParse({
      ...fields,
      controls: binding.control ? ['pause', 'resume', 'cancel'] : [],
      printerKey: binding.printerKey,
      observedAt: Date.now(),
    })
    if (parsed.success)
      input.onEvent({
        kind: 'snapshot',
        ...(firmwareObservation ? { firmwareObservation } : {}),
        printer: parsed.data,
        source: {
          serial: binding.serial,
          epoch,
          fieldObservedAtMonoMs: Object.freeze({ ...times }),
        },
      })
    else unavailable('stale')
    const stamps = Object.values(times)
    if (stamps.length)
      timer = setTimeout(publish, Math.max(1, Math.min(...stamps) + ttl - now))
  }
  const done = (async () => {
    let transport:
      | Pick<ReturnType<typeof createBambuTransport>, 'done' | 'close'>
      | undefined
    try {
      if (signal.aborted) return
      unavailable('connecting')
      const credentials = readBambuCredentials(binding)
      const options: BambuTransportOptions = {
        host: binding.host,
        port: binding.port,
        serial: binding.serial,
        ...(binding.pinSha256 !== undefined
          ? { pinSha256: binding.pinSha256 }
          : {}),
        credentials,
        signal,
        ...(binding.caFile
          ? { caPem: readFileSync(binding.caFile, 'utf8') }
          : {}),
        limits: {
          maxFrameBytes: 131072,
          connectTimeoutMs: 10000,
          maxInflight: 16,
          reconnectDelayMs: 1000,
          maxReconnects: 5,
        },
        onConnection(state) {
          if (signal.aborted) return
          clear()
          connected = state === 'connected'
          if (connected) {
            epoch++
            unavailable('connecting')
          } else
            unavailable(
              state === 'disconnected' ? 'disconnected' : 'unavailable',
            )
        },
        onReport(payload) {
          if (signal.aborted || !connected) return
          let rawFirmware: unknown
          try {
            rawFirmware = JSON.parse(payload.toString('utf8'))
          } catch {
            clear()
            unavailable('invalid-response')
            return
          }
          if (decodeBambuVersion(rawFirmware)) version = rawFirmware
          if (
            rawFirmware &&
            typeof rawFirmware === 'object' &&
            'print' in rawFirmware &&
            rawFirmware.print &&
            typeof rawFirmware.print === 'object' &&
            'upgrade_state' in rawFirmware.print
          )
            upgradeReport = rawFirmware
          const firmware = mapBambuFirmware(version, upgradeReport)
          if (
            firmware &&
            (decodeBambuVersion(rawFirmware) || upgradeReport === rawFirmware)
          )
            firmwareObservation = {
              firmware,
              observedAtMonoMs: performance.now(),
            }
          const result = decodeBambuReport(payload.toString('utf8'))
          if (result.kind === 'ignored' && firmware) {
            publish()
            return
          }
          if (result.kind === 'ignored') return
          if (result.kind === 'invalid') {
            clear()
            unavailable('invalid-response')
            return
          }
          const { kind: _, ...decoded } = result
          const observed: Partial<Fields> = decoded
          // Unknown explicit states must not retain a previously recognized state.
          const raw: unknown = JSON.parse(payload.toString('utf8'))
          if (
            raw &&
            typeof raw === 'object' &&
            'print' in raw &&
            raw.print &&
            typeof raw.print === 'object' &&
            'gcode_state' in raw.print &&
            observed.state === undefined
          ) {
            delete fields.state
            delete times.state
          }
          const now = performance.now()
          delete fields.lastJob
          delete times.lastJob
          const print = (raw as { print?: { gcode_state?: unknown } })?.print
          const state = print?.gcode_state
          if (state === 'RUNNING' || state === 'PREPARE' || state === 'PAUSE')
            activeJob = true
          else if (
            activeJob &&
            (state === 'FINISH' || state === 'FAILED' || state === 'IDLE')
          ) {
            observed.lastJob = {
              outcome:
                state === 'FINISH'
                  ? 'completed'
                  : state === 'FAILED'
                    ? 'failed'
                    : 'cancelled',
              endedAt: Date.now(),
            }
            activeJob = false
          }
          for (const key of Object.keys(observed) as (keyof Fields)[])
            if (key !== 'lastJob') times[key] = now
          if (observed.materials) {
            const merged = new Map(
              (fields.materials ?? []).map((item) => [item.slot, item]),
            )
            for (const item of observed.materials) {
              const previous = merged.get(item.slot)
              merged.set(item.slot, { ...previous, ...item })
            }
            observed.materials = [...merged.values()]
          }
          if (observed.fans)
            observed.fans = { ...fields.fans, ...observed.fans }
          if (observed.light)
            observed.light = { ...fields.light, ...observed.light }
          fields = { ...fields, ...observed }
          publish()
        },
      }
      transport = (input.transport ?? createBambuTransport)(options)
      await transport.done
    } catch {
      unavailable('unavailable')
    } finally {
      controller.abort()
      clear()
      await transport?.close()
    }
  })()
  return {
    done,
    close: () => {
      controller.abort()
      clear()
    },
  }
}
