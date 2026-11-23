// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from 'mqtt'
import { decodeAnycubicReport } from '../../packages/connector/src/anycubic/report.ts'
import { startKobraXMock } from '../../packages/sim-tools/src/mocks/kobra-x-mock.ts'

test('Kobra X simulator remaining minutes decode to seconds', async (t) => {
  const mock = await startKobraXMock({
    ssdp: false,
    camera: false,
    reportIntervalMs: 0,
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
  await new Promise<void>((resolve, reject) => {
    client.once('error', reject)
    client.once('connect', () =>
      client.subscribe('anycubic/anycubicCloud/v1/#', (error) =>
        error ? reject(error) : resolve(),
      ),
    )
  })
  const received = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('No advancing print report')),
      3000,
    )
    client.on('message', (_topic, payload) => {
      const data = JSON.parse(payload.toString()).data
      if (data?.remain_time > 0) {
        clearTimeout(timer)
        try {
          assert.equal(data.remain_time, 2)
          const decoded = decodeAnycubicReport(payload)
          assert.equal(decoded.kind, 'observation')
          assert.equal(
            'estimatedRemainingSeconds' in decoded &&
              decoded.estimatedRemainingSeconds,
            120,
          )
          resolve()
        } catch (error) {
          reject(error)
        }
      }
    })
  })
  await mock.control.startPrint('synthetic.gcode', {
    preparationPhases: [],
    printDurationMs: 90000,
  })
  await received
})
