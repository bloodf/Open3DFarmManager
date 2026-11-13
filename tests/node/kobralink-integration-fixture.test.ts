// SPDX-License-Identifier: MIT
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDecipheriv } from 'node:crypto'
import { once } from 'node:events'
import { connect } from 'node:tls'
import { createSyntheticDevice } from '../fixtures/kobralink-integration/device.ts'
import { createSyntheticMqtt } from '../fixtures/kobralink-integration/mqtt.ts'
import {
  mqttField,
  mqttPacket,
} from '../fixtures/kobralink-integration/mqtt-wire.ts'
import { createSyntheticTls } from '../fixtures/kobralink-integration/tls.ts'

test('synthetic discovery returns fresh encrypted identity and refuses actuator routes', async () => {
  const fixture = createSyntheticDevice()
  fixture.server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) =>
    fixture.server.once('listening', resolve),
  )
  try {
    const address = fixture.server.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const info = await (await fetch(origin + '/info')).json()
    assert.equal(typeof info.token, 'string')
    const response = await fetch(
      origin +
        '/ctrl?ts=1700000000000&nonce=ABC123&sign=' +
        'a'.repeat(32) +
        '&did=random',
      { method: 'POST' },
    )
    const wire = await response.json()
    const decipher = createDecipheriv(
      'aes-128-cbc',
      Buffer.from(info.token.slice(16)),
      Buffer.from(wire.data.token),
    )
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(wire.data.info, 'base64')),
      decipher.final(),
    ])
    assert.deepEqual(JSON.parse(plaintext.toString()), fixture.credentials)
    assert.match(fixture.credentials.deviceId, /^OPENFARM_SYNTHETIC_/)
    assert.notEqual(
      createSyntheticDevice().credentials.password,
      fixture.credentials.password,
    )
    for (const route of ['/pause', '/start', '/upload', '/camera']) {
      assert.equal(
        (await fetch(origin + route, { method: 'POST' })).status,
        404,
      )
    }
    assert.equal(
      (await fetch(origin + '/ctrl', { method: 'POST' })).status,
      400,
    )
  } finally {
    await new Promise<void>((resolve, reject) =>
      fixture.server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

test('discovered synthetic credentials open the synthetic MQTT session', async () => {
  const device = createSyntheticDevice()
  const mqtt = createSyntheticMqtt(createSyntheticTls(), {
    identity: device.credentials,
  })
  const { port } = await mqtt.start()
  try {
    const socket = connect({
      port,
      host: '127.0.0.1',
      rejectUnauthorized: false,
    })
    socket.on('error', () => {})
    const { username, password } = device.credentials
    socket.write(
      mqttPacket(
        0x10,
        Buffer.concat([
          mqttField('MQTT'),
          Buffer.from([4, 0xc2, 0, 60]),
          mqttField('kobrax_node'),
          mqttField(username),
          mqttField(password),
        ]),
      ),
    )
    const [connack] = await once(socket, 'data', {
      signal: AbortSignal.timeout(3000),
    })
    assert.deepEqual(connack, Buffer.from([0x20, 2, 0, 0]))
    assert.equal(
      mqtt.subscribeFilter,
      `anycubic/anycubicCloud/v1/printer/public/${device.credentials.modeId}/${device.credentials.deviceId}/#`,
    )
    socket.destroy()
    await mqtt.whenSessions(0, 3000)
  } finally {
    await mqtt.stop()
  }
})
