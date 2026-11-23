// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer, type TLSSocket } from 'node:tls'
import { journeyCameraFrame } from './camera-encoder.ts'

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
  let requests = 0
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
      socket.setTimeout(5000, () => socket.destroy())
      if (input.redirectTo) {
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
    connections: () => connections,
    activeConnections: () => sockets.size,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
