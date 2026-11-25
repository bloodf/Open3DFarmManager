import { randomBytes } from 'node:crypto'

// One request over one socket, never replayed. Envelope, topics and
// Ack: CBD SDCP V3.0.0, "Topic" and "Request Message", at
// https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0/blob/f977215761ee2e8c6d02ab06a68dc4d2b710a255/SDCP(Smart%20Device%20Control%20Protocol)_V3.0.0_EN.md

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Malformed Phrozen SDCP object')
  }
  return value as Record<string, unknown>
}

export function parse(frame: unknown) {
  if (typeof frame !== 'string' || frame.length > 1024 * 1024) {
    throw new Error('Malformed Phrozen SDCP frame')
  }
  return object(JSON.parse(frame))
}

export type PhrozenEndpoint = Readonly<{
  host: string
  port: number
  timeoutMs: number
  id: string
  board: string
}>

/** True unless the exchange failed before the request left this process. */
export function requestMayHaveArrived(error: unknown): boolean {
  return (error as { sent?: unknown } | null)?.sent !== false
}

export type PhrozenReply = {
  ack: number
  data: Record<string, unknown>
  /** The status or attributes frame, when the request asked for one. */
  pushed: Record<string, unknown> | undefined
}

/** A socket a read-only poller keeps between its own status requests. */
export type PhrozenSession = { socket?: WebSocket | undefined }

/**
 * Resolves with the correlated response. With `push`, a successful Ack also
 * waits for that board-scoped frame. `check` throws on a malformed frame body.
 */
export function exchange(
  endpoint: PhrozenEndpoint,
  cmd: number,
  payload: Record<string, unknown>,
  push?: {
    topic: 'status' | 'attributes'
    check(frame: Record<string, unknown>): Record<string, unknown>
  },
  {
    session,
    signal,
  }: {
    session?: PhrozenSession | undefined
    signal?: AbortSignal | undefined
  } = {},
) {
  return new Promise<PhrozenReply>((resolve, reject) => {
    const { board, id, host, port, timeoutMs } = endpoint
    const requestId = randomBytes(8).toString('hex')
    signal?.throwIfAborted()
    const url = `ws://${host}:${port}/websocket`
    const kept = session?.socket
    const reused =
      kept?.readyState === WebSocket.OPEN && kept.url === url ? kept : undefined
    if (kept && !reused) kept.close()
    const socket = reused ?? new WebSocket(url)
    if (session) session.socket = socket
    let settled = false
    let sent = false
    let reply: Omit<PhrozenReply, 'pushed'> | undefined
    let pushed: Record<string, unknown> | undefined
    const timer = setTimeout(
      () => fail(new Error('Phrozen status timeout')),
      timeoutMs,
    )

    const abort = () => fail(new Error('Phrozen request aborted'))
    signal?.addEventListener('abort', abort, { once: true })

    function close(keep = false) {
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (keep && session) return
      socket.close()
      if (session) session.socket = undefined
    }

    function fail(error: unknown) {
      if (settled) return
      close()
      reject(Object.assign(error as Error, { sent }))
    }

    const send = () => {
      if (settled) return
      sent = true
      socket.send(
        JSON.stringify({
          Id: id,
          Topic: `sdcp/request/${board}`,
          Data: {
            Cmd: cmd,
            Data: payload,
            RequestID: requestId,
            MainboardID: board,
            TimeStamp: Math.floor(Date.now() / 1000),
            From: 0,
          },
        }),
      )
    }
    socket.onopen = send
    socket.onerror = () => fail(new Error('Phrozen transport error'))
    socket.onclose = () => fail(new Error('Phrozen disconnected'))
    socket.onmessage = ({ data }) => {
      if (settled || data === 'pong') return
      try {
        const frame = parse(data)
        if (
          push &&
          frame.Topic === `sdcp/${push.topic}/${board}` &&
          frame.MainboardID === board
        ) {
          pushed = push.check(frame)
        }
        if (frame.Topic === `sdcp/response/${board}`) {
          const response = object(frame.Data)
          if (response.RequestID !== requestId) return
          const body = object(response.Data)
          const { Ack } = body
          if (
            response.Cmd !== cmd ||
            response.MainboardID !== board ||
            typeof Ack !== 'number' ||
            !Number.isInteger(Ack)
          ) {
            throw new Error('Malformed Phrozen acknowledgment')
          }
          reply = { ack: Ack, data: body }
        }
        if (reply && (reply.ack !== 0 || !push || pushed)) {
          close(true)
          resolve({ ...reply, pushed })
        }
      } catch (error) {
        fail(error)
      }
    }
    if (reused) send()
  })
}
