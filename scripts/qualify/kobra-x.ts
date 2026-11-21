// SPDX-License-Identifier: MIT
import { connect as mqttConnect } from 'mqtt'
import {
  readKobraXInfo,
  recoverKobraXCredentials,
} from '../../packages/connector/src/kobra-x/discovery.ts'
import { decodeAnycubicReport } from '../../packages/connector/src/anycubic/report.ts'
import { resolveKobraClientIdentity } from '../../packages/connector/src/config/kobra-x-cert.ts'
import type {
  QualifyCliOptions,
  ObservedIdentity,
  ObservedTelemetry,
  ObservedCamera,
  ObservedFiles,
  ObservedFileEntry,
} from './types.ts'
import type { ParsedCredentials } from './credentials.ts'

/**
 * Read-only qualification for the Anycubic Kobra X over its native LAN path.
 *
 * It reads `GET /info` (HTTP 18910) for identity, recovers the MQTT credentials
 * in memory through `POST /ctrl`, and subscribes to the printer's public report
 * topic over mutual TLS (MQTTS 9883) with the resolved Anycubic Slicer client
 * identity. To make an idle printer emit reports it publishes only read
 * requests — `query` for info/status/tempature and `getInfo`/`listLocal` — and
 * never a start, pause, resume, cancel, gcode, temperature, motion or upload
 * command. No credential is written or logged.
 *
 * The report topic is `anycubic/anycubicCloud/v1/printer/public/<modeId>/<deviceId>/`,
 * confirmed by observation against a real Kobra X; queries are published to the
 * `.../slicer/printer/<modeId>/<deviceId>/<type>` request topic.
 */
export async function qualifyKobraX(
  options: QualifyCliOptions,
  credentials: ParsedCredentials,
): Promise<{
  identity: ObservedIdentity
  telemetry: ObservedTelemetry
  camera: ObservedCamera
  files: ObservedFiles
}> {
  const host = options.host
  const httpPort = options.httpPort ?? 18910
  const mqttPort = options.port ?? 9883
  const timeoutMs = options.timeoutMs ?? 10_000
  const observeMs = Math.max(2000, Math.min(timeoutMs, 9000))

  const identity: ObservedIdentity = {
    vendor: 'Anycubic',
    model: 'Kobra X',
    firmware: null,
  }
  let telemetry: ObservedTelemetry = { observed: false, fields: [] }
  const camera: ObservedCamera = {
    reachable: false,
    kind: null,
    url: null,
  }
  let files: ObservedFiles = { listable: false, count: 0, files: [] }

  // 1. Identity and credential recovery (read-only HTTP on 18910).
  const info = await readKobraXInfo(host, httpPort)
  identity.hostname = info.name
  const recovered = await recoverKobraXCredentials(info, httpPort)
  const { modeId, deviceId, username, password } = recovered
  identity.serial = deviceId

  // 2. Resolve the client identity: explicit file override, else local
  //    Anycubic Slicer Next install, else the bundled Anycubic default.
  const certFile = credentials.certFile ?? options.certFile
  const keyFile = credentials.keyFile ?? options.keyFile
  const clientIdentity = await resolveKobraClientIdentity({
    ...(certFile !== undefined ? { certFile } : {}),
    ...(keyFile !== undefined ? { keyFile } : {}),
  })

  const reportBase = `anycubic/anycubicCloud/v1/printer/public/${modeId}/${deviceId}/`
  const requestBase = `anycubic/anycubicCloud/v1/slicer/printer/${modeId}/${deviceId}/`

  const client = mqttConnect({
    host,
    port: mqttPort,
    protocol: 'mqtts',
    cert: clientIdentity.certPem,
    key: clientIdentity.keyPem,
    rejectUnauthorized: false,
    username,
    password,
    protocolVersion: 4,
    clean: true,
    keepalive: 60,
    resubscribe: false,
    reconnectPeriod: 0,
    connectTimeout: Math.min(timeoutMs, 5000),
  })

  const observedFields = new Set<string>()
  const sample: Record<string, unknown> = {}
  const fileEntries: ObservedFileEntry[] = []
  const telemetryKeys = [
    'state',
    'progress',
    'toolTemperatureCelsius',
    'bedTemperatureCelsius',
    'currentLayer',
    'totalLayer',
    'filename',
    'materials',
    'fans',
  ] as const

  const onMessage = (topic: string, payload: Buffer) => {
    if (!topic.startsWith(reportBase) || payload.length > 65536) return
    const [type, suffix] = topic.slice(reportBase.length).split('/')
    if (suffix !== 'report') return

    // Camera URL (read-only reachability candidate) and firmware from raw data.
    try {
      const envelope = JSON.parse(payload.toString('utf8')) as Record<
        string,
        unknown
      >
      const data = (
        envelope.data && typeof envelope.data === 'object'
          ? envelope.data
          : envelope
      ) as Record<string, unknown>
      if (
        typeof data.version === 'string' &&
        data.version &&
        data.version.length <= 64 &&
        !identity.firmware
      )
        identity.firmware = data.version
      const urls = (data.urls ?? {}) as Record<string, unknown>
      const rtsp = urls.rtspUrl
      if (!camera.url && typeof rtsp === 'string') {
        try {
          const parsed = new URL(rtsp)
          if (
            (parsed.protocol === 'http:' || parsed.protocol === 'rtsp:') &&
            parsed.hostname === host &&
            !parsed.username &&
            !parsed.password
          ) {
            camera.url = parsed.href
            camera.kind = parsed.protocol === 'rtsp:' ? 'rtsps' : 'mjpeg'
          }
        } catch {
          // Ignore malformed camera URLs.
        }
      }
      // File list from a read-only `file`/`listLocal` report.
      if (type === 'file' && Array.isArray(data.filelist)) {
        for (const raw of data.filelist) {
          if (fileEntries.length >= 100) break
          const entry = (raw ?? {}) as Record<string, unknown>
          const name = entry.name ?? entry.filename
          if (typeof name !== 'string' || !name) continue
          const size = entry.size
          fileEntries.push({
            name: name.slice(0, 255),
            ...(typeof size === 'number' && Number.isFinite(size) && size >= 0
              ? { size }
              : {}),
          })
        }
      }
    } catch {
      // Ignore malformed reports.
    }

    // Telemetry fields via the shared Anycubic decoder.
    const decoded = decodeAnycubicReport(payload) as Record<string, unknown>
    if (decoded.kind === 'observation') {
      for (const key of telemetryKeys) {
        if (decoded[key] !== undefined) {
          observedFields.add(key)
          sample[key] = decoded[key]
        }
      }
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Kobra X MQTT connection timed out')),
        Math.min(timeoutMs, 5000),
      )
      client.on('message', onMessage)
      client.once('error', (error) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
      client.once('connect', () => {
        clearTimeout(timer)
        client.subscribe(`${reportBase}#`, { qos: 0 }, (error) => {
          if (error) return reject(error)
          // Read-only requests that prompt the printer to emit reports.
          const requests: [string, string][] = [
            ['info', 'query'],
            ['status', 'query'],
            ['tempature', 'query'],
            ['multiColorBox', 'getInfo'],
            ['file', 'listLocal'],
          ]
          for (const [type, action] of requests) {
            client.publish(
              `${requestBase}${type}`,
              JSON.stringify({
                type,
                action,
                msgid: randomMsgId(),
                data: {},
              }),
            )
          }
          resolve()
        })
      })
    })

    await new Promise<void>((resolve) => setTimeout(resolve, observeMs))
  } finally {
    await new Promise<void>((resolve) => client.end(true, {}, () => resolve()))
  }

  telemetry = {
    observed: observedFields.size > 0,
    fields: [...observedFields],
    ...(Object.keys(sample).length ? { sample } : {}),
  }

  if (camera.url) {
    camera.reachable = await probeCameraUrl(
      camera.url,
      Math.min(timeoutMs, 3000),
    )
    camera.detail = camera.reachable
      ? 'Camera URL reachable'
      : 'Camera URL declared but not reachable'
  } else {
    camera.detail = 'No camera URL reported'
  }

  if (fileEntries.length > 0) {
    files = { listable: true, count: fileEntries.length, files: fileEntries }
  } else {
    files = {
      listable: false,
      count: 0,
      files: [],
      reason: 'No file listing reported over the native LAN path',
    }
  }

  return { identity, telemetry, camera, files }
}

function randomMsgId(): string {
  return Math.random().toString(16).slice(2) + Date.now().toString(16)
}

async function probeCameraUrl(
  url: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!url.startsWith('http:')) return false
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    })
    // Any HTTP answer proves the stream endpoint is reachable; read nothing.
    void res.body?.cancel().catch(() => {})
    return res.ok
  } catch {
    return false
  }
}
