// SPDX-License-Identifier: MIT
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDecipheriv } from 'node:crypto'
import { createSyntheticDevice } from '../fixtures/kobralink-integration/device.ts'

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
