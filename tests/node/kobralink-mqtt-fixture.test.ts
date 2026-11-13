// SPDX-License-Identifier: MIT
import test from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { once } from 'node:events'
import { createSyntheticMqtt } from '../fixtures/kobralink-integration/mqtt.ts'

test('real synthetic MQTT socket handshake and shutdown', async () => {
  const fixture = createSyntheticMqtt()
  const address = await fixture.start()
  assert.ok(address && typeof address !== 'string')
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const socket = connect(address.port, '127.0.0.1')
      await once(socket, 'connect')
      const response = once(socket, 'data')
      socket.write(
        Buffer.from([16, 13, 0, 4, 77, 81, 84, 84, 4, 2, 0, 10, 0, 1, 120]),
      )
      assert.deepEqual((await response)[0], Buffer.from([32, 2, 0, 0]))
      const status = once(socket, 'data')
      socket.write(Buffer.from([130, 6, 0, 1, 0, 1, 115, 0]))
      assert.ok(
        Buffer.from((await status)[0]).includes(Buffer.from('SYNTHETIC')),
      )
      socket.destroy()
      await once(socket, 'close')
    }
  } finally {
    await fixture.stop()
  }
})
