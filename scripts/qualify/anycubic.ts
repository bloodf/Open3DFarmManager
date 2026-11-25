// SPDX-License-Identifier: MIT
import { createAnycubicLanClient } from '../../packages/connector/src/anycubic/transport.ts'
import { decodeAnycubicReport } from '../../packages/connector/src/anycubic/report.ts'
import { createKobraLinkClient } from '../../packages/connector/src/kobralink/client.ts'
import type {
  QualifyCliOptions,
  ObservedIdentity,
  ObservedTelemetry,
  ObservedCamera,
  ObservedFiles,
} from './types.ts'
import type { ParsedCredentials } from './credentials.ts'

export async function qualifyAnycubic(
  options: QualifyCliOptions,
  credentials: ParsedCredentials,
): Promise<{
  identity: ObservedIdentity
  telemetry: ObservedTelemetry
  camera: ObservedCamera
  files: ObservedFiles
}> {
  const host = options.host
  const port = options.port ?? 9883
  const serial = options.serial ?? credentials.serial ?? 'SYNTHETIC'
  const timeoutMs = options.timeoutMs ?? 10_000

  const identity: ObservedIdentity = {
    vendor: 'Anycubic',
    model: null,
    firmware: null,
    serial,
  }

  let telemetry: ObservedTelemetry = {
    observed: false,
    fields: [],
  }

  const camera: ObservedCamera = {
    reachable: false,
    kind: null,
    detail: 'Camera qualification not supported on Anycubic LAN transport',
  }

  const files: ObservedFiles = {
    listable: false,
    count: 0,
    files: [],
    reason: 'File listing is not supported on Anycubic LAN transport',
  }

  if (options.vendor.toLowerCase() === 'kobralink') {
    return qualifyKobraLink(options, credentials)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const observedFields = new Set<string>()
    const sample: Record<string, unknown> = {}
    let trustFailure: string | undefined

    const processPayload = (payload: Buffer) => {
      try {
        const decoded = decodeAnycubicReport(payload) as Record<string, unknown>
        if (decoded.kind === 'observation') {
          for (const key of [
            'state',
            'progress',
            'toolTemperatureCelsius',
            'bedTemperatureCelsius',
            'currentLayer',
            'totalLayer',
            'filename',
          ]) {
            if (decoded[key] !== undefined) {
              observedFields.add(key)
              sample[key] = decoded[key]
            }
          }
        }

        // Also check if raw payload has print envelope or raw fields
        try {
          const raw = JSON.parse(payload.toString('utf8'))
          const target = raw?.data ?? raw?.print ?? raw
          if (target && typeof target === 'object') {
            if (
              target.gcode_state !== undefined &&
              !observedFields.has('state')
            ) {
              observedFields.add('state')
              sample.state = String(target.gcode_state).toLowerCase()
            }
            if (
              target.mc_percent !== undefined &&
              !observedFields.has('progress')
            ) {
              observedFields.add('progress')
              sample.progress = target.mc_percent
            }
            if (
              target.curr_nozzle_temp !== undefined &&
              !observedFields.has('toolTemperatureCelsius')
            ) {
              observedFields.add('toolTemperatureCelsius')
              sample.toolTemperatureCelsius = target.curr_nozzle_temp
            }
            if (
              target.curr_hotbed_temp !== undefined &&
              !observedFields.has('bedTemperatureCelsius')
            ) {
              observedFields.add('bedTemperatureCelsius')
              sample.bedTemperatureCelsius = target.curr_hotbed_temp
            }
          }
        } catch {}
      } catch {}
    }

    // Try direct TLS MQTT subscription to handle both wildcard brokers and strict single-topic simulators
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (!settled) {
          settled = true
          resolve()
        }
      }

      controller.signal.addEventListener('abort', finish, { once: true })

      const pinSha256 = options.pinSha256 ?? credentials.pinSha256
      let lanClient: ReturnType<typeof createAnycubicLanClient> | undefined
      try {
        lanClient = createAnycubicLanClient({
          host,
          port,
          serial,
          credentials: {
            username: credentials.username ?? 'bblp',
            password:
              credentials.password ?? credentials.accessCode ?? 'synthetic',
          },
          ...(credentials.caPem !== undefined
            ? { caPem: credentials.caPem }
            : {}),
          ...(pinSha256 !== undefined ? { pinSha256 } : {}),
          limits: {
            maxFrameBytes: 128 * 1024,
            connectTimeoutMs: Math.min(timeoutMs, 4000),
            maxInflight: 16,
            reconnectDelayMs: 1000,
            maxReconnects: 0,
          },
          signal: controller.signal,
          onReport(payload) {
            processPayload(payload)
            if (observedFields.size > 0) {
              setTimeout(() => {
                void lanClient?.close()
                finish()
              }, 100)
            }
          },
          onConnection() {},
          onTrustError(error) {
            trustFailure = error.message
            finish()
          },
        })
      } catch {}

      setTimeout(
        () => {
          void lanClient?.close()
          finish()
        },
        Math.min(timeoutMs, 3000),
      )
    })

    telemetry = {
      observed: observedFields.size > 0,
      fields: [...observedFields],
      sample: Object.keys(sample).length ? sample : undefined,
      ...(trustFailure !== undefined ? { reason: trustFailure } : {}),
    }

    return { identity, telemetry, camera, files }
  } finally {
    clearTimeout(timer)
  }
}

async function qualifyKobraLink(
  options: QualifyCliOptions,
  credentials: ParsedCredentials,
): Promise<{
  identity: ObservedIdentity
  telemetry: ObservedTelemetry
  camera: ObservedCamera
  files: ObservedFiles
}> {
  const origin = options.host.startsWith('http')
    ? options.host
    : `http://${options.host}:${options.port ?? 18910}`
  const identity: ObservedIdentity = {}
  let transportFailure: string | undefined

  let telemetry: ObservedTelemetry = {
    observed: false,
    fields: [],
  }

  const camera: ObservedCamera = {
    reachable: false,
    kind: null,
    detail: 'Camera not available on KobraLink bridge',
  }

  const files: ObservedFiles = {
    listable: false,
    count: 0,
    files: [],
    reason: 'File listing not available on KobraLink bridge',
  }

  try {
    if (!credentials.email || !credentials.password) {
      throw new Error(
        options.credentialFile
          ? 'KobraLink: credential file must contain email and password'
          : 'KobraLink: no credential file; provide email and password',
      )
    }
    const client = createKobraLinkClient({
      origin,
      allowedOrigins: [origin],
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
      async fetch(input, init) {
        try {
          const response = await fetch(input, init)
          if (!response.ok) transportFailure = `HTTP ${response.status}`
          return response
        } catch (error) {
          // Keep network codes, never URLs, response bodies or credentials.
          const cause = error instanceof Error ? error.cause : undefined
          if (
            cause &&
            typeof cause === 'object' &&
            'code' in cause &&
            typeof cause.code === 'string' &&
            /^[A-Z_]+$/.test(cause.code)
          ) {
            transportFailure = cause.code
          }
          throw error
        }
      },
    })
    await client.authenticate({
      ownership: 'fresh_owned',
      mode: 'signin',
      name: credentials.name ?? 'Operator',
      email: credentials.email,
      password: credentials.password,
    })

    const printers = await client.listPrinterIdentities()
    if (printers.length > 0) {
      const printer = printers[0]!
      identity.model = printer.model
      identity.firmware = printer.firmware
      identity.serial = printer.deviceId

      const obs = await client.getPrinterObservation({
        id: printer.id,
        deviceId: printer.deviceId,
      })

      const fields: string[] = []
      const sample: Record<string, unknown> = {}

      if (obs.printState) {
        fields.push('printState')
        sample.printState = obs.printState
      }
      if (obs.progress !== null) {
        fields.push('progress')
        sample.progress = obs.progress
      }
      if (obs.availability) {
        fields.push('availability')
        sample.availability = obs.availability
      }

      telemetry = {
        observed: fields.length > 0,
        fields,
        sample: Object.keys(sample).length ? sample : undefined,
      }
    }
  } catch (error) {
    telemetry.reason = transportFailure
      ? `KobraLink: ${transportFailure}`
      : error instanceof Error
        ? error.message
        : 'KobraLink: unknown failure'
  }

  return { identity, telemetry, camera, files }
}
