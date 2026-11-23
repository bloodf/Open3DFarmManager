import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createCrealityTelemetryClient,
  decodeCrealityStatus,
} from '../../packages/connector/src/creality/index.ts'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'

test('decodes printing, idle, error and partial frames defensively', () => {
  assert.deepEqual(
    decodeCrealityStatus(
      JSON.stringify({
        state: 1,
        nozzleTemp: 210,
        nozzleTemp2: 220,
        bedTemp: 60,
        bedTemp2: 65,
        printProgress: 42,
        print: 'part.gcode',
        layer: 12,
        unknown: true,
      }),
    ),
    {
      state: 'printing',
      nozzleTemp: 210,
      nozzleTarget: 220,
      bedTemp: 60,
      bedTarget: 65,
      progress: 42,
      filename: 'part.gcode',
      layer: 12,
    },
  )
  assert.deepEqual(decodeCrealityStatus('{"state":0}'), { state: 'idle' })
  assert.deepEqual(decodeCrealityStatus('{"state":1,"err":4}'), {
    state: 'error',
  })
  assert.deepEqual(
    decodeCrealityStatus('{"bedTemp":23,"printProgress":101,"layer":1.5}'),
    { bedTemp: 23 },
  )
  for (const frame of ['{', 'null', '[]', 'x'.repeat(65537)])
    assert.equal(decodeCrealityStatus(frame), undefined)
})

test(
  'loopback reconnects and closes without sending commands',
  { timeout: 5000 },
  async () => {
    const simulator = await createCrealitySimulator({
      state: 1,
      printProgress: 42,
    })
    let count = 0
    let resolveReports: () => void = () => {}
    const reports = new Promise<void>((resolve) => {
      resolveReports = resolve
    })
    const client = createCrealityTelemetryClient({
      host: '127.0.0.1',
      port: simulator.port,
      reconnectDelayMs: 10,
      onTelemetry(report) {
        assert.equal(report.progress, 42)
        count++
        if (count === 1) simulator.disconnect()
        if (count === 2) resolveReports()
      },
    })
    try {
      await reports
      await client.close()
      await client.close()
      assert.deepEqual(simulator.received, [])
    } finally {
      await client.close()
      await simulator.close()
    }
  },
)

test(
  'acknowledges a stock heartbeat without publishing it as telemetry',
  { timeout: 5000 },
  async () => {
    const simulator = await createCrealitySimulator({
      state: 1,
      printProgress: 42,
    })
    const reports: Array<number | undefined> = []
    const initial = Promise.withResolvers<void>()
    const next = Promise.withResolvers<void>()
    let disconnects = 0
    const client = createCrealityTelemetryClient({
      host: '127.0.0.1',
      port: simulator.port,
      onTelemetry(report) {
        reports.push(report.progress)
        if (report.progress === 42) initial.resolve()
        if (report.progress === 43) next.resolve()
      },
      onDisconnect() {
        disconnects++
      },
    })
    try {
      await initial.promise
      assert.equal(await simulator.challengeHeartbeat(), 1)
      simulator.setFrame({ msg: 'heart_beat', printProgress: 43 })
      await next.promise
      assert.deepEqual(reports, [42, 43])
      assert.deepEqual(simulator.received, ['ok'])
      assert.deepEqual(simulator.requests, [])
      assert.equal(disconnects, 0)
    } finally {
      await client.close()
      await simulator.close()
    }
  },
)
