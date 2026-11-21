// SPDX-License-Identifier: MIT
import { discoverMoonraker } from '../../packages/connector/src/moonraker/discovery.ts'
import { listMoonrakerFiles } from '../../packages/connector/src/moonraker/files.ts'
import { createMoonrakerSocket } from '../../packages/connector/src/moonraker/socket.ts'
import { decodeMoonrakerFrame } from '../../packages/connector/src/moonraker/frame.ts'
import type {
  QualifyCliOptions,
  ObservedIdentity,
  ObservedTelemetry,
  ObservedCamera,
  ObservedFiles,
} from './types.ts'
import type { ParsedCredentials } from './credentials.ts'

export async function qualifyMoonraker(
  options: QualifyCliOptions,
  _credentials: ParsedCredentials,
): Promise<{
  identity: ObservedIdentity
  telemetry: ObservedTelemetry
  camera: ObservedCamera
  files: ObservedFiles
}> {
  const port = options.port ?? 7125
  const host = options.host
  const origin = `http://${host}:${port}`
  const timeoutMs = options.timeoutMs ?? 10_000
  const camPort = options.cameraPort ?? 8080
  const webcamOrigin =
    options.webcamOrigin ??
    (options.cameraPort ? `http://${host}:${camPort}` : origin)

  const limits = {
    maxMessageBytes: 256 * 1024,
    connectTimeoutMs: Math.min(timeoutMs, 5000),
    requestTimeoutMs: Math.min(timeoutMs, 5000),
    staleAfterMs: 30_000,
    reconnectMinMs: 1000,
    reconnectMaxMs: 30_000,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const identity: ObservedIdentity = {
    vendor: 'Klipper',
    model: 'Moonraker Generic',
    firmware: null,
  }

  let telemetry: ObservedTelemetry = {
    observed: false,
    fields: [],
  }

  const camera: ObservedCamera = {
    reachable: false,
    kind: null,
    url: null,
  }

  let files: ObservedFiles = {
    listable: false,
    count: 0,
    files: [],
  }

  try {
    // 1. Run Moonraker discovery
    const discovery = await discoverMoonraker({
      origin,
      ...(options.credentialFile !== undefined
        ? { apiKeyFile: options.credentialFile }
        : {}),
      webcamOrigin,
      limits,
      signal: controller.signal,
      client: {
        name: 'Open3DFarmManager Qualify',
        version: '1.0.0',
        url: 'https://github.com/bloodf/Open3dFarmManager',
      },
    })

    const fields: string[] = []
    const sample: Record<string, unknown> = {}

    if (discovery.server.klippyConnected) {
      fields.push('klippyConnected')
      sample.klippyConnected = discovery.server.klippyConnected
    }
    if (discovery.server.klippyState) {
      fields.push('klippyState')
      sample.klippyState = discovery.server.klippyState
    }
    if (discovery.server.moonrakerVersion) {
      identity.firmware = `Moonraker ${discovery.server.moonrakerVersion}`
      sample.moonrakerVersion = discovery.server.moonrakerVersion
    }

    if (discovery.tools.activeObject) {
      fields.push('activeTool')
      sample.activeTool = discovery.tools.activeObject
    }

    if (discovery.tools.tools.length > 0) {
      fields.push('toolTemperatures')
      sample.tools = discovery.tools.tools
    }

    telemetry = {
      observed: fields.length > 0,
      fields,
      sample,
    }

    // 2. Camera reachability check
    if (discovery.webcams.length > 0) {
      const primary = discovery.webcams[0]
      camera.kind = 'webcam'
      let checkUrl = primary?.snapshotUrl ?? primary?.streamUrl
      if (!checkUrl && (primary?.snapshotPath || primary?.streamPath)) {
        const path = primary.snapshotPath ?? primary.streamPath!
        checkUrl = new URL(path, webcamOrigin).href
      }
      if (checkUrl) {
        camera.url = checkUrl
        try {
          const camRes = await fetch(checkUrl, {
            signal: AbortSignal.timeout(3000),
            redirect: 'error',
          })
          if (camRes.ok) {
            camera.reachable = true
            camera.detail =
              `HTTP ${camRes.status} ${camRes.headers.get('content-type') ?? ''}`.trim()
          }
        } catch {
          camera.detail =
            'Camera declared in Moonraker webcams but probe failed'
        }
      } else {
        camera.detail = `Declared webcam: ${primary?.name ?? 'unknown'}`
      }
    }

    // Fallback: direct snapshot check if not yet reachable
    if (!camera.reachable) {
      const camUrl = `http://${host}:${camPort}/?action=snapshot`
      try {
        const directCam = await fetch(camUrl, {
          signal: AbortSignal.timeout(2000),
          redirect: 'error',
        })
        if (
          directCam.ok &&
          directCam.headers.get('content-type')?.includes('image/jpeg')
        ) {
          camera.reachable = true
          camera.kind = 'mjpeg'
          camera.url = camUrl
          camera.detail = 'Direct MJPEG snapshot responded'
        }
      } catch {}
    }

    // 3. File listing via Moonraker WebSocket client
    try {
      const filesResult = await fetchMoonrakerFiles(
        origin,
        limits,
        controller.signal,
      )
      if (Array.isArray(filesResult)) {
        files = {
          listable: true,
          count: filesResult.length,
          files: filesResult.slice(0, 100).map((f) => ({
            name: f.name,
            size: f.size,
            modified: f.modified,
            ...(f.estimatedTime !== undefined
              ? { estimatedTime: f.estimatedTime }
              : {}),
          })),
        }
      }
    } catch {
      // Fallback: listable = false
    }

    return { identity, telemetry, camera, files }
  } finally {
    clearTimeout(timer)
  }
}

async function fetchMoonrakerFiles(
  origin: string,
  limits: {
    maxMessageBytes: number
    connectTimeoutMs: number
    requestTimeoutMs: number
  },
  _signal: AbortSignal,
) {
  const socket = createMoonrakerSocket(origin, limits as any)
  // Metadata is requested for up to 100 files at once, one listener each.
  socket.setMaxListeners(0)
  try {
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.off('error', reject)
        resolve()
      }
      socket.once('open', onOpen)
      socket.once('error', reject)
    })

    let id = 100
    const client = {
      async request(method: string, params: object): Promise<unknown> {
        const reqId = ++id
        return new Promise<unknown>((resolve, reject) => {
          const timeout = setTimeout(() => {
            socket.off('message', onMessage)
            reject(new Error('RPC timeout'))
          }, limits.requestTimeoutMs)

          function onMessage(data: any, isBinary: boolean) {
            try {
              const decoded = decodeMoonrakerFrame(
                data,
                isBinary,
                limits.maxMessageBytes,
              )
              if (decoded && typeof decoded === 'object' && 'id' in decoded) {
                const res = decoded as {
                  id: number
                  result?: unknown
                  error?: unknown
                }
                if (res.id === reqId) {
                  clearTimeout(timeout)
                  socket.off('message', onMessage)
                  if (res.error)
                    reject(new Error('RPC error: ' + JSON.stringify(res.error)))
                  else resolve(res.result)
                }
              }
            } catch (err) {
              clearTimeout(timeout)
              socket.off('message', onMessage)
              reject(err)
            }
          }

          socket.on('message', onMessage)
          socket.send(
            JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params }),
          )
        })
      },
    }

    return await listMoonrakerFiles(client, { limit: 100 })
  } finally {
    socket.terminate()
  }
}
