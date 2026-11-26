// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'
import test from 'node:test'
import { createAnycubicControlTransport } from '../../packages/connector/src/anycubic/control-transport.ts'
import { generateKobraXThrowawayTls } from '../../packages/sim-tools/src/mocks/kobra-x-tls.ts'
import { startMqttBroker } from '../../packages/sim-tools/src/mocks/mqtt-broker.ts'

const HOST = '127.0.0.1'
const credentials = { username: 'fixture-user', password: 'fixture-password' }
const wrongPin = '0'.repeat(64)

function material(t: test.TestContext) {
  const tls = generateKobraXThrowawayTls({ dirPrefix: 'fix-963-tls-' })
  t.after(tls.cleanup)
  return tls
}

function openControl(
  t: test.TestContext,
  port: number,
  trust: { caPem?: string; pinSha256: string },
  model = '20028',
) {
  const signal = AbortSignal.timeout(3000)
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
    signal,
    onReport() {},
    onConnection(state) {
      states.push(state)
      if (state === 'connected') connected()
    },
  })
  t.after(transport.close)
  return { transport, ready, states }
}

async function listen(server: Server) {
  server.listen(0, HOST)
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return address.port
}

test('Kobra 4 wrong pin sends a ClientHello and no MQTT application records', async (t) => {
  const tls = material(t)
  const server = createTlsServer({
    ...tls.server,
    // TLS 1.2 keeps handshake records distinguishable from application data.
    maxVersion: 'TLSv1.2',
  })
  const sockets = new Set<Socket>()
  function track(socket: Socket) {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
  }
  server.on('connection', track)
  const received: Buffer[] = []
  server.on('secureConnection', (socket) =>
    socket.on('data', (data: Buffer) => received.push(data)),
  )
  const serverPort = await listen(server)
  const wire: Buffer[] = []
  let relayClosed!: () => void
  const drained = new Promise<void>((resolve) => (relayClosed = resolve))
  const relay = createServer((client) => {
    const upstream = connect(serverPort, HOST)
    track(client)
    track(upstream)
    client.on('data', (data: Buffer) => wire.push(data))
    client.pipe(upstream)
    upstream.pipe(client)
    client.once('close', () => {
      upstream.destroy()
      relayClosed()
    })
    upstream.once('close', () => client.destroy())
  })
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await Promise.all(
      [relay, server].map(
        (listener) =>
          new Promise<void>((resolve) => listener.close(() => resolve())),
      ),
    )
  })
  const { transport, states } = openControl(t, await listen(relay), {
    pinSha256: wrongPin,
  })

  await transport.done
  await drained
  assert.deepEqual(states, ['disconnected', 'closed'])
  const bytes = Buffer.concat(wire)
  assert.equal(bytes[0], 22, 'expected a TLS handshake record')
  assert.equal(bytes[5], 1, 'expected a ClientHello')
  for (let offset = 0; offset < bytes.length;) {
    assert.ok(offset + 5 <= bytes.length, 'incomplete TLS record header')
    assert.notEqual(
      bytes[offset],
      23,
      'sent TLS application data to an untrusted peer',
    )
    offset += 5 + bytes.readUInt16BE(offset + 3)
    assert.ok(offset <= bytes.length, 'incomplete TLS record body')
  }
  assert.equal(Buffer.concat(received).length, 0)
})

test('S1 Max refuses a matching pin when the configured CA is wrong', async (t) => {
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
    '20029',
  )

  await transport.done
  assert.deepEqual(states, ['disconnected', 'closed'])
  assert.equal(broker.calls().CONNECT ?? 0, 0)
})

test('S1 Max refuses a trusted CA when the configured pin is wrong', async (t) => {
  const tls = material(t)
  const broker = await startMqttBroker({ tls, auth: credentials })
  t.after(broker.close)
  const { transport, states } = openControl(
    t,
    broker.ports.mqtt,
    {
      caPem: tls.server.cert.toString(),
      pinSha256: wrongPin,
    },
    '20029',
  )

  await transport.done
  assert.deepEqual(states, ['disconnected', 'closed'])
  assert.equal(broker.calls().CONNECT ?? 0, 0)
})

test('S1 Max connects with matching CA and pin and rejects disallowed publishWeb types', async (t) => {
  const tls = material(t)
  const events = new EventEmitter()
  const broker = await startMqttBroker({
    tls,
    auth: credentials,
    onPublish(message) {
      if (message.topic.endsWith('/info')) events.emit('info')
    },
  })
  t.after(broker.close)
  const { transport, ready } = openControl(
    t,
    broker.ports.mqtt,
    {
      caPem: tls.server.cert.toString(),
      pinSha256: tls.serverFingerprintSha256,
    },
    '20029',
  )
  await Promise.race([
    ready,
    transport.done.then(() =>
      assert.fail('control transport closed before connecting'),
    ),
  ])

  let authorized = false
  await assert.rejects(
    transport.publishWeb({ type: 'unsupported' }, () => {
      authorized = true
      return true
    }),
    /Anycubic request unavailable/,
  )
  assert.equal(authorized, false)
  // An allowed packet is a barrier behind any publish from the rejected call.
  await Promise.all([
    once(events, 'info', { signal: AbortSignal.timeout(2000) }),
    transport.publishWeb({ type: 'info' }, () => true),
  ])
  assert.deepEqual(
    broker.calls.all.map(({ topic }) => topic),
    ['anycubic/anycubicCloud/v1/web/printer/20029/FIXTURE/info'],
  )
})

// Behavioral tests use only the loopback simulator and synthetic credentials.
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  openQualifiedAnycubicControl,
  readAnycubicFirmware,
} from '../../packages/connector/src/anycubic/lan-control-driver.ts'
import { provisionAnycubicPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import type { ControlObservation } from '../../packages/connector/src/control/pause-dispatcher.ts'
import { startAnycubicSimulator } from '../../packages/sim-tools/src/anycubic-simulator.ts'

const behaviorQualified = [{ modelId: '20029', firmwareVersion: '2.6.9.6' }]
async function behaviorFixture(t: TestContext, firmware = '2.6.9.6') {
  const dir = await mkdtemp(join(tmpdir(), 'fix-963-behavior-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const passwordFile = join(dir, 'password.json')
  await writeFile(passwordFile, JSON.stringify('synthetic'), { mode: 0o600 })
  const sim = await startAnycubicSimulator({
    modelId: '20029',
    firmware,
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
  return { sim, binding }
}
async function behaviorUntil(check: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (check()) return
    await delay(10)
  }
  assert.fail('Condition never held')
}
function behaviorOpen(
  binding: Awaited<ReturnType<typeof behaviorFixture>>['binding'],
  observations: (ControlObservation | null)[],
  qualified = behaviorQualified,
) {
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
  return { attempt, signal: controller.signal }
}

test('a natural finish during cancel is reported as finished and never confirms the cancel', async (t) => {
  const { sim, binding } = await behaviorFixture(t)
  const observations: (ControlObservation | null)[] = []
  const { attempt, signal } = behaviorOpen(binding, observations)
  t.after(() => attempt.close())
  await attempt.prepare()
  const result = attempt.driver.pauseOnce({
    binding,
    signal,
    action: 'cancel',
    beforeSend: () => true,
  })
  const rejected = assert.rejects(result, /timeout/)
  await behaviorUntil(() => sim.writes.length === 1)
  sim.control.publishReport({
    type: 'info',
    data: { version: '2.6.9.6', state: 'busy', project: { state: 'finish' } },
  })
  await behaviorUntil(() =>
    observations.some((value) => value?.printState === 'finished'),
  )
  await rejected
  assert.equal(
    observations.some((value) => value?.printState === 'cancelled'),
    false,
  )
  assert.deepEqual(
    sim.writes.map((value) => value.action),
    ['stop'],
  )
})

test('a firmware change in a report invalidates the prepared attempt before any command', async (t) => {
  const { sim, binding } = await behaviorFixture(t)
  assert.equal(await readAnycubicFirmware(binding), '2.6.9.6')
  const observations: (ControlObservation | null)[] = []
  const { attempt, signal } = behaviorOpen(binding, observations)
  t.after(() => attempt.close())
  await attempt.prepare()
  sim.control.publishReport({
    type: 'info',
    data: { version: '2.7.1.4', state: 'busy', project: { state: 'printing' } },
  })
  await behaviorUntil(() => observations.at(-1) === null)
  await assert.rejects(
    attempt.driver.pauseOnce({
      binding,
      signal,
      action: 'pause',
      beforeSend: () => true,
    }),
  )
  assert.deepEqual(sim.writes, [])
})

test('each attempt independently refuses an unqualified firmware before sending', async (t) => {
  const { sim, binding } = await behaviorFixture(t, '2.7.1.4')
  const observations: (ControlObservation | null)[] = []
  const { attempt, signal } = behaviorOpen(binding, observations)
  t.after(() => attempt.close())
  await assert.rejects(attempt.prepare())
  await assert.rejects(
    attempt.driver.pauseOnce({
      binding,
      signal,
      action: 'pause',
      beforeSend: () => true,
    }),
  )
  assert.deepEqual(sim.writes, [])
})

test('send rechecks qualification after preparation before writing', async (t) => {
  const { sim, binding } = await behaviorFixture(t)
  const qualified = [...behaviorQualified]
  const { attempt, signal } = behaviorOpen(binding, [], qualified)
  t.after(() => attempt.close())
  await attempt.prepare()
  qualified.length = 0
  await assert.rejects(
    attempt.driver.pauseOnce({
      binding,
      signal,
      action: 'pause',
      beforeSend: () => true,
    }),
    { refusal: 'unsupported-action' },
  )
  assert.deepEqual(sim.writes, [])
})
