import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  listBambuFiles,
  parseBambuListing,
} from '../../packages/connector/src/bambu/files.ts'
import { bambuFtps } from '../../packages/connector/src/bambu/ftps-ops.ts'
import { parseBambuUnixListing } from '../../packages/connector/src/bambu/listing.ts'
import { startBambuFtpsSim } from '../../packages/sim-tools/src/bambu-ftps-sim.ts'
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

test('parses regular Unix LIST files and resolves a recent date across New Year', () => {
  const listing = [
    '-rw-r--r-- 1 root root 42 Dec 31 23:59 latest print.gcode.3mf',
    '-rw-r--r-- 1 root root 6 Feb 29 2024 leap.gcode',
    '-rw-r--r-- 1 root root 6 Feb 29 2025 invalid.gcode',
    '-rw-r--r-- 1 root root 6 Dec 31 24:02 invalid.gcode',
    '-rw-r--r-- 1 root root 6 Dec 31 2025 ../escaped.gcode',
    '-rw-r--r-- 1 root root 9007199254740992 Dec 31 2025 too-large.gcode',
    '-rw-r--r-- 1 root root 6 Dec 31 2025 file.txt',
    'drwxr-xr-x 1 root root 6 Dec 31 2025 dir.gcode',
    'lrwxr-xr-x 1 root root 6 Dec 31 2025 link -> other.gcode',
  ].join('\r\n')
  assert.deepEqual(
    parseBambuUnixListing(
      listing,
      /\.(3mf|gcode)$/i,
      new Date('2026-01-01T00:00Z'),
    ),
    [
      {
        name: 'latest print.gcode.3mf',
        size: 42,
        modifiedAt: '2025-12-31T23:59:00.000Z',
      },
      { name: 'leap.gcode', size: 6, modifiedAt: '2024-02-29T00:00:00.000Z' },
    ],
  )
})

test('keeps the current year for Unix LIST times ahead of UTC on leap day', () => {
  assert.deepEqual(
    parseBambuUnixListing(
      '-rw-r--r-- 1 root root 42 Feb 29 08:30 local clock.gcode',
      /\.gcode$/,
      new Date('2024-02-29T00:30:00Z'),
    ),
    [
      {
        name: 'local clock.gcode',
        size: 42,
        modifiedAt: '2024-02-29T08:30:00.000Z',
      },
    ],
  )
})

test('uses the previous year only beyond the 183-day Unix LIST cutoff', () => {
  const listing = [
    '-rw-r--r-- 1 root root 6 Jul 3 00:00 at cutoff.gcode',
    '-rw-r--r-- 1 root root 7 Jul 3 00:01 beyond cutoff.gcode',
    '-rw-r--r-- 1 root root 8 Feb 29 08:30 invalid leap day.gcode',
  ].join('\r\n')
  assert.deepEqual(
    parseBambuUnixListing(listing, /\.gcode$/, new Date('2026-01-01T00:00Z')),
    [
      {
        name: 'at cutoff.gcode',
        size: 6,
        modifiedAt: '2026-07-03T00:00:00.000Z',
      },
      {
        name: 'beyond cutoff.gcode',
        size: 7,
        modifiedAt: '2025-07-03T00:01:00.000Z',
      },
    ],
  )
})

test('lists print and timelapse files over TLS when the Bambu simulator rejects MLSD', async (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-11-18T08:41:23Z'),
  })
  const host = '127.0.0.1'
  const accessCode = 'synthetic'
  const cert = readFileSync(
    new URL('../fixtures/bambu-ftps/cert.pem', import.meta.url),
  )
  const key = readFileSync(
    new URL('../fixtures/bambu-ftps/key.pem', import.meta.url),
  )
  const simulator = await startBambuFtpsSim({
    host,
    port: 0,
    accessCode,
    key,
    cert,
    uploads: new Map([
      ['part one.gcode.3mf', Buffer.alloc(42)],
      ['ignore.mp4', Buffer.alloc(5)],
    ]),
    timelapse: new Map([['print.mp4', Buffer.alloc(12)]]),
  })
  t.after(() => simulator.close())
  const options = {
    host,
    port: simulator.port,
    serial: 'TEST',
    accessCode,
    trust: {
      pinSha256: createHash('sha256')
        .update(new X509Certificate(cert).raw)
        .digest('hex'),
    },
    signal: new AbortController().signal,
    timeoutMs: 3000,
  }

  const modifiedAt = '2026-11-18T08:41:00.000Z'
  for (const code of [500, 502, 504] as const) {
    simulator.setMlsdRejection(code)
    assert.deepEqual(
      await listBambuFiles(options),
      [{ name: 'part one.gcode.3mf', size: 42, modifiedAt }],
      `MLSD reply ${code}`,
    )
  }
  assert.deepEqual(
    await bambuFtps(options, { op: 'list', folder: 'timelapse' }),
    {
      op: 'list',
      files: [{ name: 'print.mp4', size: 12, modifiedAt }],
    },
  )
  simulator.setMlsdRejection(550)
  await assert.rejects(listBambuFiles(options), /FTPS request rejected/)
  assert.deepEqual(simulator.listingRequests, [
    'MLSD',
    'LIST',
    'MLSD',
    'LIST',
    'MLSD',
    'LIST',
    'MLSD /timelapse',
    'LIST /timelapse',
    'MLSD',
  ])
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
