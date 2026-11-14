import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import {
  listBambuFiles,
  parseBambuListing,
} from '../../packages/connector/src/bambu/files.ts'
import { fixture } from '../fixtures/bambu-ftps/server.ts'

test('filters and sorts MLSD files and limits results', () => {
  const rows = Array.from(
    { length: 205 },
    (_, i) =>
      `type=file;size=${i};modify=20260101000000; file${String(i).padStart(3, '0')}.3mf`,
  )
  rows.push(
    'type=dir;size=1;modify=20270101000000; folder.gcode',
    'type=file;size=1;modify=20270230000000; invalid.gcode',
    'type=file;size=10;modify=20270101000000; latest.gcode',
  )
  const files = parseBambuListing(rows.join('\r\n'))
  assert.equal(files.length, 200)
  assert.deepEqual(files[0], {
    name: 'latest.gcode',
    size: 10,
    modifiedAt: '2027-01-01T00:00:00.000Z',
  })
})

test('rejects invalid credentials against fixture', async () => {
  const server = await fixture()
  try {
    const pinSha256 = createHash('sha256')
      .update(new X509Certificate(server.cert).raw)
      .digest('hex')
    await assert.rejects(
      listBambuFiles({
        host: '127.0.0.1',
        port: server.port,
        serial: 'TEST',
        accessCode: 'bad',
        trust: { pinSha256 },
        signal: new AbortController().signal,
        timeoutMs: 500,
      }),
    )
  } finally {
    await server.close()
  }
})

test('lists files over protected passive FTPS', async () => {
  const { createServer } = await import('node:tls')
  const { readFileSync } = await import('node:fs')
  const cert = readFileSync(
    new URL('../fixtures/bambu-ftps/cert.pem', import.meta.url),
  )
  const key = readFileSync(
    new URL('../fixtures/bambu-ftps/key.pem', import.meta.url),
  )
  const sockets = new Set<import('node:tls').TLSSocket>()
  const track = (socket: import('node:tls').TLSSocket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
  }
  let data: import('node:tls').TLSSocket | undefined
  const passive = createServer({ cert, key }, (socket) => {
    track(socket)
    data = socket
  })
  await new Promise<void>((resolve) => passive.listen(0, '127.0.0.1', resolve))
  const address = passive.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  const server = createServer({ cert, key }, (socket) => {
    track(socket)
    socket.write('220 ready\r\n')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      let end: number
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (line.startsWith('USER ')) socket.write('331 password\r\n')
        else if (line.startsWith('PASS ')) socket.write('230 ok\r\n')
        else if (line === 'PASV')
          socket.write(
            `227 passive (127,0,0,1,${address.port >> 8},${address.port & 255})\r\n`,
          )
        else if (line === 'MLSD') {
          socket.write('150 listing\r\n')
          const send = (stream: import('node:tls').TLSSocket) => {
            stream.end(
              'type=file;size=42;modify=20261114010203; sample.3mf\r\n',
            )
            socket.write('226 done\r\n')
          }
          if (data) send(data)
          else passive.once('secureConnection', send)
        } else socket.write('200 ok\r\n')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const control = server.address()
  if (!control || typeof control === 'string') throw new Error('No port')
  try {
    const pinSha256 = createHash('sha256')
      .update(new X509Certificate(cert).raw)
      .digest('hex')
    assert.deepEqual(
      await listBambuFiles({
        host: '127.0.0.1',
        port: control.port,
        serial: 'TEST',
        accessCode: 'secret',
        trust: { pinSha256 },
        signal: new AbortController().signal,
      }),
      [
        {
          name: 'sample.3mf',
          size: 42,
          modifiedAt: '2026-11-14T01:02:03.000Z',
        },
      ],
    )
  } finally {
    for (const socket of sockets) socket.destroy()
    await Promise.all(
      [server, passive].map(
        (s) => new Promise<void>((resolve) => s.close(() => resolve())),
      ),
    )
  }
})
