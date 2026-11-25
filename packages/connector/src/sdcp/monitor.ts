/**
 * Read-only status of a model whose discovery or status shape differs from the
 * resin adapter in `index.ts` (Centauri Carbon). Polls Cmd 0 only, which
 * bjan/pycentauri @ 2f6d9ed docs/PROTOCOL.md lists as confirmed on the Carbon.
 */
import WebSocket from 'ws'
import { buildSdcpCommand, sdcpRequest } from './commands.ts'
import type { SdcpTarget } from './identity.ts'
import { sdcpProfile } from './models.ts'
import { decodeSdcpStatus, type SdcpReport } from './report.ts'
import type { SdcpStatus } from './index.ts'

function status(
  report: SdcpReport,
  observedAt: number,
): SdcpStatus | undefined {
  if (report.state === 'unknown') return
  const { currentLayer, totalLayer } = report
  return {
    state: report.state === 'cancelled' ? 'idle' : report.state,
    observedAt,
    ...(currentLayer !== undefined && totalLayer
      ? { currentLayer, totalLayer, progress: currentLayer / totalLayer }
      : {}),
  }
}

export function monitorSdcp(
  target: SdcpTarget,
  options: { port?: number; staleAfterMs?: number } = {},
) {
  const profile = sdcpProfile(target.model)
  if (!profile) throw new Error('Unsupported SDCP model')
  const socket = new WebSocket(
    `ws://${target.host}:${options.port ?? 3030}/websocket`,
    { maxPayload: 65536 },
  )
  let latest: SdcpStatus | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const refresh = () => {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify(
          sdcpRequest(target, profile, buildSdcpCommand(target.model, 'status'))
            .frame,
        ),
      )
  }
  socket.on('open', () => {
    refresh()
    timer = setInterval(refresh, 2000)
  })
  socket.on('error', () => {
    latest = undefined
  })
  socket.on('close', () => {
    clearInterval(timer)
    latest = undefined
  })
  socket.on('message', (data) => {
    const report = decodeSdcpStatus(
      data.toString(),
      target.mainboardId,
      profile.family,
    )
    if (report) latest = status(report, Date.now())
  })
  return {
    snapshot: () =>
      latest && Date.now() - latest.observedAt < (options.staleAfterMs ?? 30000)
        ? latest
        : undefined,
    close: () => {
      clearInterval(timer)
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
      else socket.close()
    },
  }
}
