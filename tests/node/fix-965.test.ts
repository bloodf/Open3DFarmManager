// SPDX-License-Identifier: AGPL-3.0-or-later
// Review fixes for the Anycubic LAN control transport and cancel outcome.
// Loopback TLS servers, the MQTT mock and the Anycubic simulator only; no
// printer is ever contacted.
import assert from 'node:assert/strict'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import {
  connect as netConnect,
  createServer as createNetServer,
} from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createTlsServer, type TLSSocket } from 'node:tls'
import test, { type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAnycubicControlTransport } from '../../packages/connector/src/anycubic/control-transport.ts'
import { openQualifiedAnycubicControl } from '../../packages/connector/src/anycubic/lan-control-driver.ts'
import type { ControlObservation } from '../../packages/connector/src/control/pause-dispatcher.ts'
import { provisionAnycubicPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import { startAnycubicSimulator } from '../../packages/sim-tools/src/anycubic-simulator.ts'
import {
  generateKobraXThrowawayTls,
  type KobraXTlsMaterial,
} from '../../packages/sim-tools/src/mocks/kobra-x-tls.ts'
import { startMqttBroker } from '../../packages/sim-tools/src/mocks/mqtt-broker.ts'

const HOST = '127.0.0.1'
const credentials = { username: 'fixture-user', password: 'fixture-password' }
const wrongPin = '0'.repeat(64)
const CHANGE_CIPHER_SPEC = 20
const HANDSHAKE = 22
const CLIENT_HELLO = 1
const MQTT_CONNECT = 0x10

function material(t: TestContext) {
  const tls = generateKobraXThrowawayTls({ dirPrefix: 'fix-965-tls-' })
  t.after(tls.cleanup)
  return tls
}

/** Splits the client's wire bytes into TLS records. */
function records(all: Buffer) {
  const out: { type: number; handshake?: number; end: number }[] = []
  for (let at = 0; at + 5 <= all.length;) {
    const end = at + 5 + all.readUInt16BE(at + 3)
    const type = all[at]!
    out.push({
      type,
      ...(type === HANDSHAKE ? { handshake: all[at + 5] } : {}),
      end: Math.min(end, all.length),
    })
    at = end
  }
  return out
}

function openControl(
  t: TestContext,
  port: number,
  trust: {
    caPem?: string
    pinSha256?: string
    certPem?: string
    keyPem?: string
  },
  model: string,
) {
  const states: string[] = []
  let connected!: () => void
  const ready = new Promise<void>((resolve) => (connected = resolve))
  const transport = createAnycubicControlTransport({
    host: HOST,
    port,
    serial: `${model}/FIXTURE`,
    credentials,
    ...trust,
    limits: {
      maxFrameBytes: 131072,
      connectTimeoutMs: 2000,
      maxInflight: 16,
      reconnectDelayMs: 10,
      maxReconnects: 0,
    },
    signal: AbortSignal.timeout(3000),
    onReport() {},
    onConnection(state) {
      states.push(state)
      if (state === 'connected') connected()
    },
  })
  t.after(transport.close)
  return { transport, ready, states }
}

/**
 * A TLS server that asks for a client certificate, behind a relay that records
 * every byte the client sends.
 */
async function certificateProbe(
  t: TestContext,
  tls: KobraXTlsMaterial,
  shape: { ecdhCurve?: string; maxVersion?: 'TLSv1.2' } = {},
) {
  const server = createTlsServer({
    key: tls.server.key,
    cert: tls.server.cert,
    ca: tls.ca.cert,
    requestCert: true,
    rejectUnauthorized: false,
    ...shape,
  })
  const peers: boolean[] = []
  const received: Buffer[] = []
  const wire: Buffer[] = []
  const sockets = new Set<{ destroy(): void }>()
  server.on('secureConnection', (socket: TLSSocket) => {
    sockets.add(socket)
    peers.push(!!socket.getPeerCertificate()?.raw)
    socket.on('data', (chunk: Buffer) => received.push(chunk))
    socket.on('error', () => {})
  })
  server.on('tlsClientError', () => {})
  let relayClosed!: () => void
  const drained = new Promise<void>((resolve) => (relayClosed = resolve))
  const relay = createNetServer((client) => {
    const upstream = netConnect({
      host: HOST,
      port: (server.address() as { port: number }).port,
    })
    sockets.add(client)
    sockets.add(upstream)
    client.on('data', (chunk: Buffer) => {
      wire.push(chunk)
      upstream.write(chunk)
    })
    upstream.on('data', (chunk: Buffer) => client.write(chunk))
    client.on('close', () => {
      upstream.destroy()
      relayClosed()
    })
    upstream.on('close', () => client.destroy())
    client.on('error', () => {})
    upstream.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, HOST, resolve))
  await new Promise<void>((resolve) => relay.listen(0, HOST, resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) =>
      relay.close(() => server.close(() => resolve())),
    )
  })
  return {
    port: (relay.address() as { port: number }).port,
    drained,
    report() {
      const all = Buffer.concat(wire)
      const list = records(all)
      const hellos = list.filter(
        (r) => r.type === HANDSHAKE && r.handshake === CLIENT_HELLO,
      )
      return {
        clientHellos: hellos.length,
        clientCertificateReached: peers.some(Boolean),
        applicationBytes: Buffer.concat(received).length,
        /** Records other than ClientHello / compatibility CCS. */
        otherRecords: list.filter(
          (r) =>
            r.type !== CHANGE_CIPHER_SPEC &&
            !(r.type === HANDSHAKE && r.handshake === CLIENT_HELLO),
        ).length,
        bytesAfterLastClientHello: hellos.length
          ? all.length - hellos.at(-1)!.end
          : all.length,
        received: Buffer.concat(received),
      }
    },
  }
}

const identityCases = [
  { name: 'TLS 1.3 default groups', shape: {}, hellos: 1 },
  {
    name: 'TLS 1.3 HelloRetryRequest',
    // OpenSSL 3.5 sends X25519MLKEM768 and X25519 shares first.
    shape: { ecdhCurve: 'P-256' },
    hellos: 2,
  },
  { name: 'TLS 1.2-only peer', shape: { maxVersion: 'TLSv1.2' as const } },
]

for (const model of ['20028', '20024']) {
  for (const { name, shape, hellos } of identityCases) {
    test(`${model} wrong pin, ${name}: no client certificate and no MQTT bytes reach the peer`, async (t) => {
      const tls = material(t)
      const probe = await certificateProbe(t, tls, shape)
      const { transport, states } = openControl(
        t,
        probe.port,
        {
          pinSha256: wrongPin,
          certPem: tls.client.cert.toString(),
          keyPem: tls.client.key.toString(),
        },
        model,
      )
      await transport.done
      await probe.drained
      await delay(50)
      const r = probe.report()
      assert.deepEqual(states, ['disconnected', 'closed'])
      assert.equal(r.clientCertificateReached, false)
      assert.equal(r.applicationBytes, 0, 'MQTT bytes reached the peer')
      assert.equal(r.otherRecords, 0, 'the client flight left the client')
      assert.equal(r.bytesAfterLastClientHello, 0)
      if (hellos !== undefined) assert.equal(r.clientHellos, hellos)
    })
  }

  test(`${model} matching pin with a client certificate connects and presents it`, async (t) => {
    const tls = material(t)
    const probe = await certificateProbe(t, tls, { ecdhCurve: 'P-256' })
    const { transport } = openControl(
      t,
      probe.port,
      {
        pinSha256: tls.serverFingerprintSha256,
        certPem: tls.client.cert.toString(),
        keyPem: tls.client.key.toString(),
      },
      model,
    )
    for (let n = 0; n < 200 && probe.report().applicationBytes === 0; n++)
      await delay(10)
    const r = probe.report()
    assert.equal(r.clientHellos, 2)
    assert.equal(r.clientCertificateReached, true)
    assert.equal(r.received[0], MQTT_CONNECT)
    await transport.close()
  })
}

test('20024 refuses a matching pin when the configured CA is wrong', async (t) => {
  const tls = material(t)
  const broker = await startMqttBroker({ tls, auth: credentials })
  t.after(broker.close)
  const { transport, states } = openControl(
    t,
    broker.ports.mqtt,
    {
      caPem: tls.ca.cert.toString(),
      pinSha256: tls.serverFingerprintSha256,
    },
    '20024',
  )
  await transport.done
  assert.deepEqual(states, ['disconnected', 'closed'])
  assert.equal(broker.calls().CONNECT ?? 0, 0)
})

test('20024 refuses a trusted CA when the configured pin is wrong', async (t) => {
  const tls = material(t)
  const broker = await startMqttBroker({ tls, auth: credentials })
  t.after(broker.close)
  const { transport, states } = openControl(
    t,
    broker.ports.mqtt,
    { caPem: tls.server.cert.toString(), pinSha256: wrongPin },
    '20024',
  )
  await transport.done
  assert.deepEqual(states, ['disconnected', 'closed'])
  assert.equal(broker.calls().CONNECT ?? 0, 0)
})

for (const trust of ['pin only', 'CA and pin'] as const) {
  test(`20024 connects with a matching ${trust}`, async (t) => {
    const tls = material(t)
    const broker = await startMqttBroker({ tls, auth: credentials })
    t.after(broker.close)
    const { transport, ready } = openControl(
      t,
      broker.ports.mqtt,
      {
        ...(trust === 'CA and pin'
          ? { caPem: tls.server.cert.toString() }
          : {}),
        pinSha256: tls.serverFingerprintSha256,
      },
      '20024',
    )
    await Promise.race([
      ready,
      transport.done.then(() =>
        assert.fail('control transport closed before connecting'),
      ),
    ])
    assert.equal(broker.calls().CONNECT, 1)
  })
}

// Cancel outcome: the qualified LAN control driver on the simulator.
const qualified = [{ modelId: '20029', firmwareVersion: '2.6.9.6' }]

async function cancelFixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'fix-965-cancel-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const passwordFile = join(dir, 'password.json')
  await writeFile(passwordFile, JSON.stringify('synthetic'), { mode: 0o600 })
  const sim = await startAnycubicSimulator({
    modelId: '20029',
    firmware: '2.6.9.6',
    confirmCommands: false,
    reportIntervalMs: 100,
    credentials: { username: 'synthetic', password: 'synthetic' },
  })
  t.after(() => sim.close())
  sim.setPrintProgress(25)
  const binding = provisionAnycubicPrinter(
    {
      assignment_id: randomUUID(),
      printer_key: 'printer',
      farm_id: randomUUID(),
      agent_id: randomUUID(),
    },
    {
      printerKey: 'printer',
      host: sim.host,
      port: sim.port,
      modelId: '20029',
      deviceId: 'SYNTHETIC',
      username: 'synthetic',
      passwordFile,
      pinSha256: createHash('sha256')
        .update(new X509Certificate(sim.syntheticTrust).raw)
        .digest('hex'),
    },
  )
  const observations: (ControlObservation | null)[] = []
  const controller = new AbortController()
  const attempt = openQualifiedAnycubicControl({
    binding,
    connectionGeneration: 1,
    clock: { monotonicNow: () => performance.now() },
    publish: (value) => observations.push(value),
    signal: controller.signal,
    timeoutMs: 500,
    anycubicQualifiedWrites: qualified,
  })
  t.after(() => attempt.close())
  await attempt.prepare()
  const result = attempt.driver.pauseOnce({
    binding,
    signal: controller.signal,
    action: 'cancel',
    beforeSend: () => true,
  })
  for (let n = 0; n < 200 && sim.writes.length === 0; n++) await delay(10)
  assert.equal(sim.writes.length, 1)
  return { sim, observations, result }
}

const report = (project: Record<string, unknown> | null, code?: number) => ({
  type: 'info',
  ...(code !== undefined ? { code } : {}),
  data: { version: '2.6.9.6', state: project ? 'busy' : 'free', project },
})

test('an idle report after a cancel leaves the outcome unknown', async (t) => {
  const { sim, observations, result } = await cancelFixture(t)
  const rejected = assert.rejects(result, /timeout/)
  // A job that finished and went straight to idle looks exactly like this.
  sim.control.publishReport(report(null))
  for (let n = 0; n < 200; n++) {
    if (observations.some((value) => value?.printState === 'idle')) break
    await delay(10)
  }
  await rejected
  assert.ok(observations.some((value) => value?.printState === 'idle'))
  assert.equal(
    observations.some((value) => value?.printState === 'cancelled'),
    false,
  )
  assert.deepEqual(
    sim.writes.map((value) => value.action),
    ['stop'],
  )
})

test('a stopped job with a fault code does not confirm a cancel', async (t) => {
  const { sim, observations, result } = await cancelFixture(t)
  const rejected = assert.rejects(result, /timeout/)
  sim.control.publishReport(report({ state: 'stoped', code: 10111 }))
  await rejected
  assert.equal(
    observations.some((value) => value?.printState === 'cancelled'),
    false,
  )
  assert.equal(sim.writes.length, 1)
})

for (const state of ['canceled', 'stoped']) {
  test(`an explicit "${state}" job confirms the cancel once`, async (t) => {
    const { sim, observations, result } = await cancelFixture(t)
    sim.control.publishReport(report({ state }))
    assert.deepEqual(await result, { acknowledged: true })
    assert.ok(observations.some((value) => value?.printState === 'cancelled'))
    assert.equal(sim.writes.length, 1)
  })
}
