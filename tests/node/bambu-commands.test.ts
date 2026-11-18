import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:tls'
import { once } from 'node:events'
import {
  buildBambuCommand,
  supportedBambuActions,
} from '../../packages/connector/src/bambu/commands.ts'
import {
  packet,
  startBambuSimulator,
} from '../../packages/sim-tools/src/bambu-simulator.ts'

test('builds requests and rejects unsupported actions', () => {
  assert.deepEqual(
    buildBambuCommand('set_temperature', {
      heater: 'extruder',
      target_c: 200,
      sequence_id: '1',
    }),
    {
      print: { command: 'gcode_line', param: 'M104 S200\n', sequence_id: '1' },
    },
  )
  assert.deepEqual(buildBambuCommand('set_speed', { level: 'sport' }), {
    print: { command: 'print_speed', param: '3', sequence_id: '0' },
  })
  assert.ok(supportedBambuActions('X1').includes('start_print'))
  assert.throws(() => buildBambuCommand('emergency_stop', {}))
  assert.throws(() =>
    buildBambuCommand('set_temperature', { heater: 'chamber', target_c: 20 }),
  )
  assert.throws(() => buildBambuCommand('start_print', { file: '../x' }))
})

test('simulator applies extended requests', async () => {
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
    for (const [action, args] of [
      ['set_temperature', { heater: 'extruder', target_c: 200 }],
      ['set_fan', { fan: 'part', percent: 100 }],
      ['home', { axes: ['x', 'y'] }],
      ['set_light', { on: true }],
      ['set_speed', { level: 'sport' }],
      ['start_print', { file: 'test.3mf' }],
    ] as const) {
      socket.write(
        packet(
          48,
          Buffer.concat([
            size,
            topic,
            Buffer.from(JSON.stringify(buildBambuCommand(action, args))),
          ]),
        ),
      )
    }
    for (let i = 0; i < 100 && peer.requests.length < 6; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(peer.extendedState, {
      nozzle_temper: 210,
      bed_temper: 60,
      ams: {
        ams: [
          {
            id: 0,
            tray: [
              { id: 0, tray_type: 'PLA', tray_color: 'FFFFFFFF', remain: 100 },
            ],
          },
        ],
      },
      M104: 200,
      'M106 P1': 255,
      homed_axes: 'X Y',
      light: 'on',
      speed: '3',
      file: 'file:///sdcard/test.3mf',
      subtask_name: 'test.3mf',
      gcode_file: 'test.3mf',
    })
    assert.equal(peer.gcodeState, 'RUNNING')
  } finally {
    socket.destroy()
    await peer.close()
  }
})
