// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import { get, request, type IncomingMessage } from 'node:http'
import test, { type TestContext } from 'node:test'
import { connect, type MqttClient } from 'mqtt'
import { openAnycubicCameraSource } from '../../packages/connector/src/anycubic/camera-media.ts'
import { connectKobraX } from '../../packages/connector/src/kobra-x/index.ts'
import { createFakeEncoder } from '../helpers/camera-encoder.ts'
import { startKobraXMock } from '../../packages/sim-tools/src/mocks/kobra-x-mock.ts'

type Mock = Awaited<ReturnType<typeof startKobraXMock>>

async function open(t: TestContext, captureGatedFlv: boolean) {
  const mock = await startKobraXMock({
    ssdp: false,
    reportIntervalMs: 0,
    captureGatedFlv,
  })
  t.after(() => mock.close())
  const { username, password } = mock.credentials
  const client = connect({
    host: '127.0.0.1',
    port: mock.mqttPort,
    protocol: 'mqtts',
    username,
    password,
    cert: mock.tls.clientCert,
    key: mock.tls.clientKey,
    rejectUnauthorized: false,
    reconnectPeriod: 0,
  })
  t.after(() => client.endAsync(true))
  const reports: { type: string; action: string; msgid: string; data: any }[] =
    []
  client.on('message', (_topic, payload) => {
    reports.push(JSON.parse(payload.toString()))
  })
  await new Promise<void>((resolve, reject) => {
    client.once('error', reject)
    client.once('connect', () =>
      client.subscribe('anycubic/anycubicCloud/v1/#', (error) =>
        error ? reject(error) : resolve(),
      ),
    )
  })
  return { mock, client, reports }
}

async function sendVideo(
  mock: Mock,
  client: MqttClient,
  reports: { type: string; action: string; msgid: string; data: any }[],
  action: 'startCapture' | 'stopCapture' | 'report',
  type: 'video' | 'info' = 'video',
) {
  const before = reports.filter(
    (r) => r.type === type && r.action === action,
  ).length
  client.publish(
    `anycubic/anycubicCloud/v1/slicer/printer/${mock.credentials.modeId}/${mock.credentials.deviceId}/${type}`,
    JSON.stringify({
      type,
      action,
      msgid: `capture-${action}-${before}`,
      timestamp: Date.now(),
      data: null,
    }),
  )
  for (let i = 0; i < 100; i++) {
    const found = reports.filter((r) => r.type === type && r.action === action)
    if (found.length > before) return found.at(-1)!
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`No video/${action} report`)
}

function status(url: string, method = 'GET'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

function stream(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => get(url, resolve).on('error', reject))
}

function closed(res: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    res.on('error', () => {})
    res.once('close', resolve)
    res.resume()
  })
}

function tokenOf(url: string) {
  return new URL(url).pathname.replace('/live/', '')
}

test('default Kobra X camera stays always live and ignores capture', async (t) => {
  const { mock, client, reports } = await open(t, false)
  assert.ok(mock.flvUrl)
  assert.equal(mock.camera?.capture.gated, false)
  assert.equal(await status(mock.flvUrl!, 'GET'), 200)
  const started = await sendVideo(mock, client, reports, 'startCapture')
  // Legacy flat shape is preserved.
  assert.equal(started.data.rtspUrl, mock.flvUrl)
  assert.equal(started.data.urls, undefined)
  assert.equal(await status(mock.flvUrl!), 200)
  const info = await sendVideo(mock, client, reports, 'report', 'info')
  assert.equal(info.data.urls.rtspUrl, mock.flvUrl)
})

test('gated FLV is dark until startCapture issues a distinct synthetic token', async (t) => {
  const { mock, client, reports } = await open(t, true)
  const camera = mock.camera!
  assert.equal(mock.flvUrl, undefined)
  assert.equal(camera.flvUrl, undefined)
  assert.equal(mock.ports.flv, Number(new URL(camera.flvBase).port))
  assert.equal(camera.capture.active(), false)
  // Nothing is announced and neither the credential token nor a guess plays.
  const dark = await sendVideo(mock, client, reports, 'report', 'info')
  assert.deepEqual(dark.data.urls, {})
  assert.equal(
    await status(`${camera.flvBase}/live/${mock.credentials.token}`),
    403,
  )
  assert.equal(await status(`${camera.flvBase}/live/guess`), 403)

  const started = await sendVideo(mock, client, reports, 'startCapture')
  const url = started.data.urls.rtspUrl as string
  assert.equal(started.data.active, true)
  assert.equal(started.data.rtspUrl, undefined)
  const parsed = new URL(url)
  assert.equal(parsed.protocol, 'http:')
  assert.equal(parsed.hostname, '127.0.0.1')
  assert.equal(parsed.port, String(mock.ports.flv))
  assert.match(parsed.pathname, /^\/live\/capture-[0-9a-f]{16}$/)
  const token = tokenOf(url)
  assert.notEqual(token, mock.credentials.token)
  assert.equal(camera.capture.token(), token)
  const live = await sendVideo(mock, client, reports, 'report', 'info')
  assert.equal(live.data.urls.rtspUrl, url)

  // Request shape: only GET on the issued path plays.
  const res = await stream(url)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'video/x-flv')
  const head = await new Promise<Buffer>((resolve) => res.once('data', resolve))
  assert.equal(head.subarray(0, 3).toString('latin1'), 'FLV')
  assert.equal(camera.capture.openStreams(), 1)
  assert.equal(await status(url, 'POST'), 405)
  assert.equal(await status(`${url}x`), 403)
  assert.equal(await status(`${camera.flvBase}/live`), 403)
  assert.equal(await status(`${camera.flvBase}/${token}`), 403)
  assert.equal(
    await status(`${camera.flvBase}/live/${mock.credentials.token}`),
    403,
  )

  // startCapture is idempotent while active and reuses the session token.
  const again = await sendVideo(mock, client, reports, 'startCapture')
  assert.equal(again.data.urls.rtspUrl, url)
  assert.deepEqual(camera.capture.counts(), {
    starts: 2,
    stops: 0,
    accepted: 1,
    rejected: 5 + 2,
    closed: 0,
  })
  assert.deepEqual(
    camera.capture
      .requests()
      .filter((r) => r.status === 200)
      .map((r) => `${r.method} ${r.url}`),
    [`GET /live/${token}`],
  )
  res.destroy()
})

test('stopCapture closes open FLV responses and rejects the stale token', async (t) => {
  const { mock, client, reports } = await open(t, true)
  const camera = mock.camera!
  const first = (await sendVideo(mock, client, reports, 'startCapture')).data
    .urls.rtspUrl as string
  const a = await stream(first)
  const b = await stream(first)
  assert.equal(a.statusCode, 200)
  assert.equal(b.statusCode, 200)
  assert.equal(camera.capture.openStreams(), 2)
  const aClosed = closed(a)
  const bClosed = closed(b)

  const stopped = await sendVideo(mock, client, reports, 'stopCapture')
  assert.equal(stopped.data.active, false)
  assert.equal(stopped.data.urls.rtspUrl, undefined)
  await Promise.all([aClosed, bClosed])
  assert.equal(camera.capture.openStreams(), 0)
  assert.equal(camera.capture.active(), false)
  assert.equal(camera.capture.counts().closed, 2)
  assert.equal(await status(first), 403)

  // A new session gets a new token; the stale one stays rejected.
  const second = (await sendVideo(mock, client, reports, 'startCapture')).data
    .urls.rtspUrl as string
  assert.notEqual(tokenOf(second), tokenOf(first))
  assert.equal(await status(first), 403)
  assert.equal(await status(second), 200)
  const counts = camera.capture.counts()
  assert.equal(counts.starts, 2)
  assert.equal(counts.stops, 1)
})

test('mock close tears down open gated FLV streams and the port', async () => {
  const mock = await startKobraXMock({
    ssdp: false,
    reportIntervalMs: 0,
    captureGatedFlv: true,
  })
  const camera = mock.camera!
  const url = camera.capture.start().url
  const res = await stream(url)
  assert.equal(res.statusCode, 200)
  const gone = closed(res)
  await mock.close()
  await gone
  await assert.rejects(status(url))
})

test('another MQTT client retains its capture through Connector camera failure and shutdown', async (t) => {
  const { mock, client, reports } = await open(t, true)
  const camera = mock.camera!
  const adapter = await connectKobraX({
    address: '127.0.0.1',
    printerKey: 'kobra-x-competing-client',
    httpPort: mock.httpPort,
    mqttPort: mock.mqttPort,
    pinSha256: mock.tls.serverFingerprintSha256!,
    clientIdentity: { cert: mock.tls.clientCert, key: mock.tls.clientKey },
  })
  t.after(() => adapter.close())

  const report = await sendVideo(mock, client, reports, 'startCapture')
  assert.notEqual(report.msgid, 'capture-startCapture-0')
  const url = report.data.urls.rtspUrl as string
  assert.equal(typeof url, 'string')
  const peerStream = await stream(url)
  assert.equal(peerStream.statusCode, 200)
  const peerClosed = closed(peerStream)

  // Info reports can mirror another client's token. Only the configured
  // passive path is ever fetched, even after an uncorrelated report arrives.
  const info = await sendVideo(mock, client, reports, 'report', 'info')
  assert.equal(info.data.urls.rtspUrl, url)
  const encoder = createFakeEncoder([url, tokenOf(url)])
  t.after(() => encoder.dispose())
  for (let admission = 0; admission < 2; admission++) {
    const source = await openAnycubicCameraSource({
      source: {
        kind: 'kobra-x-flv',
        host: '127.0.0.1',
        port: mock.ports.flv!,
        path: '/flv',
      },
      ffmpeg: encoder.ffmpeg,
      signal: t.signal,
      isCurrent: () => true,
    })
    await assert.rejects(async () => {
      for await (const _ of source) assert.fail('Unexpected video')
    }, /Anycubic camera unavailable/)
  }
  await adapter.close()

  const commands = mock.calls.all.filter(({ topic }) =>
    topic.endsWith('/video'),
  )
  assert.deepEqual(
    commands.map(({ payload }) => JSON.parse(payload.toString()).action),
    ['startCapture'],
  )
  assert.equal(camera.capture.active(), true)
  assert.equal(camera.capture.openStreams(), 1)
  assert.deepEqual(camera.capture.counts(), {
    starts: 1,
    stops: 0,
    accepted: 1,
    rejected: 2,
    closed: 0,
  })
  await sendVideo(mock, client, reports, 'stopCapture')
  await peerClosed
  assert.equal(camera.capture.openStreams(), 0)
})
