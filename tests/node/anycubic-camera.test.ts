// SPDX-License-Identifier: MIT
import { test } from 'node:test'
import type { CameraAccessUnit } from '../../packages/connector/src/camera/session.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  selectAnycubicCamera,
  selectAnycubicStream,
  streamAnycubicJpegs,
  type AnycubicCameraSource,
} from '../../packages/connector/src/anycubic/camera.ts'
import { openAnycubicCameraSource } from '../../packages/connector/src/anycubic/camera-media.ts'
import { createLocalCameraRegistry } from '../../packages/connector/src/camera/source-policy.ts'
import { startAnycubicCameraSim } from '../../packages/sim-tools/src/anycubic-camera-sim.ts'

const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9])
const auth = { username: 'local', password: 'secret:@password' }
const stock: AnycubicCameraSource = {
  kind: 'stock',
  host: '192.168.1.9',
  async startCapture() {
    return ''
  },
  async stopCapture() {},
}

test('selects documented Rinkhals and stock ports; rejects remote hosts and unsafe session URLs', () => {
  assert.deepEqual(
    selectAnycubicCamera({ kind: 'rinkhals', host: '192.168.1.9' }),
    { kind: 'mjpeg', host: '192.168.1.9', port: 8080 },
  )
  assert.deepEqual(selectAnycubicCamera(stock), {
    kind: 'stock',
    host: '192.168.1.9',
    port: 18088,
  })
  for (const url of [
    'http://192.168.1.9:18088/flv',
    'http://192.168.1.9:18088/live/session-token',
    'rtsp://user:secret@192.168.1.9:18088/live/stream',
  ])
    assert.equal(selectAnycubicStream(stock, url).hostname, '192.168.1.9')
  for (const url of [
    'http://8.8.8.8:18088/live/secret',
    'http://192.168.1.9/live/secret',
    'file:///secret',
    'http://192.168.1.9:18088/live/secret?redirect=x',
    'http://192.168.1.9:18088/live/secret\n',
  ])
    assert.throws(() => selectAnycubicStream(stock, url), {
      message: 'Invalid Anycubic camera stream',
    })
  for (const host of ['8.8.8.8', 'printer.local', '127.0.0.1/secret'])
    assert.throws(
      () => selectAnycubicCamera({ kind: 'rinkhals', host }),
      /configuration/,
    )
  assert.throws(
    () =>
      selectAnycubicCamera({
        kind: 'rinkhals',
        host: '127.0.0.1',
        auth: { username: 'a:b', password: 'secret' },
      }),
    /configuration/,
  )
})

test('loopback MJPEG authenticates, emits exact frames, reconnects, and aborts', async () => {
  const sim = await startAnycubicCameraSim({ jpeg, auth, failFirst: true })
  const controller = new AbortController()
  const frames = streamAnycubicJpegs({
    source: { kind: 'rinkhals', host: sim.host, port: sim.port, auth },
    signal: controller.signal,
    reconnectDelayMs: 1,
  })
  try {
    assert.deepEqual((await frames.next()).value, jpeg)
    assert.deepEqual((await frames.next()).value, jpeg)
    assert.equal(sim.requests, 2)
    assert.equal(sim.authenticated, 2)
    controller.abort()
    await frames.return(undefined)
  } finally {
    controller.abort()
    await frames.return(undefined)
    await sim.close()
  }
})

test('bad auth, malformed and oversized frames fail with redacted errors and bounded retries', async () => {
  for (const options of [
    { jpeg, auth },
    { jpeg, malformed: true },
    { jpeg: Buffer.alloc(4 * 1024 * 1024 + 100) },
  ]) {
    const sim = await startAnycubicCameraSim({ ...options, frameCount: 1 })
    try {
      const frames = streamAnycubicJpegs({
        source: { kind: 'rinkhals', host: sim.host, port: sim.port },
        signal: new AbortController().signal,
        maxReconnects: 1,
        reconnectDelayMs: 1,
      })
      await assert.rejects(frames.next(), {
        message: 'Anycubic camera unavailable',
      })
      assert.equal(sim.requests, 2)
      if ('auth' in options) assert.equal(sim.authenticated, 0)
    } finally {
      await sim.close()
    }
  }
})

test('opaque selection is bound to farm, agent and printer; no credentials enter registry', () => {
  const scope = { farmId: 'farm', agentId: 'agent', printerId: 'printer' }
  const registry = createLocalCameraRegistry([
    { cameraId: 'anycubic', scope, sourceHandle: 'anycubic-camera-0' },
  ])
  assert.equal(
    registry.resolve({ cameraId: 'anycubic', scope }),
    'anycubic-camera-0',
  )
  for (const key of ['farmId', 'agentId', 'printerId'])
    assert.equal(
      registry.resolve({
        cameraId: 'anycubic',
        scope: { ...scope, [key]: 'other' },
      }),
      undefined,
    )
  assert.equal(registry.resolve({ cameraId: 'secret', scope }), undefined)
})

test(
  'Rinkhals and stock FLV feed real H264 encoder; capture stops and restarts on reconnect',
  { timeout: 15000 },
  async () => {
    const path = execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim()
    const ffmpeg = {
      path,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    }
    const image = execFileSync(path, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=32x32',
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      'pipe:1',
    ])
    const flv = execFileSync(path, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=32x32:r=10',
      '-frames:v',
      '4',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-f',
      'flv',
      'pipe:1',
    ])
    for (const kind of ['rinkhals', 'stock'] as const) {
      const sim = await startAnycubicCameraSim({ jpeg: image, flv, auth })
      const controller = new AbortController()
      const source: AnycubicCameraSource =
        kind === 'rinkhals'
          ? { kind, host: sim.host, port: sim.port, auth }
          : {
              kind,
              host: sim.host,
              port: sim.port,
              startCapture: sim.startCapture,
              stopCapture: sim.stopCapture,
            }
      let iterator: AsyncIterator<CameraAccessUnit> | undefined
      try {
        const media = await openAnycubicCameraSource({
          source,
          ffmpeg,
          signal: controller.signal,
          isCurrent: () => true,
        })
        iterator = media[Symbol.asyncIterator]()
        const first = await iterator.next()
        assert.equal(first.done, false)
        assert.ok(first.value?.keyframe)
        assert.ok(first.value.data.length > 20)
        let previous = first.value.timestampUs
        for (let i = 0; i < (kind === 'stock' ? 5 : 1); i++) {
          const next: IteratorResult<CameraAccessUnit> = await iterator.next()
          assert.equal(next.done, false)
          assert.ok(next.value.timestampUs > previous)
          previous = next.value.timestampUs
        }
        assert.ok(sim.authenticated >= 1)
        if (kind === 'stock') assert.equal(sim.captures, 2)
      } finally {
        controller.abort()
        await iterator?.return?.()
        if (kind === 'stock') assert.equal(sim.stops, sim.captures)
        await sim.close()
      }
    }
  },
)

test('untrusted encoder and failed capture never expose credentials', async () => {
  await assert.rejects(
    openAnycubicCameraSource({
      source: stock,
      ffmpeg: { path: 'ffmpeg', sha256: '0'.repeat(64) },
      signal: new AbortController().signal,
      isCurrent: () => true,
    }),
    { message: 'Invalid Anycubic camera encoder' },
  )
})

test('failed activation and invalid reported destinations are redacted and release each capture', async () => {
  const path = execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim()
  const ffmpeg = {
    path,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }
  for (const failure of ['activation', 'destination', 'cleanup']) {
    let starts = 0
    let stops = 0
    const source: AnycubicCameraSource = {
      kind: 'stock',
      host: '127.0.0.1',
      async startCapture() {
        starts++
        if (failure === 'activation') throw Error('secret-session-credentials')
        return 'http://user:secret-session-credentials@8.8.8.8:18088/flv'
      },
      async stopCapture() {
        stops++
        if (failure === 'cleanup') throw Error('secret-session-credentials')
      },
    }
    const media = await openAnycubicCameraSource({
      source,
      ffmpeg,
      signal: new AbortController().signal,
      isCurrent: () => true,
    })
    await assert.rejects(media[Symbol.asyncIterator]().next(), {
      message:
        failure === 'cleanup'
          ? 'Anycubic camera capture cleanup failed'
          : 'Anycubic camera unavailable',
    })
    assert.equal(starts, failure === 'cleanup' ? 1 : 4)
    assert.equal(stops, starts)
  }
})

test('aborted and revoked admissions never activate stock capture', async () => {
  const path = execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim()
  const ffmpeg = {
    path,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }
  for (const aborted of [false, true]) {
    let starts = 0
    const controller = new AbortController()
    if (aborted) controller.abort()
    const media = await openAnycubicCameraSource({
      source: {
        ...stock,
        async startCapture() {
          starts++
          throw Error('unexpected')
        },
      },
      ffmpeg,
      signal: controller.signal,
      isCurrent: () => aborted,
    })
    assert.equal((await media[Symbol.asyncIterator]().next()).done, true)
    assert.equal(starts, 0)
  }
})
