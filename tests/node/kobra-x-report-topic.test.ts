// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { connect } from 'mqtt'
import { connectKobraX } from '../../packages/connector/src/kobra-x/index.ts'
import {
  installNetworkGuard,
  startKobraXMock,
  uninstallNetworkGuard,
} from '../../packages/sim-tools/src/mocks/index.ts'

const address = '127.0.0.1'

async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await delay(20)
  }
  assert.fail(`Timed out waiting for ${label}`)
}

test(
  'real Kobra X report topics reach connectKobraX and the mock publishes them',
  { timeout: 20000 },
  async (t) => {
    installNetworkGuard()
    t.after(uninstallNetworkGuard)
    const mock = await startKobraXMock({
      ssdp: false,
      camera: false,
      reportIntervalMs: 0,
    })
    t.after(() => mock.close())
    const { modeId, deviceId, username, password } = mock.credentials
    const realPrefix = `anycubic/anycubicCloud/v1/printer/public/${modeId}/${deviceId}/`
    const queryTopic = `anycubic/anycubicCloud/v1/slicer/printer/${modeId}/${deviceId}/status`
    const seen: string[] = []
    const observer = connect({
      host: address,
      port: mock.mqttPort,
      protocol: 'mqtts',
      protocolVersion: 4,
      username,
      password,
      cert: mock.tls.clientCert,
      key: mock.tls.clientKey,
      rejectUnauthorized: false,
      reconnectPeriod: 0,
      connectTimeout: 3000,
    })
    t.after(
      () =>
        new Promise<void>((resolve) => {
          observer.end(true, {}, () => resolve())
        }),
    )
    observer.on('error', () => {})
    observer.on('message', (topic) => {
      seen.push(topic)
    })
    await new Promise<void>((resolve, reject) => {
      observer.once('connect', () => {
        observer.subscribe('anycubic/anycubicCloud/v1/#', (error, grants) => {
          if (error || !grants?.length || grants[0]?.qos === 128)
            reject(new Error('Kobra X wildcard subscription failed'))
          else resolve()
        })
      })
      observer.once('error', reject)
    })

    const adapter = await connectKobraX({
      address,
      printerKey: 'kobra-x-report-topic',
      clientIdentity: { cert: mock.tls.clientCert, key: mock.tls.clientKey },
      httpPort: mock.httpPort,
      mqttPort: mock.mqttPort,
      reconnectMs: 100,
    })
    t.after(() => adapter.close())

    await until(
      () => seen.includes(queryTopic),
      `query publish on ${queryTopic} (saw ${seen.join(', ') || 'none'})`,
    )

    const reportTopics = () =>
      seen.filter(
        (topic) => topic.endsWith('/report') || topic.endsWith('/response'),
      )
    await until(
      () => reportTopics().includes(`${realPrefix}multiColorBox/report`),
      `mock report on ${realPrefix} (saw ${reportTopics().join(', ') || 'none'})`,
    )
    for (const topic of reportTopics()) {
      assert.equal(
        topic.startsWith(realPrefix),
        true,
        `mock published ${topic}`,
      )
      assert.equal(topic.includes('/slicer/'), false)
    }

    observer.publish(
      `${realPrefix}status/report`,
      JSON.stringify({
        type: 'status',
        action: 'report',
        msgid: 'real-status',
        state: 'done',
        code: 200,
        data: { state: 'busy' },
      }),
    )
    observer.publish(
      `${realPrefix}tempature/report`,
      JSON.stringify({
        type: 'tempature',
        action: 'report',
        msgid: 'real-temp',
        state: 'done',
        code: 200,
        data: { curr_nozzle_temp: 187, curr_hotbed_temp: 47 },
      }),
    )
    await until(
      () =>
        adapter.snapshot().state === 'printing' &&
        adapter.snapshot().toolTemperatureCelsius === 187 &&
        adapter.facts().infoState === 'busy',
      'status and telemetry from the real report topic',
    )
    assert.equal(adapter.snapshot().bedTemperatureCelsius, 47)
  },
)
