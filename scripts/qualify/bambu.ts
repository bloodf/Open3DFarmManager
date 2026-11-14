// SPDX-License-Identifier: MIT
import { createBambuTransport } from '../../packages/connector/src/bambu/transport.ts'
import { decodeBambuReport } from '../../packages/connector/src/bambu/report.ts'
import { decodeBambuVersion } from '../../packages/connector/src/bambu/version.ts'
import { listBambuFiles } from '../../packages/connector/src/bambu/files.ts'
import {
  selectBambuCamera,
  streamBambuJpegs,
} from '../../packages/connector/src/bambu/camera.ts'
import type {
  QualifyCliOptions,
  ObservedIdentity,
  ObservedTelemetry,
  ObservedCamera,
  ObservedFiles,
} from './types.ts'
import type { ParsedCredentials } from './credentials.ts'

export async function qualifyBambu(
  options: QualifyCliOptions,
  credentials: ParsedCredentials,
): Promise<{
  identity: ObservedIdentity
  telemetry: ObservedTelemetry
  camera: ObservedCamera
  files: ObservedFiles
}> {
  const host = options.host
  const port = options.port ?? 8883
  const serial = options.serial ?? credentials.serial ?? 'SYNTHETIC'
  const accessCode = credentials.accessCode ?? credentials.password ?? ''
  const timeoutMs = options.timeoutMs ?? 10_000

  const identity: ObservedIdentity = {
    vendor: 'Bambu Lab',
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
  }

  let files: ObservedFiles = {
    listable: false,
    count: 0,
    files: [],
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    // 1. MQTT Telemetry & Version collection
    const observedFields = new Set<string>()
    const sample: Record<string, unknown> = {}

    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (!settled) {
          settled = true
          resolve()
        }
      }

      // Settle if abort fires
      controller.signal.addEventListener('abort', finish, { once: true })

      try {
        const pinSha256 = options.pinSha256 ?? credentials.pinSha256
        const transport = createBambuTransport({
          host,
          port,
          serial,
          credentials: {
            username: credentials.username ?? 'bblp',
            password: accessCode || 'synthetic',
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
            try {
              const rawStr = payload.toString('utf8')
              const report = decodeBambuReport(rawStr)
              if (report.kind === 'observation') {
                if (report.state !== undefined) {
                  observedFields.add('state')
                  sample.state = report.state
                }
                if (report.progress !== undefined) {
                  observedFields.add('progress')
                  sample.progress = report.progress
                }
                if (report.toolTemperatureCelsius !== undefined) {
                  observedFields.add('toolTemperatureCelsius')
                  sample.toolTemperatureCelsius = report.toolTemperatureCelsius
                }
                if (report.bedTemperatureCelsius !== undefined) {
                  observedFields.add('bedTemperatureCelsius')
                  sample.bedTemperatureCelsius = report.bedTemperatureCelsius
                }
                if (report.currentLayer !== undefined) {
                  observedFields.add('currentLayer')
                  sample.currentLayer = report.currentLayer
                }
                if (report.totalLayer !== undefined) {
                  observedFields.add('totalLayer')
                  sample.totalLayer = report.totalLayer
                }
                if (report.filename !== undefined) {
                  observedFields.add('filename')
                  sample.filename = report.filename
                }
                if (report.materials && report.materials.length > 0) {
                  observedFields.add('materials')
                  sample.materials = report.materials
                }
              }

              // Check for version payload
              const versionInfo = decodeBambuVersion(rawStr)
              if (versionInfo) {
                if (versionInfo.model) identity.model = versionInfo.model
                if (versionInfo.firmware)
                  identity.firmware = versionInfo.firmware
              }

              if (observedFields.size > 0) {
                setTimeout(finish, 200)
              }
            } catch {}
          },
          onConnection(state) {
            if (state === 'closed' || state === 'disconnected') {
              finish()
            }
          },
        })

        // Also timeout transport wait after max 4 seconds so we don't block the rest of qualification
        setTimeout(
          () => {
            finish()
            void transport.close()
          },
          Math.min(timeoutMs, 4000),
        )
      } catch {
        finish()
      }
    })

    telemetry = {
      observed: observedFields.size > 0,
      fields: [...observedFields],
      sample: Object.keys(sample).length ? sample : undefined,
    }

    // 2. File listing via FTPS
    if (accessCode) {
      try {
        const ftpsPort = options.ftpsPort ?? 990
        const pinSha256 = options.pinSha256 ?? credentials.pinSha256
        const trust = {
          ...(credentials.caPem !== undefined
            ? { caPem: credentials.caPem }
            : {}),
          ...(pinSha256 !== undefined ? { pinSha256 } : {}),
        }
        const listedFiles = await listBambuFiles({
          host,
          port: ftpsPort,
          serial,
          accessCode,
          trust,
          signal: controller.signal,
          timeoutMs: 4000,
        })
        files = {
          listable: true,
          count: listedFiles.length,
          files: listedFiles.slice(0, 100).map((f) => ({
            name: f.name,
            size: f.size,
            modified: f.modifiedAt,
          })),
        }
      } catch (err) {
        files.reason =
          err instanceof Error ? err.message : 'FTPS listing failed'
      }
    } else {
      files.reason = 'Missing accessCode for FTPS'
    }

    // 3. Camera reachability
    if (accessCode) {
      try {
        const camModel = identity.model ?? 'P1S'
        const pinSha256 = options.pinSha256 ?? credentials.pinSha256
        const camSource = selectBambuCamera({
          model: camModel,
          host,
          accessCode,
          ...(pinSha256 !== undefined ? { pinSha256 } : {}),
        })
        camera.kind = camSource.kind
        if (camSource.kind === 'jpeg') {
          const camPort = options.cameraPort ?? camSource.port
          const camSignal = AbortSignal.timeout(3000)
          const frameStream = streamBambuJpegs({
            host,
            port: camPort,
            accessCode,
            ...(credentials.caPem !== undefined
              ? { caPem: Buffer.from(credentials.caPem) }
              : {}),
            ...(pinSha256 !== undefined ? { pinSha256 } : {}),
            signal: camSignal,
            maxReconnects: 0,
          })
          const firstFrame = await frameStream.next()
          if (firstFrame.value && Buffer.isBuffer(firstFrame.value)) {
            camera.reachable = true
            camera.detail = `Received ${firstFrame.value.length} byte JPEG frame`
          }
          await frameStream.return(undefined)
        } else if (camSource.kind === 'rtsps') {
          camera.url = camSource.url
          camera.reachable = true
          camera.detail = 'RTSPS camera endpoint configured'
        }
      } catch (err) {
        camera.detail =
          err instanceof Error ? err.message : 'Camera probe failed'
      }
    }

    return { identity, telemetry, camera, files }
  } finally {
    clearTimeout(timer)
  }
}
