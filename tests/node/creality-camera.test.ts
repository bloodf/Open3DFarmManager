// SPDX-License-Identifier: MIT
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import {
  selectCrealityCamera,
  streamCrealityJpegs,
  MAX_CREality_JPEG_BYTES,
} from '../../packages/connector/src/creality/camera.ts'

const jpeg = Buffer.from([255, 216, 1, 2, 255, 217])

test('selects only a local printer host', () => {
  assert.deepEqual(selectCrealityCamera({ host: '127.0.0.1' }), {
    kind: 'mjpeg',
    host: '127.0.0.1',
    port: 8080,
  })
  assert.throws(() => selectCrealityCamera({ host: 'example.com' }))
})

test('reads frames and reconnects after a stream ends', async () => {
  let connections = 0
  const server = createServer((_req, res) => {
    connections++
    res.writeHead(200, {
      'content-type': 'multipart/x-mixed-replace; boundary=frame',
    })
    res.end(
      Buffer.concat([
        Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n\r\n'),
        jpeg,
        Buffer.from('\r\n--frame--\r\n'),
      ]),
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    assert(address && typeof address !== 'string')
    const frames = streamCrealityJpegs({
      host: '127.0.0.1',
      port: address.port,
      signal: new AbortController().signal,
      reconnectDelayMs: 1,
      maxReconnects: 1,
    })
    assert.deepEqual((await frames.next()).value, jpeg)
    assert.deepEqual((await frames.next()).value, jpeg)
    await frames.return(undefined)
    assert.equal(connections, 2)
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('rejects malformed boundaries and oversized frames', async () => {
  for (const payload of [
    Buffer.from('--wrong\r\n'),
    Buffer.concat([
      Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n\r\n'),
      Buffer.alloc(MAX_CREality_JPEG_BYTES + 100),
    ]),
  ]) {
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'multipart/x-mixed-replace; boundary=frame',
      })
      res.end(payload)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address()
      assert(address && typeof address !== 'string')
      const frames = streamCrealityJpegs({
        host: '127.0.0.1',
        port: address.port,
        signal: new AbortController().signal,
        maxReconnects: 0,
      })
      await assert.rejects(frames.next(), /Creality camera unavailable/)
    } finally {
      server.close()
      await once(server, 'close')
    }
  }
})
