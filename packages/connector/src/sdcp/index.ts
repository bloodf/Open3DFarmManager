import WebSocket from 'ws'
import { isSupportedSdcpModel, type SdcpIdentity } from '../discovery/sdcp.ts'

export type SdcpStatus = {
  state: 'idle' | 'printing' | 'paused' | 'error'
  currentLayer?: number
  totalLayer?: number
  progress?: number
  observedAt: number
}
export function connectSdcp(
  identity: SdcpIdentity,
  options: { port?: number; staleAfterMs?: number; now?: () => number } = {},
) {
  if (!isSupportedSdcpModel(identity.model))
    throw new Error('Unsupported SDCP model')
  if (!/^V?3\.0\.0$/i.test(identity.protocolVersion))
    throw new Error(
      `Unsupported SDCP protocol version: ${identity.protocolVersion}`,
    )
  const now = options.now ?? Date.now
  const socket = new WebSocket(
    `ws://${identity.host}:${options.port ?? 3030}/websocket`,
    { maxPayload: 65536 },
  )
  let status: SdcpStatus | undefined
  socket.on('error', () => {
    status = undefined
  })
  socket.on('close', () => {
    status = undefined
  })
  socket.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString())
      if (
        message.MainboardID !== identity.mainboardId ||
        message.Topic !== `sdcp/status/${identity.mainboardId}`
      )
        return
      const wire = message.Status
      const current = wire?.CurrentStatus
      const info = wire?.PrintInfo
      if (
        !Array.isArray(current) ||
        !current.length ||
        !current.every(
          (v: unknown) =>
            Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 4,
        ) ||
        !info ||
        !Number.isInteger(info.Status) ||
        info.Status < 0 ||
        info.Status > 10 ||
        !Number.isInteger(info.ErrorNumber) ||
        info.ErrorNumber < 0
      )
        return
      const state =
        info.ErrorNumber > 0
          ? 'error'
          : current.includes(1)
            ? info.Status === 6
              ? 'paused'
              : 'printing'
            : 'idle'
      const layer = info.CurrentLayer,
        total = info.TotalLayer
      const validLayers =
        Number.isSafeInteger(layer) &&
        Number.isSafeInteger(total) &&
        layer >= 0 &&
        total > 0 &&
        layer <= total
      status = {
        state,
        observedAt: now(),
        ...(validLayers
          ? { currentLayer: layer, totalLayer: total, progress: layer / total }
          : {}),
      }
    } catch {
      /* Ignore malformed messages. */
    }
  })
  return {
    capabilities: { status: true, dispatch: false, control: false } as const,
    snapshot: () =>
      status &&
      now() - status.observedAt >= 0 &&
      now() - status.observedAt < (options.staleAfterMs ?? 30000)
        ? status
        : undefined,
    command: (_command: unknown) => ({
      ok: false as const,
      reason: 'unsupported' as const,
    }),
    close: () => socket.close(),
  }
}
