// SPDX-License-Identifier: MIT
import { randomBytes } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import {
  checkServerIdentity,
  connect as connectTls,
  type TLSSocket,
} from 'node:tls'

const STREAM_PATH = '/streaming/live/1'
const MAX_RTSP_MESSAGE_BYTES = 64 * 1024
/** `$` + channel + 16-bit length, then up to 65535 payload bytes. */
const MAX_INTERLEAVED_BYTES = 4 + 0xffff
const UPSTREAM_IDLE_MS = 10_000
const CLIENT_IDLE_MS = 30_000
const METHODS = new Set([
  'OPTIONS',
  'DESCRIBE',
  'SETUP',
  'PLAY',
  'GET_PARAMETER',
  'TEARDOWN',
])

type Frame =
  | { kind: 'interleaved'; raw: Buffer }
  | { kind: 'message'; header: string; body: Buffer }

/** Takes one complete frame off `buffer`; undefined means more bytes needed. */
function takeFrame(buffer: Buffer): { frame: Frame; rest: Buffer } | undefined {
  if (buffer[0] === 0x24) {
    if (buffer.length < 4) return undefined
    const length = 4 + buffer.readUInt16BE(2)
    if (buffer.length < length) return undefined
    return {
      frame: { kind: 'interleaved', raw: buffer.subarray(0, length) },
      rest: buffer.subarray(length),
    }
  }
  const end = buffer.indexOf('\r\n\r\n')
  if (end < 0) {
    if (buffer.length > MAX_RTSP_MESSAGE_BYTES)
      throw Error('RTSP header too large')
    return undefined
  }
  const header = buffer.subarray(0, end).toString('latin1')
  const declared = /^Content-Length:[ \t]*(\d+)[ \t]*$/im.exec(header)?.[1]
  const length = declared === undefined ? 0 : Number(declared)
  if (
    !Number.isSafeInteger(length) ||
    end + 4 + length > MAX_RTSP_MESSAGE_BYTES
  )
    throw Error('RTSP message too large')
  if (buffer.length < end + 4 + length) return undefined
  return {
    frame: {
      kind: 'message',
      header,
      body: buffer.subarray(end + 4, end + 4 + length),
    },
    rest: buffer.subarray(end + 4 + length),
  }
}

/**
 * Keep FFmpeg on a loopback RTSP endpoint. This bridge owns the remote TLS
 * connection, verifies the printer identity before any byte is sent, adds
 * credentials only inside that encrypted connection, and refuses redirects,
 * foreign SDP controls, non-TCP transports and every non-read RTSP method.
 * The loopback endpoint admits one client that knows a per-session path token.
 */
export async function startBambuRtspsBridge(input: {
  host: string
  port: number
  accessCode: string
  caPem: Buffer
  signal: AbortSignal
}) {
  const token = randomBytes(16).toString('hex')
  const prefix = `/${token}`
  const authorization = `Authorization: Basic ${Buffer.from(`bblp:${input.accessCode}`).toString('base64')}`
  const clients = new Set<Socket>()
  const servers = new Set<TLSSocket>()
  let bridgePort = 0

  const rewrite = (value: string) =>
    value.replace(/rtsps?:\/\/[^\s"']+/gi, (raw) => {
      let url: URL
      try {
        url = new URL(raw)
      } catch {
        throw Error('Invalid Bambu RTSPS camera control URL')
      }
      if (
        url.protocol !== 'rtsps:' ||
        url.hostname !== input.host ||
        Number(url.port) !== input.port ||
        url.search ||
        url.hash ||
        url.username ||
        url.password ||
        (url.pathname !== STREAM_PATH &&
          url.pathname !== `${STREAM_PATH}/trackID=0`)
      )
        throw Error('Bambu RTSPS camera control URL escaped its source')
      return `rtsp://127.0.0.1:${bridgePort}${prefix}${url.pathname}`
    })

  /** Writes with backpressure so a stalled consumer cannot grow memory. */
  const forward = (from: Socket, to: Socket, data: Buffer) => {
    if (to.destroyed || to.write(data)) return
    from.pause()
    to.once('drain', () => from.resume())
  }

  const server = createServer((client) => {
    if (input.signal.aborted || clients.size > 0) {
      client.destroy()
      return
    }
    clients.add(client)
    client.on('error', () => {})
    client.setTimeout(CLIENT_IDLE_MS, () => client.destroy())

    const upstream = connectTls({
      host: input.host,
      port: input.port,
      ca: input.caPem,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      checkServerIdentity: (_host, certificate) =>
        checkServerIdentity(input.host, certificate),
    })
    servers.add(upstream)
    upstream.on('error', () => client.destroy())
    upstream.setTimeout(UPSTREAM_IDLE_MS, () => upstream.destroy())
    const stop = () => {
      client.destroy()
      upstream.destroy()
    }
    client.once('close', () => {
      clients.delete(client)
      upstream.destroy()
    })
    upstream.once('close', () => {
      servers.delete(upstream)
      client.destroy()
    })

    // Nothing, credentials included, leaves before the TLS identity checks pass.
    let secure = false
    const queued: Buffer[] = []
    const sendUpstream = (data: Buffer) => {
      if (!secure) queued.push(data)
      else forward(client, upstream, data)
    }
    upstream.once('secureConnect', () => {
      if (!upstream.authorized) return stop()
      secure = true
      for (const data of queued.splice(0)) forward(client, upstream, data)
    })

    let requestBuffer: Buffer = Buffer.alloc(0)
    let responseBuffer: Buffer = Buffer.alloc(0)

    const onRequest = (header: string, body: Buffer) => {
      const requestLine = /^([A-Z_]+) ([^ ]+) RTSP\/1\.0$/.exec(
        header.split('\r\n', 1)[0] ?? '',
      )
      if (!requestLine || !/^CSeq:[ \t]*\d+[ \t]*$/im.test(header))
        throw Error('Invalid RTSP request')
      const [, method, targetText] = requestLine
      if (!METHODS.has(method!)) throw Error('RTSP method refused')
      let path: string
      if (targetText === '*' && method === 'OPTIONS') {
        path = STREAM_PATH
      } else {
        const target = new URL(targetText!)
        const route = target.pathname.startsWith(`${prefix}/`)
          ? target.pathname.slice(prefix.length)
          : ''
        if (
          target.protocol !== 'rtsp:' ||
          target.hostname !== '127.0.0.1' ||
          Number(target.port) !== bridgePort ||
          target.search ||
          target.hash ||
          target.username ||
          target.password ||
          (route !== STREAM_PATH && route !== `${STREAM_PATH}/trackID=0`)
        )
          throw Error('RTSP target refused')
        path = route
      }
      // UDP would open a media path outside the verified TLS connection.
      if (
        method === 'SETUP' &&
        !/^Transport:[^\r\n]*RTP\/AVP\/TCP/im.test(header)
      )
        throw Error('RTSP transport refused')
      const headers = header
        .split('\r\n')
        .slice(1)
        .filter(
          (line) => !/^(Authorization|Proxy-Authorization|Cookie):/i.test(line),
        )
      headers.push(authorization)
      sendUpstream(
        Buffer.concat([
          Buffer.from(
            `${method} rtsps://${input.host}:${input.port}${path} RTSP/1.0\r\n${headers.join('\r\n')}\r\n\r\n`,
            'latin1',
          ),
          body,
        ]),
      )
    }

    const onResponse = (header: string, body: Buffer) => {
      const status = /^RTSP\/1\.0 (\d{3})\b/.exec(header)?.[1]
      if (!status || (Number(status) >= 300 && Number(status) < 400))
        throw Error('RTSP redirect refused')
      const rewrittenBody = Buffer.from(
        rewrite(body.toString('latin1')),
        'latin1',
      )
      let rewrittenHeader = rewrite(header)
      if (/^Content-Length:/im.test(rewrittenHeader))
        rewrittenHeader = rewrittenHeader.replace(
          /^Content-Length:.*$/im,
          `Content-Length: ${rewrittenBody.length}`,
        )
      forward(
        upstream,
        client,
        Buffer.concat([
          Buffer.from(`${rewrittenHeader}\r\n\r\n`, 'latin1'),
          rewrittenBody,
        ]),
      )
    }

    const pump =
      (
        read: () => Buffer,
        write: (value: Buffer) => void,
        onMessage: (header: string, body: Buffer) => void,
        relay: (raw: Buffer) => void,
      ) =>
      (chunk: Buffer) => {
        try {
          let buffer: Buffer = Buffer.concat([read(), chunk])
          for (;;) {
            const taken = takeFrame(buffer)
            if (!taken) break
            buffer = taken.rest
            if (taken.frame.kind === 'interleaved') relay(taken.frame.raw)
            else onMessage(taken.frame.header, taken.frame.body)
          }
          if (buffer.length > MAX_INTERLEAVED_BYTES)
            throw Error('RTSP overflow')
          write(Buffer.from(buffer))
        } catch {
          stop()
        }
      }
    client.on(
      'data',
      pump(
        () => requestBuffer,
        (value) => (requestBuffer = value),
        onRequest,
        (raw) => sendUpstream(Buffer.from(raw)),
      ),
    )
    upstream.on(
      'data',
      pump(
        () => responseBuffer,
        (value) => (responseBuffer = value),
        onResponse,
        (raw) => forward(upstream, client, Buffer.from(raw)),
      ),
    )
  })

  server.maxConnections = 1
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      input.signal.removeEventListener('abort', onAbort)
      const sockets = [...clients, ...servers]
      const closed = sockets.map(
        (socket) =>
          new Promise<void>((resolve) =>
            socket.destroyed
              ? resolve()
              : socket.once('close', () => resolve()),
          ),
      )
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await Promise.all(closed)
    })())
  const onAbort = () => void close()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await close()
    throw Error('Bambu RTSPS loopback bridge unavailable')
  }
  bridgePort = address.port
  input.signal.addEventListener('abort', onAbort, { once: true })
  if (input.signal.aborted) onAbort()
  return {
    url: `rtsp://127.0.0.1:${bridgePort}${prefix}${STREAM_PATH}`,
    close,
  }
}
