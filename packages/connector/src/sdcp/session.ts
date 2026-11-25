/**
 * Short request/response exchanges with a printer, for the history reads.
 * Frames:
 * cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0 @ f977215
 * ("sdcp/request" and "sdcp/response" topics, matched by `RequestID`).
 * The board and model are rediscovered first; one frame per request.
 */
import WebSocket from 'ws'
import { sdcpRequest } from './commands.ts'
import { resolveSdcpTarget } from './identity.ts'
import { sdcpProfile } from './models.ts'
import { decodeSdcpResponse } from './report.ts'

export type SdcpEndpoint = Readonly<{
  host: string
  mainboardId: string
  model: string
  discoveryPort?: number | undefined
  websocketPort?: number | undefined
}>

export async function openSdcpSession(
  endpoint: SdcpEndpoint,
  options: { signal: AbortSignal; timeoutMs?: number },
) {
  const profile = sdcpProfile(endpoint.model)
  if (!profile) throw new Error('Unsupported SDCP model')
  const timeoutMs = options.timeoutMs ?? 2000
  const target = await resolveSdcpTarget(endpoint, {
    ...(endpoint.discoveryPort ? { port: endpoint.discoveryPort } : {}),
    signal: options.signal,
  })
  const socket = new WebSocket(
    `ws://${endpoint.host}:${endpoint.websocketPort ?? 3030}/websocket`,
    {
      maxPayload: 262144,
      handshakeTimeout: timeoutMs,
      perMessageDeflate: false,
      followRedirects: false,
    },
  )
  socket.on('error', () => {})
  const abort = () => socket.terminate()
  options.signal.addEventListener('abort', abort, { once: true })
  try {
    options.signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('close', () => reject(new Error('SDCP unavailable')))
    })
  } catch (error) {
    socket.terminate()
    throw error
  } finally {
    options.signal.removeEventListener('abort', abort)
  }
  return {
    target,
    request(
      command: { Cmd: 320 | 321; Data: Record<string, unknown> },
      signal?: AbortSignal,
    ): Promise<Record<string, unknown>> {
      if (command.Cmd !== 320 && command.Cmd !== 321)
        return Promise.reject(new Error('SDCP history session is read-only'))
      const { requestId, frame } = sdcpRequest(target, profile, command)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(fail, timeoutMs)
        function done() {
          clearTimeout(timer)
          socket.off('message', message)
          socket.off('close', fail)
          signal?.removeEventListener('abort', fail)
        }
        function fail() {
          done()
          reject(new Error(`SDCP Cmd ${command.Cmd} was not answered`))
        }
        function message(data: WebSocket.RawData, binary: boolean) {
          if (binary) return
          const reply = decodeSdcpResponse(
            data.toString(),
            target.mainboardId,
            requestId,
            command.Cmd,
          )
          if (!reply) return
          done()
          resolve(reply)
        }
        if (socket.readyState !== WebSocket.OPEN || signal?.aborted)
          return fail()
        socket.on('message', message)
        socket.on('close', fail)
        signal?.addEventListener('abort', fail, { once: true })
        socket.send(JSON.stringify(frame), (error) => {
          if (error) fail()
        })
      })
    },
    close() {
      socket.close()
      setTimeout(() => socket.terminate(), 500).unref()
    },
  }
}
