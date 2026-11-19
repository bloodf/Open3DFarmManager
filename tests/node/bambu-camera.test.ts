// SPDX-License-Identifier: MIT
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type TLSSocket } from 'node:tls'
import { createHash, X509Certificate } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bambuCameraAuth,
  MAX_BAMBU_JPEG_BYTES,
  readBambuJpegs,
  selectBambuCamera,
  streamBambuJpegs,
} from '../../packages/connector/src/bambu/camera.ts'
import {
  readBambuH264,
  openBambuCameraSource,
} from '../../packages/connector/src/bambu/camera-media.ts'
import type { HelperExecutable } from '../../tools/rtsp-ingest/supervisor/process.ts'
import {
  createFakeEncoder,
  ffmpegFixtures,
  ffmpegQualificationSkip,
  qualificationEncoder,
} from '../helpers/camera-encoder.ts'

const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9])
// Offline stand-in for FFmpeg; it exits non-zero if the access code reaches argv.
const encoder = createFakeEncoder(['synthetic'])
after(() => encoder.dispose())
function record(payload: Buffer = jpeg) {
  const header = Buffer.alloc(16)
  header.writeUInt32LE(payload.length)
  return Buffer.concat([header, payload])
}
async function* chunks(...values: Buffer[]) {
  yield* values
}
async function collect<T>(values: AsyncIterable<T>) {
  const result: T[] = []
  for await (const value of values) result.push(value)
  return result
}

test('models select local TLS JPEG or authenticated RTSPS 322', () => {
  for (const model of ['A1', 'A1 mini', 'P1P', 'P1S'])
    assert.deepEqual(
      selectBambuCamera({
        model,
        host: '192.168.1.2',
        accessCode: 'synthetic',
      }),
      { kind: 'jpeg', port: 6000 },
    )
  for (const model of ['X1', 'X1C', 'X1E', 'H2D', 'H2S', 'H2C', 'P2S']) {
    const selected = selectBambuCamera({
      model,
      host: '192.168.1.2',
      accessCode: 'a:@?',
    })
    assert.equal(selected.kind, 'rtsps')
    if (selected.kind === 'rtsps') {
      const url = new URL(selected.url)
      assert.equal(url.protocol, 'rtsps:')
      assert.equal(url.port, '322')
      assert.equal(url.pathname, '/streaming/live/1')
      assert.equal(url.username, 'bblp')
      assert.equal(decodeURIComponent(url.password), 'a:@?')
    }
  }
  for (const model of ['unknown', 'P1S/evil'])
    assert.throws(
      () =>
        selectBambuCamera({
          model,
          host: '127.0.0.1',
          accessCode: 'synthetic',
        }),
      /Unsupported/,
    )
  assert.throws(
    () =>
      selectBambuCamera({
        model: 'A1',
        host: '8.8.8.8',
        accessCode: 'synthetic',
      }),
    /Invalid/,
  )
})

test('80-byte auth layout has exact little endian fields and zero padding', () => {
  const expected = Buffer.alloc(80)
  expected[0] = 0x40
  expected[5] = 0x30
  expected.write('bblp', 16)
  expected.write('synthetic', 48)
  assert.deepEqual(bambuCameraAuth('synthetic'), expected)
  for (const value of ['', 'x'.repeat(33), 'a\n', 'é'])
    assert.throws(() => bambuCameraAuth(value), /Invalid/)
})

test('parser accepts split headers, split frames and coalesced records', async () => {
  const wire = Buffer.concat([record(), record()])
  const frames = await collect(
    readBambuJpegs(chunks(...Array.from(wire, (byte) => Buffer.from([byte])))),
  )
  assert.deepEqual(frames, [jpeg, jpeg])
  assert.deepEqual(await collect(readBambuJpegs(chunks(wire))), [jpeg, jpeg])
})

test('parser rejects oversized, empty, invalid and truncated frames', async () => {
  for (const size of [0, 3, MAX_BAMBU_JPEG_BYTES + 1, 0xffffffff]) {
    const header = Buffer.alloc(16)
    header.writeUInt32LE(size)
    await assert.rejects(collect(readBambuJpegs(chunks(header))), /frame size/)
  }
  for (const payload of [
    Buffer.from([0, 0, 0xff, 0xd9]),
    Buffer.from([0xff, 0xd8, 0, 0]),
  ])
    await assert.rejects(
      collect(readBambuJpegs(chunks(record(payload)))),
      /JPEG/,
    )
  for (const wire of [record().subarray(0, 7), record().subarray(0, 18)])
    await assert.rejects(collect(readBambuJpegs(chunks(wire))), /Truncated/)
})

test('Annex B AUD parser preserves complete access units across chunk boundaries', async () => {
  const first = Buffer.from([0, 0, 0, 1, 9, 0xf0, 0, 0, 1, 5, 1])
  const second = Buffer.from([0, 0, 1, 9, 0xf0, 0, 0, 1, 1, 2])
  const data = Buffer.concat([first, second])
  const result = await collect(
    readBambuH264(chunks(...Array.from(data, (b) => Buffer.from([b])))),
  )
  assert.deepEqual(
    result.map((unit) => unit.data),
    [first, second],
  )
  assert.deepEqual(
    result.map((unit) => unit.keyframe),
    [true, false],
  )
  assert.ok(result[1]!.timestampUs > result[0]!.timestampUs)
})

async function assertTlsLoopback(media: {
  ffmpeg: HelperExecutable
  jpeg: Buffer
}) {
  const dir = mkdtempSync(join(tmpdir(), 'bambu-camera-'))
  const sockets = new Set<TLSSocket>()
  let server: ReturnType<typeof createServer> | undefined
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'key'),
        '-out',
        join(dir, 'cert'),
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'ignore' },
    )
    const cert = readFileSync(join(dir, 'cert'))
    const pinSha256 = createHash('sha256')
      .update(new X509Certificate(cert).raw)
      .digest('hex')
    let authentications = 0
    let peerJpeg: Buffer = jpeg
    let encoding = false
    server = createServer(
      { key: readFileSync(join(dir, 'key')), cert },
      (socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        socket.on('error', () => {})
        let auth = Buffer.alloc(0)
        socket.on('data', (part) => {
          auth = Buffer.concat([auth, part])
          if (auth.length < 80) return
          assert.deepEqual(auth, bambuCameraAuth('synthetic'))
          authentications++
          if (authentications === 1) socket.end(record().subarray(0, 18))
          else {
            socket.write(record(peerJpeg).subarray(0, 5))
            socket.write(record(peerJpeg).subarray(5))
            if (encoding)
              for (let i = 0; i < 24; i++) socket.write(record(peerJpeg))
          }
        })
      },
    )
    server.on('tlsClientError', () => {})
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    )
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const controller = new AbortController()
    const frames = streamBambuJpegs({
      host: '127.0.0.1',
      port: address.port,
      accessCode: 'synthetic',
      pinSha256,
      signal: controller.signal,
      reconnectDelayMs: 1,
    })
    assert.deepEqual((await frames.next()).value, jpeg)
    assert.equal(authentications, 2)
    controller.abort()
    await frames.return(undefined)
    await assert.rejects(
      collect(
        streamBambuJpegs({
          host: '127.0.0.1',
          port: address.port,
          accessCode: 'synthetic',
          pinSha256: '0'.repeat(64),
          signal: new AbortController().signal,
          maxReconnects: 0,
        }),
      ),
      /unavailable/,
    )
    assert.equal(authentications, 2, 'bad pin must not send credentials')
    peerJpeg = media.jpeg
    encoding = true
    const mediaAbort = new AbortController()
    const encoded = await openBambuCameraSource({
      source: {
        model: 'P1S',
        host: '127.0.0.1',
        accessCode: 'synthetic',
        pinSha256,
      },
      ffmpeg: media.ffmpeg,
      signal: mediaAbort.signal,
      jpegStream: async function* (options) {
        yield* streamBambuJpegs({ ...options, port: address.port })
      },
    })
    const iterator = encoded[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      assert.equal(first.done, false)
      assert.ok(first.value?.keyframe)
      assert.ok(first.value.data.length > 20)
      const next = await iterator.next()
      assert.ok(next.value && next.value.timestampUs > first.value.timestampUs)
    } finally {
      mediaAbort.abort()
      await iterator.return?.()
    }
  } finally {
    for (const socket of sockets) socket.destroy()
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
}

test(
  'TLS loopback authenticates after pin verification, reconnects and aborts',
  { timeout: 15000 },
  () => assertTlsLoopback({ ffmpeg: encoder.ffmpeg, jpeg }),
)

test(
  'qualification: TLS loopback feeds real FFmpeg H264 encoder',
  { timeout: 15000, skip: ffmpegQualificationSkip },
  () => {
    const ffmpeg = qualificationEncoder()
    return assertTlsLoopback({ ffmpeg, jpeg: ffmpegFixtures(ffmpeg.path).jpeg })
  },
)

test('untrusted codec is rejected before process creation', async () => {
  await assert.rejects(
    openBambuCameraSource({
      source: { model: 'A1', host: '127.0.0.1', accessCode: 'synthetic' },
      ffmpeg: { path: 'ffmpeg', sha256: '0'.repeat(64) },
      signal: new AbortController().signal,
    }),
    /encoder/,
  )
})
