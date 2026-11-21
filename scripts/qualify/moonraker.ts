// SPDX-License-Identifier: MIT
import { validateMoonrakerInput } from '../../packages/connector/src/moonraker/client.ts'
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
    model: options.model ?? 'Moonraker Generic',
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

    // Read raw webcam locations and optional identity data without changing connector policy.
    let extra: Awaited<ReturnType<typeof fetchMoonrakerFiles>> | undefined
    try {
      const checked = validateMoonrakerInput({
        assignment: {
          printerKey: 'qualification',
          origin,
          apiKeyFile: options.credentialFile,
        },
        allowedOrigins: [origin],
        limits,
      })
      extra = await fetchMoonrakerFiles(
        origin,
        checked.limits,
        controller.signal,
      )
      files = extra.files
    } catch {}

    const info = extra?.printerInfo
    const system = extra?.systemInfo
    const hostname =
      typeof info?.hostname === 'string'
        ? info.hostname
        : typeof system?.hostname === 'string'
          ? system.hostname
          : null
    if (hostname) identity.hostname = hostname
    const reportedModel =
      typeof info?.model === 'string' ? info.model.trim() : ''
    const knownHostname = hostname?.toLowerCase() ?? ''
    const detectedModel =
      reportedModel ||
      (/^(?:sovol[-_])?sv0?8(?:[-_]|$)/.test(knownHostname)
        ? 'Sovol SV08'
        : /^(?:creality[-_])?k1(?:[-_]|$)/.test(knownHostname)
          ? 'Creality K1'
          : /^voron[-_]2[-_]4(?:[-_]|$)/.test(knownHostname)
            ? 'Voron 2.4'
            : '')
    if (!options.model && detectedModel) identity.model = detectedModel
    const klipperVersion =
      typeof info?.software_version === 'string'
        ? info.software_version.trim()
        : ''
    if (klipperVersion)
      identity.firmware = [`Klipper ${klipperVersion}`, identity.firmware]
        .filter(Boolean)
        .join('; ')

    const rawWebcams = extra?.webcams
    const cameras =
      rawWebcams ??
      discovery.webcams.map((cam) => ({
        name: cam.name,
        enabled: cam.enabled,
        snapshot_url: cam.snapshotUrl ?? cam.snapshotPath,
        stream_url: cam.streamUrl ?? cam.streamPath,
      }))
    camera.webcams = await Promise.all(
      cameras.map(async (cam) => {
        const name = typeof cam.name === 'string' ? cam.name : 'unknown'
        const enabled = cam.enabled !== false
        const location = cam.snapshot_url || cam.stream_url
        let url: string | null = null
        if (
          typeof location === 'string' &&
          location.length <= 2048 &&
          !/[\u0000-\u0020\u007f\\]/u.test(location)
        ) {
          try {
            const parsed = new URL(location, webcamOrigin)
            if (
              /^https?:$/.test(parsed.protocol) &&
              !parsed.username &&
              !parsed.password &&
              !location.startsWith('//')
            )
              url = parsed.href
          } catch {}
        }
        if (!enabled)
          return { name, enabled, reachable: false, url, detail: 'Disabled' }
        if (!url)
          return {
            name,
            enabled,
            reachable: false,
            url,
            detail: 'No usable URL',
          }
        try {
          const response = await fetch(url, {
            signal: AbortSignal.timeout(3000),
            redirect: 'error',
          })
          return {
            name,
            enabled,
            reachable: response.ok,
            url,
            detail: `HTTP ${response.status}`,
          }
        } catch {
          return {
            name,
            enabled,
            reachable: false,
            url,
            detail: 'Probe failed',
          }
        }
      }),
    )
    const reachable = camera.webcams.find((cam) => cam.reachable)
    if (reachable) {
      camera.reachable = true
      camera.kind = 'webcam'
      camera.url = reachable.url
      camera.detail = `${reachable.name}: ${reachable.detail}`
    }
    if (cameras.length === 0) {
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

    const optional = async (
      method: string,
    ): Promise<Record<string, unknown> | undefined> => {
      try {
        const value = await client.request(method, {})
        return value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined
      } catch {
        return undefined
      }
    }
    const printerInfo = await optional('printer.info')
    const machine = await optional('machine.system_info')
    const systemInfo =
      machine?.system_info && typeof machine.system_info === 'object'
        ? (machine.system_info as Record<string, unknown>)
        : machine
    const webcamResult = await optional('server.webcams.list')
    const webcams = Array.isArray(webcamResult?.webcams)
      ? webcamResult.webcams.filter(
          (item: unknown): item is Record<string, unknown> =>
            !!item && typeof item === 'object' && !Array.isArray(item),
        )
      : undefined
    let files: ObservedFiles = { listable: false, count: 0, files: [] }
    try {
      const result = await listMoonrakerFiles(client, { limit: 100 })
      files = {
        listable: true,
        count: result.length,
        files: result.slice(0, 100).map((f) => ({
          name: f.name,
          size: f.size,
          modified: f.modified,
          ...(f.estimatedTime !== undefined
            ? { estimatedTime: f.estimatedTime }
            : {}),
        })),
      }
    } catch {}
    return { printerInfo, systemInfo, webcams, files }
  } finally {
    socket.terminate()
  }
}
