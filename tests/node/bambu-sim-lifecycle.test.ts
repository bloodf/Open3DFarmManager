import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:tls'
import { once } from 'node:events'
import {
  packet,
  startBambuSimulator,
} from '../../packages/sim-tools/src/bambu-simulator.ts'

test('uploaded prints progress, complete, cancel and fail', async () => {
  const peer = await startBambuSimulator({
    initialState: 'IDLE',
    printDurationMs: 200,
    totalLayers: 10,
  })
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
    const send = (command: string) =>
      socket.write(
        packet(
          48,
          Buffer.concat([
            size,
            topic,
            Buffer.from(
              JSON.stringify({
                print: {
                  command,
                  sequence_id: '1',
                  param: 'Metadata/plate_1.gcode',
                  url: 'file:///sdcard/test.3mf',
                },
              }),
            ),
          ]),
        ),
      )
    const wait = async (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms))
    peer.uploadFile('test.3mf', Buffer.from('fixture'))
    send('project_file')
    await wait(90)
    assert.equal(peer.gcodeState, 'RUNNING')
    assert.ok(Number(peer.extendedState.mc_percent) > 0)
    assert.ok(Number(peer.extendedState.layer_num) > 0)
    await wait(200)
    assert.equal(peer.gcodeState, 'FINISH')
    assert.equal(peer.extendedState.mc_percent, 100)
    assert.equal(peer.extendedState.layer_num, 10)
    send('project_file')
    await wait(30)
    send('stop')
    await wait(250)
    assert.equal(peer.gcodeState, 'IDLE')
    send('project_file')
    await wait(30)
    peer.failPrint()
    await wait(250)
    assert.equal(peer.gcodeState, 'FAILED')
  } finally {
    socket.destroy()
    await peer.close()
  }
})

test('a print already running reports its seeded layer', async () => {
  const peer = await startBambuSimulator({
    initialState: 'RUNNING',
    initialLayer: 25,
    totalLayers: 100,
  })
  try {
    assert.equal(peer.extendedState.layer_num, 25)
    assert.equal(peer.extendedState.total_layer_num, 100)
  } finally {
    await peer.close()
  }
  await assert.rejects(
    startBambuSimulator({ initialState: 'IDLE', initialLayer: 1 }),
    /Invalid initial layer/,
  )
  await assert.rejects(
    startBambuSimulator({
      initialState: 'RUNNING',
      initialLayer: 11,
      totalLayers: 10,
    }),
    /Invalid initial layer/,
  )
})
