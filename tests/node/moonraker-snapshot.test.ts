// SPDX-License-Identifier: MIT
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createCameraServer } from '../../packages/sim-cams/src/server.ts'
import {
  CameraFixture,
  cameraRuntimeSection,
} from '../helpers/signalling-camera-fixture.ts'
import { parseCameraRuntimeConfig } from '../../packages/connector/src/config/camera.ts'
import {
  createMoonrakerSnapshotSource,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_INTERVAL_MS,
} from '../../packages/connector/src/moonraker/snapshot.ts'

async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}
async function close(server: Server) {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()))
  server.closeAllConnections()
  await closed
}
const signal = () => new AbortController().signal

test('sim-cams snapshot is read without an RTSP source; immediate requests are rate limited', async () => {
  const sim = await createCameraServer()
  try {
    const origin = await listen(sim.server)
    const source = createMoonrakerSnapshotSource({
      webcamOrigin: origin,
      snapshotUrl: '/?action=snapshot',
    })
    const expected = await readFile(
      new URL(
        '../../packages/sim-cams/fixtures/test-pattern.jpg',
        import.meta.url,
      ),
    )
    const before = performance.now()
    const first = source.read(signal())
    await assert.rejects(source.read(signal()), /rate limit/)
    assert.deepEqual(await first, expected)
    const frames = source.stream(signal())
    for (let index = 0; index < 8; index++) {
      assert.deepEqual((await frames.next()).value, expected)
      assert.ok(
        performance.now() - before >= SNAPSHOT_INTERVAL_MS * (index + 1) - 100,
      )
    }
    await frames.return(undefined)
    assert.equal(sim.activeStreams, 0)
  } finally {
    await sim.close()
  }
})

for (const mode of [
  'declared oversize',
  'streamed oversize',
  'slow headers',
  'slow body',
  'non-JPEG type',
  'non-JPEG bytes',
  'forged JPEG markers',
  'redirect',
]) {
  test(`rejects ${mode}`, async () => {
    const server = createServer((_req, res) => {
      if (mode === 'slow headers') return
      if (mode === 'redirect') {
        res.writeHead(302, { location: 'http://127.0.0.1:1/' }).end()
        return
      }
      res.setHeader(
        'Content-Type',
        mode === 'non-JPEG type' ? 'text/html' : 'image/jpeg',
      )
      if (mode === 'declared oversize')
        res.setHeader('Content-Length', SNAPSHOT_MAX_BYTES + 1)
      res.flushHeaders()
      if (mode === 'slow body') {
        res.write(Buffer.from([255, 216]))
        return
      }
      res.end(
        mode === 'forged JPEG markers'
          ? Buffer.from([255, 216, 1, 2, 255, 217])
          : mode.includes('oversize')
            ? Buffer.alloc(SNAPSHOT_MAX_BYTES + 1)
            : Buffer.from('not a JPEG'),
      )
    })
    try {
      const origin = await listen(server)
      const source = createMoonrakerSnapshotSource({
        webcamOrigin: origin,
        snapshotUrl: '/snapshot',
      })
      const before = performance.now()
      await assert.rejects(source.read(signal()))
      assert.ok(performance.now() - before < 4000)
    } finally {
      await close(server)
    }
  })
}

test('rejects foreign URLs, credentials, invalid origins and aborted reads', async () => {
  for (const snapshotUrl of [
    'http://other.test/snapshot',
    '//other.test/snapshot',
    'http://u:p@127.0.0.1/snapshot',
  ])
    assert.throws(() =>
      createMoonrakerSnapshotSource({
        webcamOrigin: 'http://127.0.0.1',
        snapshotUrl,
      }),
    )
  assert.throws(() =>
    createMoonrakerSnapshotSource({
      webcamOrigin: 'file:///tmp/a',
      snapshotUrl: '/snapshot',
    }),
  )
  const source = createMoonrakerSnapshotSource({
    webcamOrigin: 'http://127.0.0.1',
    snapshotUrl: '/snapshot',
  })
  await assert.rejects(source.read(AbortSignal.abort()))
})

test('snapshot configuration is local, bounded and exclusive with RTSP', () => {
  const assignmentId = '11111111-1111-4111-8111-111111111111'
  const executable = { path: '/usr/bin/ffmpeg', sha256: 'a'.repeat(64) }
  const source = {
    kind: 'moonraker-snapshot',
    address: '127.0.0.1',
    port: 8112,
    path: '/?action=snapshot',
    ffmpeg: executable,
  }
  const config = (value: unknown) =>
    parseCameraRuntimeConfig(
      {
        helper: executable,
        cameras: [{ cameraId: 'cam', assignmentId, source: value }],
      },
      [assignmentId],
    )
  assert.equal(config(source).cameras[0]?.source.path, '/?action=snapshot')
  for (const patch of [
    { address: '8.8.8.8' },
    { path: '//foreign/snapshot' },
    { path: '/s#fragment' },
    { rtsp: 'rtsp://localhost' },
    { ffmpeg: undefined },
  ])
    assert.throws(() => config({ ...source, ...patch }))
})

test('farm acceptance fixture selects the snapshot runtime without RTSP', () => {
  const fixture = CameraFixture.parse({
    kind: 'moonraker-snapshot',
    helperPath: '/usr/bin/ffmpeg',
    helperSha256: 'a'.repeat(64),
    snapshotPort: 34567,
  })
  const assignmentId = '11111111-1111-4111-8111-111111111111'
  const runtime = parseCameraRuntimeConfig(
    cameraRuntimeSection(fixture, assignmentId),
    [assignmentId],
  )
  assert.deepEqual(runtime.cameras[0]?.source, {
    kind: 'moonraker-snapshot',
    address: '127.0.0.1',
    port: 34567,
    path: '/?action=snapshot',
    ffmpeg: { path: '/usr/bin/ffmpeg', sha256: 'a'.repeat(64) },
  })
})
