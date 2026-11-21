// SPDX-License-Identifier: MIT
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  startKobraXMock,
  installNetworkGuard,
  uninstallNetworkGuard,
} from '../../packages/sim-tools/src/mocks/index.ts'
import { qualifyKobraX } from '../../scripts/qualify/kobra-x.ts'

// End-to-end against the Kobra X mock: the read-only native path recovers the
// identity over HTTP, logs in over mutual TLS with the supplied client
// certificate, and observes telemetry from the printer's public report topic.
test('qualifies a Kobra X over the native LAN path, read-only', async () => {
  installNetworkGuard()
  const mock = await startKobraXMock({ camera: false })
  try {
    const result = await qualifyKobraX(
      {
        vendor: 'kobra-x',
        host: '127.0.0.1',
        port: mock.mqttPort,
        httpPort: mock.httpPort,
        certFile: mock.tls.clientCertPath,
        keyFile: mock.tls.clientKeyPath,
        timeoutMs: 6000,
      },
      {},
    )

    assert.equal(result.identity.vendor, 'Anycubic')
    assert.equal(result.identity.model, 'Kobra X')
    assert.equal(result.identity.serial, mock.credentials.deviceId)

    assert.equal(result.telemetry.observed, true)
    assert.ok(
      result.telemetry.fields.includes('toolTemperatureCelsius'),
      `expected nozzle temperature, saw ${result.telemetry.fields.join(', ')}`,
    )
    assert.ok(
      result.telemetry.fields.includes('bedTemperatureCelsius'),
      'expected bed temperature',
    )
  } finally {
    await mock.close()
    uninstallNetworkGuard()
  }
})
