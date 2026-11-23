// SPDX-License-Identifier: MIT
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AnycubicPairingRequired,
  captureAnycubicPeerPin,
  PinMismatch,
} from '../../packages/connector/src/anycubic/tls-trust.ts'
import { connectKobraX } from '../../packages/connector/src/kobra-x/index.ts'
import { generateKobraXThrowawayTls } from '../../packages/sim-tools/src/mocks/kobra-x-tls.ts'
import {
  startKobraXMock,
  installNetworkGuard,
  uninstallNetworkGuard,
} from '../../packages/sim-tools/src/mocks/index.ts'
import { qualifyKobraX } from '../../scripts/qualify/kobra-x.ts'

// End-to-end against the Kobra X mock: the read-only native path recovers the
// identity over HTTP, logs in over mutual TLS with the supplied client
// certificate, and observes telemetry from the printer's public report topic.
test('qualifies a Kobra X over the native LAN path, read-only', async (t) => {
  installNetworkGuard()
  const mock = await startKobraXMock({ camera: false })
  try {
    const options = {
      vendor: 'kobra-x' as const,
      host: '127.0.0.1',
      port: mock.mqttPort,
      httpPort: mock.httpPort,
      certFile: mock.tls.clientCertPath,
      keyFile: mock.tls.clientKeyPath,
      timeoutMs: 6000,
    }

    await t.test(
      'refuses the fixture certificate without explicit trust',
      async () => {
        await assert.rejects(
          qualifyKobraX(options, {}),
          AnycubicPairingRequired,
        )
      },
    )

    const result = await qualifyKobraX(
      { ...options, caFile: mock.tls.serverCertPath },
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

test('Kobra X accepts expired exact pins and blocks MQTT authentication on mismatch', async (t) => {
  installNetworkGuard()
  t.after(uninstallNetworkGuard)
  const tls = generateKobraXThrowawayTls()
  t.after(tls.cleanup)
  const config = join(tls.dir, 'openssl-expired.cnf')
  const csr = join(tls.dir, 'server-expired.csr')
  const certPath = join(tls.dir, 'server-expired.crt')
  writeFileSync(join(tls.dir, 'index.txt'), '')
  writeFileSync(join(tls.dir, 'serial'), '01\n')
  writeFileSync(
    config,
    [
      '[ca]',
      'default_ca = local',
      '[local]',
      'database = index.txt',
      'serial = serial',
      'new_certs_dir = .',
      'default_md = sha256',
      'policy = subject',
      'x509_extensions = server',
      '[subject]',
      'commonName = supplied',
      '[server]',
      'subjectAltName = IP:127.0.0.1',
    ].join('\n'),
  )
  const openssl = (args: string[]) =>
    execFileSync('openssl', args, {
      cwd: tls.dir,
      stdio: 'ignore',
      timeout: 10000,
    })
  openssl([
    'req',
    '-new',
    '-key',
    tls.server.keyPath,
    '-subj',
    '/CN=127.0.0.1',
    '-out',
    csr,
  ])
  openssl([
    'ca',
    '-config',
    config,
    '-batch',
    '-selfsign',
    '-notext',
    '-cert',
    tls.server.certPath,
    '-keyfile',
    tls.server.keyPath,
    '-startdate',
    '19700101000000Z',
    '-enddate',
    '19791230000000Z',
    '-in',
    csr,
    '-out',
    certPath,
  ])
  const cert = readFileSync(certPath)
  const x509 = new X509Certificate(cert)
  const original = new X509Certificate(tls.server.cert)
  assert.notEqual(original.fingerprint256, x509.fingerprint256)
  assert.equal(new Date(x509.validFrom).getUTCFullYear(), 1970)
  assert.equal(new Date(x509.validTo).getUTCFullYear(), 1979)
  const spkiPin = (certificate: X509Certificate) =>
    createHash('sha256')
      .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex')
  const spki = spkiPin(original)
  const wrongPin = spkiPin(new X509Certificate(tls.client.cert))
  const mock = await startKobraXMock({
    ssdp: false,
    camera: false,
    tls: {
      dir: tls.dir,
      server: { ...tls.server, cert, certPath },
      ca: tls.ca,
      client: tls.client,
      cleanup: tls.cleanup,
    },
  })
  t.after(() => mock.close())

  const host = '127.0.0.1'
  const cli = {
    vendor: 'kobra-x',
    host,
    httpPort: mock.httpPort,
    port: mock.mqttPort,
    certFile: tls.client.certPath,
    keyFile: tls.client.keyPath,
    timeoutMs: 2000,
  }
  const clientIdentity = { cert: tls.client.cert, key: tls.client.key }
  const countConnect = () => mock.calls().CONNECT ?? 0
  assert.equal(
    await captureAnycubicPeerPin(
      { host, port: mock.mqttPort, ...clientIdentity },
      AbortSignal.timeout(2000),
    ),
    spki,
  )
  assert.equal(countConnect(), 0, 'pairing capture sends no MQTT bytes')
  await assert.rejects(qualifyKobraX(cli, {}), AnycubicPairingRequired)
  // CA trust alone leaves hostname and expiry validation enabled.
  await assert.rejects(qualifyKobraX({ ...cli, caFile: certPath }, {}), {
    message: /certificate expired\. Pair this printer/,
    code: 'ANYCUBIC_PAIRING_REQUIRED',
  })
  assert.equal(countConnect(), 0, 'expiry blocks MQTT login without a pin')
  await assert.rejects(
    qualifyKobraX({ ...cli, pinSha256: wrongPin }, {}),
    PinMismatch,
  )
  assert.equal(countConnect(), 0, 'a mismatched certificate sees no MQTT login')

  const report = await qualifyKobraX(
    { ...cli, pinSha256: x509.fingerprint256 },
    {},
  )
  assert.ok(report.telemetry.fields.includes('toolTemperatureCelsius'))
  assert.equal(countConnect(), 1, 'the legacy certificate pin still works')

  const adapter = await connectKobraX({
    address: host,
    printerKey: 'expired-pin-fixture',
    httpPort: mock.httpPort,
    mqttPort: mock.mqttPort,
    clientIdentity,
    pinSha256: spki,
  })
  t.after(() => adapter.close())
  assert.equal(adapter.fingerprint(), spki)
  assert.equal(countConnect(), 2, 'the connector accepts the exact SPKI pin')
})
