// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer, type TLSSocket } from 'node:tls'
import { connect } from 'node:net'
import { journeyCameraFrame } from './camera-encoder.ts'
import { startCameraMock } from '../../packages/sim-tools/src/camera-mock.ts'

const host = '127.0.0.1'
const MAX_FRAMES = 300

function jpegSession(socket: TLSSocket, accessCode: string, admit: () => void) {
  const auth = Buffer.alloc(80)
  auth.writeUInt32LE(0x40)
  auth.writeUInt32LE(0x3000, 4)
  auth.write('bblp', 16, 'ascii')
  auth.write(accessCode, 48, 'ascii')
  const frame = journeyCameraFrame()
  const header = Buffer.alloc(16)
  header.writeUInt32LE(frame.length)
  const record = Buffer.concat([header, frame])
  let pending = Buffer.alloc(0)
  function authenticate(chunk: Buffer) {
    if (pending.length + chunk.length > auth.length) return socket.destroy()
    pending = Buffer.concat([pending, chunk])
    if (pending.length !== auth.length) return
    socket.off('data', authenticate)
    if (!timingSafeEqual(pending, auth)) return socket.destroy()
    admit()
    pace(socket, () => socket.write(record))
  }
  socket.on('data', authenticate)
}

function pace(socket: TLSSocket, send: () => boolean) {
  let remaining = MAX_FRAMES
  const timer = setInterval(() => {
    if (remaining-- === 0 || !send()) socket.destroy()
  }, 100)
  socket.once('close', () => clearInterval(timer))
}

export async function startBambuCameraFixture(input: {
  directory: string
  accessCode: string
  certificateIp?: '127.0.0.1' | '127.0.0.2'
  redirectTo?: string
  rtsps?: boolean
}) {
  const certificateIp = input.certificateIp ?? host
  const caFile = join(input.directory, 'camera-cert.pem')
  const keyFile = join(input.directory, 'camera-key.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${certificateIp}`,
      '-addext',
      `subjectAltName=IP:${certificateIp}`,
      '-keyout',
      keyFile,
      '-out',
      caFile,
    ],
    { stdio: 'ignore', timeout: 10_000 },
  )
  const sockets = new Set<TLSSocket>()
  const source = input.rtsps ? await startCameraMock() : undefined
  const sourcePort = source ? Number(new URL(source.rtspUrl).port) : undefined
  let requests = 0
  let seen = 0
  let credentials = 0
  let connections = 0
  const server = createServer(
    {
      key: await readFile(keyFile),
      cert: await readFile(caFile),
      handshakeTimeout: 5000,
    },
    (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.on('error', () => {})
      // An RTSPS viewer is silent while it plays; only the JPEG/redirect paths idle out fast.
      socket.setTimeout(input.rtsps ? 120_000 : 5000, () => socket.destroy())
      if (input.rtsps) {
        const upstream = connect(sourcePort!, host)
        upstream.on('error', () => socket.destroy())
        upstream.on('data', (chunk) => socket.write(chunk))
        socket.once('close', () => upstream.destroy())
        let pending = Buffer.alloc(0)
        socket.on('data', (chunk) => {
          pending = Buffer.concat([pending, chunk])
          for (;;) {
            if (pending[0] === 0x24) {
              if (pending.length < 4) return
              const frameLength = pending.readUInt16BE(2)
              if (pending.length < 4 + frameLength) return
              // The maintained RTSP test source does not consume RTCP feedback.
              pending = pending.subarray(4 + frameLength)
              continue
            }
            const end = pending.indexOf('\r\n\r\n')
            if (end < 0) return
            const request = pending.subarray(0, end + 4)
            pending = pending.subarray(end + 4)
            const text = request.toString('latin1')
            const cseq = /^CSeq: (\d+)\r?$/im.exec(text)?.[1]
            if (!cseq) return socket.destroy()
            seen++
            if (/^Authorization:/im.test(text)) credentials++
            if (input.redirectTo) {
              requests++
              socket.write(
                `RTSP/1.0 302 Moved Temporarily\r\nCSeq: ${cseq}\r\nLocation: ${input.redirectTo}\r\n\r\n`,
              )
              continue
            }
            const authorization = /^Authorization: Basic ([^\r\n]+)\r?$/im.exec(
              text,
            )?.[1]
            const expected = Buffer.from(
              Buffer.from(`bblp:${input.accessCode}`).toString('base64'),
            )
            const received = Buffer.from(authorization ?? '')
            const firstLine = /^([^ ]+) ([^ ]+) RTSP\/1\.0\r?$/m.exec(text)
            if (!firstLine) return socket.destroy()
            if (
              firstLine[1] !== 'OPTIONS' &&
              (received.length !== expected.length ||
                !timingSafeEqual(received, expected))
            ) {
              socket.write(
                `RTSP/1.0 401 Unauthorized\r\nCSeq: ${cseq}\r\nWWW-Authenticate: Basic realm="Bambu camera"\r\n\r\n`,
              )
              continue
            }
            if (firstLine[1] !== 'OPTIONS') requests++
            let target: URL
            try {
              target = new URL(firstLine[2]!)
            } catch {
              return socket.destroy()
            }
            const prefix = '/streaming/live/1'
            if (
              target.protocol !== 'rtsps:' ||
              target.hostname !== host ||
              Number(target.port) !==
                (server.address() as import('node:net').AddressInfo).port ||
              (target.pathname !== prefix &&
                target.pathname !== `${prefix}/trackID=0`) ||
              target.search ||
              target.hash ||
              target.username ||
              target.password
            )
              return socket.destroy()
            const suffix = target.pathname.slice(prefix.length)
            const localTarget = `rtsp://${host}:${sourcePort}/test${suffix}`
            const forwarded = text.replace(
              firstLine[0],
              `${firstLine[1]} ${localTarget} RTSP/1.0`,
            )
            upstream.write(forwarded)
          }
        })
      } else if (input.redirectTo) {
        socket.once('data', (chunk: Buffer) => {
          requests++
          const cseq = /^CSeq: (\d+)\r?$/im.exec(chunk.toString('ascii'))?.[1]
          if (!cseq) return socket.destroy()
          socket.end(
            `RTSP/1.0 302 Moved Temporarily\r\nCSeq: ${cseq}\r\nLocation: ${input.redirectTo}\r\n\r\n`,
          )
        })
      } else {
        jpegSession(socket, input.accessCode, () => {
          requests++
        })
      }
    },
  )
  server.on('connection', () => connections++)
  server.maxConnections = 4
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return {
    host,
    port: (server.address() as import('node:net').AddressInfo).port,
    caFile,
    requests: () => requests,
    /** Every RTSP request that reached the fixture, authenticated or not. */
    received: () => seen,
    /** Requests that carried credentials, including the unauthenticated OPTIONS. */
    credentials: () => credentials,
    connections: () => connections,
    activeConnections: () => sockets.size,
    async close() {
      for (const socket of sockets) socket.destroy()
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
        source?.close() ?? Promise.resolve(),
      ])
    },
  }
}
