import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { isIPv4 } from 'node:net'
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
  if (
    !isIPv4(identity.host) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(identity.mainboardId) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(identity.brandId)
  )
    throw new Error('Invalid SDCP identity')
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
  let timer: ReturnType<typeof setInterval> | undefined
  const refresh = () => {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          Id: identity.brandId,
          Data: {
            Cmd: 0,
            Data: {},
            RequestID: randomUUID().replaceAll('-', ''),
            MainboardID: identity.mainboardId,
            TimeStamp: Math.floor(Date.now() / 1000),
            From: 0,
          },
          Topic: `sdcp/request/${identity.mainboardId}`,
        }),
      )
  }
  socket.on('open', () => {
    refresh()
    timer = setInterval(refresh, 2000)
  })
  socket.on('error', () => {
    status = undefined
  })
  socket.on('close', () => {
    clearInterval(timer)
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
    close: () => {
      clearInterval(timer)
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
      else socket.close()
    },
  }
}
