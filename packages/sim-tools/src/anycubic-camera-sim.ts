// SPDX-License-Identifier: MIT
import { createServer } from 'node:http'
import { once } from 'node:events'

/** Loopback-only fixture derived from docs/protocols/anycubic-camera.md. */
export async function startAnycubicCameraSim(input: {
  jpeg: Buffer
  auth?: { username: string; password: string }
  flv?: Buffer
  token?: string
  frameCount?: number
  /** Paces the MJPEG stream (one frame per interval, until the client leaves). */
  frameIntervalMs?: number
  failFirst?: boolean
  malformed?: boolean
}) {
  let requests = 0
  let authenticated = 0
  let captures = 0
  let stops = 0
  let active = false
  const token = input.token ?? 'synthetic-session'
  const expectedAuth = input.auth
    ? 'Basic ' +
      Buffer.from(input.auth.username + ':' + input.auth.password).toString(
        'base64',
      )
    : undefined
  const server = createServer((req, res) => {
    requests++
    if (expectedAuth && req.headers.authorization !== expectedAuth) {
      res.writeHead(401).end()
      return
    }
    authenticated++
    if (input.failFirst && requests === 1) {
      res.writeHead(503).end()
      return
    }
    if (req.url === '/?action=stream') {
      res.writeHead(200, {
        'content-type': 'multipart/x-mixed-replace; boundary=frame',
      })
      const interval = input.frameIntervalMs
      if (interval !== undefined) {
        const body = input.malformed ? Buffer.from('invalid') : input.jpeg
        const send = () => {
          res.write('--frame\r\nContent-Type: image/jpeg\r\n\r\n')
          res.write(body)
          res.write('\r\n')
        }
        send()
        const timer = setInterval(send, interval)
        res.on('close', () => clearInterval(timer))
        return
      }
      for (let i = 0; i < (input.frameCount ?? 24); i++) {
        res.write('--frame\r\nContent-Type: image/jpeg\r\n\r\n')
        res.write(input.malformed ? Buffer.from('invalid') : input.jpeg)
        res.write('\r\n')
      }
      res.end('--frame--\r\n')
    } else if (req.url === '/live/' + token && active && input.flv) {
      res.writeHead(200, { 'content-type': 'video/x-flv' })
      res.end(input.flv)
    } else res.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw Error('Simulator address unavailable')
  return {
    host: '127.0.0.1',
    port: address.port,
    get requests() {
      return requests
    },
    get authenticated() {
      return authenticated
    },
    get captures() {
      return captures
    },
    get stops() {
      return stops
    },
    async startCapture(signal: AbortSignal) {
      signal.throwIfAborted()
      captures++
      active = true
      const url = new URL(`http://127.0.0.1:${address.port}/live/${token}`)
      if (input.auth) {
        url.username = input.auth.username
        url.password = input.auth.password
      }
      return url.toString()
    },
    async stopCapture() {
      stops++
      active = false
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
