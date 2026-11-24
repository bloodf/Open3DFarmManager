// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import {
  createCipheriv,
  createHash,
  randomBytes,
  X509Certificate,
} from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { connectKobraX } from '../../packages/connector/src/kobra-x/index.ts'
import {
  generateThrowawayTls,
  installNetworkGuard,
  startHttpMock,
  startMqttBroker,
  uninstallNetworkGuard,
} from '../../packages/sim-tools/src/mocks/index.ts'
import fixture from '../fixtures/anycubic/kobra-x-orca-lan.json' with { type: 'json' }

test('Kobra X reference LAN login and status over pinned mutual TLS', async (t) => {
  installNetworkGuard()
  t.after(uninstallNetworkGuard)
  const tls = generateThrowawayTls()
  t.after(tls.cleanup)
  const auth = {
    username: randomBytes(12).toString('hex'),
    password: randomBytes(16).toString('hex'),
  }
  const token = randomBytes(16).toString('hex')
  const iv = randomBytes(8).toString('hex')
  const cipher = createCipheriv('aes-128-cbc', token.slice(16), iv)
  const encrypted = Buffer.concat([
    cipher.update(
      JSON.stringify({
        ...auth,
        deviceId: fixture.deviceId,
        modeId: fixture.modelId,
      }),
    ),
    cipher.final(),
  ]).toString('base64')
  const http = await startHttpMock({
    routes: {
      '/info': (_req, res) => {
        res.end(
          JSON.stringify({
            ctrlType: 'lan',
            modelId: fixture.modelId,
            deviceName: 'Kobra X fixture',
            token,
          }),
        )
      },
      '/ctrl': (_req, res) => {
        res.end(
          JSON.stringify({ code: 200, data: { token: iv, info: encrypted } }),
        )
      },
    },
  })
  t.after(() => http.close())
  const clientFingerprint = new X509Certificate(tls.client.cert).fingerprint256
  const publishPrefix =
    'anycubic/anycubicCloud/v1/slicer/printer/20030/fixture-kobra-x/'
  const reportPrefix = fixture.subscription.slice(0, -1)
  const broker = await startMqttBroker({
    tls,
    requestCert: true,
    rejectUnauthorized: true,
    strictConnect: true,
    auth,
    authorizeSubscribe: (topic, qos, socket) =>
      topic === fixture.subscription &&
      qos === 0 &&
      socket.authorized &&
      socket.getPeerCertificate().fingerprint256 === clientFingerprint &&
      ['TLSv1.2', 'TLSv1.3'].includes(socket.getProtocol() ?? ''),
    onPublish({ topic, payload, qos }) {
      const type = topic.slice(publishPrefix.length)
      if (
        !topic.startsWith(publishPrefix) ||
        qos !== 0 ||
        !Object.hasOwn(fixture.reports, type)
      )
        return
      const report = fixture.reports[type as keyof typeof fixture.reports]
      const { msgid } = JSON.parse(payload.toString())
      broker.control.publish(`${reportPrefix}${type}/report`, {
        ...report,
        msgid,
      })
    },
  })
  t.after(() => broker.close())

  const started = Date.now()
  const options = {
    address: '127.0.0.1',
    printerKey: 'kobra-x-orca-lan',
    httpPort: http.ports.http,
    mqttPort: broker.ports.mqtt,
    clientIdentity: { cert: tls.client.cert, key: tls.client.key },
    expectedIdentity: { deviceId: fixture.deviceId, modelId: fixture.modelId },
    pinSha256: new X509Certificate(tls.server.cert).fingerprint256,
    reconnectMs: 0,
  }
  const adapter = await connectKobraX(options)
  t.after(() => adapter.close())
  assert.deepEqual(adapter.identity, {
    ...options.expectedIdentity,
    name: 'Kobra X fixture',
  })
  assert.deepEqual(
    http.calls.all.map(({ method, url }) => [method, url.split('?')[0]]),
    [
      ['GET', '/info'],
      ['POST', '/ctrl'],
    ],
  )
  const ctrl = http.calls.all[1]!
  const params = new URL(ctrl.url, http.origin).searchParams
  assert.deepEqual([...params.keys()].sort(), ['did', 'nonce', 'sign', 'ts'])
  assert.equal(params.get('did'), 'random')
  assert.match(params.get('nonce') ?? '', /^[A-Za-z0-9]{6}$/)
  assert.match(params.get('ts') ?? '', /^\d+$/)
  assert.ok(
    Number(params.get('ts')) >= started &&
      Number(params.get('ts')) <= Date.now(),
  )
  assert.ok(ctrl.body)
  assert.equal(ctrl.body.length, 0)
  const seed = createHash('md5').update(token.slice(0, 16)).digest('hex')
  assert.equal(
    params.get('sign'),
    createHash('md5')
      .update(`${seed}${params.get('ts')}${params.get('nonce')}`)
      .digest('hex'),
  )

  const infoQueries = () =>
    broker.calls.all.filter(({ topic }) => topic === `${publishPrefix}info`)
  // The print reply triggers the second info query asynchronously.
  for (
    let i = 0;
    i < 100 && (adapter.facts().boxes.length === 0 || infoQueries().length < 2);
    i++
  )
    await delay(20)
  const queryMessages = broker.calls.all.filter(({ topic }) =>
    topic.startsWith(publishPrefix),
  )
  const order = queryMessages.map(({ topic }) =>
    topic.slice(publishPrefix.length),
  )
  for (const expected of fixture.queries) {
    const messages = queryMessages.filter(
      ({ topic }) => topic === publishPrefix + expected.type,
    )
    // The connection asks for each state once. A correlated print reply then
    // asks for info again, so a busy info reply is never judged against a
    // cached phase: that is the only repeated query.
    assert.equal(
      messages.length,
      expected.type === 'info' ? 2 : 1,
      expected.type,
    )
    assert.equal(
      new Set(
        messages.map(({ payload }) => JSON.parse(payload.toString()).msgid),
      ).size,
      messages.length,
      `${expected.type} requests carry distinct msgids`,
    )
    for (const { payload, qos } of messages) {
      const { msgid, timestamp, ...request } = JSON.parse(payload.toString())
      assert.equal(qos, 0)
      assert.match(msgid, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/)
      assert.deepEqual(request, expected)
      assert.ok(
        Number.isInteger(timestamp) &&
          timestamp >= started &&
          timestamp <= Date.now(),
        expected.type,
      )
    }
  }
  // The second info query follows the print query that triggered it.
  assert.ok(order.lastIndexOf('info') > order.indexOf('print'))
  const snapshot = adapter.snapshot()
  assert.equal(snapshot.state, 'printing')
  assert.equal(snapshot.filename, 'fixture-part.gcode')
  assert.equal(snapshot.progress, 0.42)
  assert.equal(snapshot.toolTemperatureCelsius, 199)
  assert.equal(snapshot.bedTemperatureCelsius, 48)
  assert.equal(snapshot.firmware?.current, '2.0.2.8')
  assert.deepEqual(
    adapter.facts().boxes.map(({ id, slots }) => [id, slots[0]?.materialType]),
    [
      [-1, 'PLA'],
      [0, 'PETG'],
    ],
  )

  await assert.rejects(
    connectKobraX({ ...options, pinSha256: randomBytes(32).toString('hex') }),
    { name: 'PinMismatch' },
  )
  assert.equal(broker.calls().CONNECT, 1)
})
