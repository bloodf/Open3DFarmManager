import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:tls'
import { once } from 'node:events'
import { buildBambuFilamentCommand } from '../../packages/connector/src/bambu/filament.ts'
import {
  packet,
  startBambuSimulator,
} from '../../packages/sim-tools/src/bambu-simulator.ts'

test('builds AMS load and unload requests and validates inputs', () => {
  assert.deepEqual(buildBambuFilamentCommand(15, 220, '1'), {
    print: {
      command: 'ams_change_filament',
      ams_id: 3,
      target: 15,
      slot_id: 3,
      curr_temp: 220,
      tar_temp: 220,
      sequence_id: '1',
    },
  })
  assert.equal(buildBambuFilamentCommand(255, 200).print.target, 255)
  for (const target of [-1, 16, 254, 256, 1.5])
    assert.throws(() => buildBambuFilamentCommand(target, 200))
  assert.throws(() => buildBambuFilamentCommand(0, 301))
  assert.throws(() => buildBambuFilamentCommand(0, 200, 'bad'))
})

test('simulator applies load and unload', async () => {
  const peer = await startBambuSimulator({ initialState: 'IDLE' })
  const socket = connect({
    host: peer.host,
    port: peer.port,
    ca: peer.syntheticTrust,
  })
  try {
    await once(socket, 'secureConnect')
    const connected = once(socket, 'data')
    socket.write(
      Buffer.from([16, 13, 0, 4, 77, 81, 84, 84, 4, 2, 0, 10, 0, 1, 120]),
    )
    await connected
    const topic = Buffer.from('device/SYNTHETIC/request')
    const size = Buffer.alloc(2)
    size.writeUInt16BE(topic.length)
    for (const target of [0, 15, 255]) {
      socket.write(
        packet(
          48,
          Buffer.concat([
            size,
            topic,
            Buffer.from(JSON.stringify(buildBambuFilamentCommand(target, 220))),
          ]),
        ),
      )
      for (
        let i = 0;
        i < 100 && peer.requests.length < [0, 15, 255].indexOf(target) + 1;
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 10))
      const ams = peer.extendedState.ams as { tray_now?: string }
      assert.equal(ams.tray_now, String(target))
    }
  } finally {
    socket.destroy()
    await peer.close()
  }
})
