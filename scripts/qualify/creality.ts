// SPDX-License-Identifier: MIT
import {
  createCrealityTelemetryClient,
  decodeCrealityStatus,
} from '../../packages/connector/src/creality/index.ts'
import {
  selectCrealityCamera,
  streamCrealityJpegs,
} from '../../packages/connector/src/creality/camera.ts'
import type {
  QualifyCliOptions,
  ObservedIdentity,
  ObservedTelemetry,
  ObservedCamera,
  ObservedFiles,
} from './types.ts'
import type { ParsedCredentials } from './credentials.ts'

export async function qualifyCreality(
  options: QualifyCliOptions,
  _credentials: ParsedCredentials,
): Promise<{
  identity: ObservedIdentity
  telemetry: ObservedTelemetry
  camera: ObservedCamera
  files: ObservedFiles
}> {
  const host = options.host
  const port = options.port ?? 9999
  const timeoutMs = options.timeoutMs ?? 10_000

  const identity: ObservedIdentity = {
    vendor: 'Creality',
    model: null,
    firmware: null,
    hostname: null,
  }

  let telemetry: ObservedTelemetry = {
    observed: false,
    fields: [],
  }

  const camera: ObservedCamera = {
    reachable: false,
    kind: null,
  }

  const files: ObservedFiles = {
    listable: false,
    count: 0,
    files: [],
    reason: 'File listing is not supported on native Creality stock interface',
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    // 1. WebSocket Telemetry
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

      controller.signal.addEventListener('abort', finish, { once: true })

      try {
        const client = createCrealityTelemetryClient({
          host,
          port,
          reconnectDelayMs: 100,
          onTelemetry(report) {
            if (report.state !== undefined) {
              observedFields.add('state')
              sample.state = report.state
            }
            if (report.progress !== undefined) {
              observedFields.add('progress')
              sample.progress = report.progress
            }
            if (report.nozzleTemp !== undefined) {
              observedFields.add('nozzleTemp')
              sample.nozzleTemp = report.nozzleTemp
            }
            if (report.nozzleTarget !== undefined) {
              observedFields.add('nozzleTarget')
              sample.nozzleTarget = report.nozzleTarget
            }
            if (report.bedTemp !== undefined) {
              observedFields.add('bedTemp')
              sample.bedTemp = report.bedTemp
            }
            if (report.bedTarget !== undefined) {
              observedFields.add('bedTarget')
              sample.bedTarget = report.bedTarget
            }
            if (report.layer !== undefined) {
              observedFields.add('layer')
              sample.layer = report.layer
            }
            if (report.totalLayer !== undefined) {
              observedFields.add('totalLayer')
              sample.totalLayer = report.totalLayer
            }
            if (report.filename !== undefined) {
              observedFields.add('filename')
              sample.filename = report.filename
            }
            if (report.model) {
              identity.model = report.model
            }
            if (report.hostname) {
              identity.hostname = report.hostname
            }
            if (report.firmwareVersion) {
              identity.firmware = report.firmwareVersion
            }

            if (observedFields.size > 0) {
              setTimeout(() => {
                void client.close()
                finish()
              }, 150)
            }
          },
        })

        setTimeout(
          () => {
            void client.close()
            finish()
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

    // 2. Camera reachability check
    const camPort = options.cameraPort ?? 8080
    try {
      selectCrealityCamera({ host, port: camPort })
      camera.kind = 'mjpeg'
      const camSignal = AbortSignal.timeout(3000)
      const frames = streamCrealityJpegs({
        host,
        port: camPort,
        signal: camSignal,
        maxReconnects: 0,
      })
      const first = await frames.next()
      if (first.value && Buffer.isBuffer(first.value)) {
        camera.reachable = true
        camera.detail = `Received ${first.value.length} byte MJPEG frame`
      }
      await frames.return(undefined)
    } catch {
      // Try direct HTTP snapshot probe
      try {
        const snapRes = await fetch(
          `http://${host}:${camPort}/?action=snapshot`,
          {
            signal: AbortSignal.timeout(2000),
            redirect: 'error',
          },
        )
        if (
          snapRes.ok &&
          snapRes.headers.get('content-type')?.includes('image/jpeg')
        ) {
          camera.reachable = true
          camera.kind = 'mjpeg'
          camera.detail = 'Direct MJPEG snapshot probe responded'
        }
      } catch (err) {
        camera.detail =
          err instanceof Error ? err.message : 'Camera unreachable'
      }
    }

    return { identity, telemetry, camera, files }
  } finally {
    clearTimeout(timer)
  }
}
