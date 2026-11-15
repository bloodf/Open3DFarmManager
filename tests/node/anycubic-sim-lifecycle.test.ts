import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { connect } from 'node:tls'
import { setTimeout as delay } from 'node:timers/promises'
import {
  packet,
  startAnycubicSimulator,
} from '../../packages/sim-tools/src/anycubic-simulator.ts'
import { startAnycubicPrint } from '../../packages/connector/src/anycubic/files.ts'

async function eventually(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await delay(10)
  }
  assert.fail('Timed out waiting for simulator')
}

test('synthetic upload, start, progress, completion, cancellation and failure', async () => {
  const sim = await startAnycubicSimulator({
    serial: 'TEST',
    printDurationMs: 300,
    totalLayers: 20,
  })
  const socket = connect({
    host: sim.host,
    port: sim.port,
    ca: sim.syntheticTrust,
  })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', resolve)
      socket.once('error', reject)
    })
    socket.write(
      packet(
        16,
        Buffer.concat([Buffer.from('00044d51545404020000000474657374', 'hex')]),
      ),
    )
    await new Promise<void>((resolve) => socket.once('data', () => resolve()))
    const publish = async (topic: string, payload: string) => {
      const name = Buffer.from(topic)
      const length = Buffer.alloc(2)
      length.writeUInt16BE(name.length)
      socket.write(
        packet(48, Buffer.concat([length, name, Buffer.from(payload)])),
      )
    }
    const start = () =>
      startAnycubicPrint({
        transport: { publish },
        model: '20024',
        deviceId: 'TEST',
        filename: 'part.gcode',
        signal: new AbortController().signal,
      })
    const command = (action: string) =>
      publish(
        'anycubic/anycubicCloud/v1/printer/public/TEST/print/request',
        JSON.stringify({ type: 'print', action }),
      )
    sim.upload('part.gcode', Buffer.from('G28\n'))
    await start()
    await eventually(() => sim.lifecycle.progress > 0)
    assert.equal(sim.lifecycle.state, 'printing')
    await eventually(() => sim.lifecycle.state === 'finished')
    assert.deepEqual(sim.lifecycle, {
      state: 'finished',
      progress: 100,
      currentLayer: 20,
      totalLayers: 20,
    })
    await start()
    await eventually(() => sim.lifecycle.state === 'printing')
    await command('stop')
    await eventually(() => sim.lifecycle.state === 'idle')
    await delay(350)
    assert.equal(sim.lifecycle.state, 'idle')
    await start()
    await eventually(() => sim.lifecycle.state === 'printing')
    sim.failPrint()
    await delay(350)
    assert.equal(sim.lifecycle.state, 'error')
  } finally {
    socket.destroy()
    await sim.close()
  }
})
