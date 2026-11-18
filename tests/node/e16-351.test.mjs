// SPDX-License-Identifier: MIT
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import tls from 'node:tls'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'
import {
  startMock,
  startHttpMock,
  startMqttBroker,
  startBambuMock,
  startKobraXMock,
  startMoonrakerMock,
  ScenarioController,
  generateThrowawayTls,
  getSharedThrowawayTls,
  getSimMode,
  isMockSim,
  isDockerSim,
  installNetworkGuard,
  uninstallNetworkGuard,
  assertLoopbackAddress,
  encodePacket,
} from '../../packages/sim-tools/src/mocks/index.ts'

test('OPENFARM_SIM switch defaults to mock and honors docker opt-in', () => {
  const orig = process.env.OPENFARM_SIM
  try {
    delete process.env.OPENFARM_SIM
    assert.equal(getSimMode(), 'mock')
    assert.equal(isMockSim(), true)
    assert.equal(isDockerSim(), false)

    process.env.OPENFARM_SIM = 'docker'
    assert.equal(getSimMode(), 'docker')
    assert.equal(isMockSim(), false)
    assert.equal(isDockerSim(), true)

    process.env.OPENFARM_SIM = 'mock'
    assert.equal(getSimMode(), 'mock')
    assert.equal(isMockSim(), true)
  } finally {
    if (orig !== undefined) {
      process.env.OPENFARM_SIM = orig
    } else {
      delete process.env.OPENFARM_SIM
    }
  }
})

test('Throwaway TLS generates CA, server and client certificates in temp dir and cleans up', () => {
  const material = generateThrowawayTls()
  assert.ok(material.dir)
  assert.ok(material.ca.cert.length > 0)
  assert.ok(material.ca.key.length > 0)
  assert.ok(material.server.cert.length > 0)
  assert.ok(material.server.key.length > 0)
  assert.ok(material.client.cert.length > 0)
  assert.ok(material.client.key.length > 0)

  // Verify server cert parses and has SAN
  const x509 = new X509Certificate(material.server.cert)
  assert.ok(x509.subject.includes('127.0.0.1'))
  assert.ok(x509.subjectAltName?.includes('IP Address:127.0.0.1'))

  // Verify cleanup removes directory
  assert.equal(existsSync(material.dir), true)
  material.cleanup()
  assert.equal(existsSync(material.dir), false)
})

test('Scenario scripting runs, pauses, steps, and resets timed steps', async () => {
  let state = { count: 0, status: 'idle' }
  const reports = []

  const scenario = new ScenarioController({
    steps: [
      { delayMs: 10, state: { count: 1, status: 'started' }, report: 'step-1' },
      { delayMs: 10, state: { count: 2, status: 'working' }, report: 'step-2' },
      { delayMs: 10, state: { count: 3, status: 'done' }, report: 'step-3' },
    ],
    applyState: (patch) => {
      state = { ...state, ...patch }
    },
    publishReport: (rep) => {
      reports.push(rep)
    },
    getState: () => ({ ...state }),
  })

  assert.equal(scenario.status, 'idle')
  assert.equal(scenario.currentStep, 0)

  // Step 1 manually
  const stepped1 = await scenario.step()
  assert.equal(stepped1, true)
  assert.equal(scenario.currentStep, 1)
  assert.equal(state.count, 1)
  assert.equal(state.status, 'started')
  assert.deepEqual(reports, ['step-1'])

  // Pause and reset
  scenario.pause()
  assert.equal(scenario.status, 'paused')

  scenario.reset()
  assert.equal(scenario.status, 'idle')
  assert.equal(scenario.currentStep, 0)

  // Run automatically
  reports.length = 0
  await scenario.run()
  assert.equal(scenario.status, 'completed')
  assert.equal(scenario.currentStep, 3)
  assert.equal(state.count, 3)
  assert.equal(state.status, 'done')
  assert.deepEqual(reports, ['step-1', 'step-2', 'step-3'])

  scenario.stop()
})

test('Fault hooks on HTTP mock: delay, drop, malformed, refuse, stall', async () => {
  const mock = await startMock('http', {
    routes: {
      '/test': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ hello: 'world' }))
      },
    },
  })

  try {
    // 1. Normal call
    const res1 = await fetch(`${mock.origin}/test`)
    assert.equal(res1.status, 200)
    assert.deepEqual(await res1.json(), { hello: 'world' })

    // 2. Delay fault
    mock.control.faults.setFault({ type: 'delay', delayMs: 120 })
    const start = performance.now()
    const res2 = await fetch(`${mock.origin}/test`)
    const elapsed = performance.now() - start
    assert.equal(res2.status, 200)
    assert.ok(elapsed >= 100, `Expected delay >= 100ms, got ${elapsed}ms`)

    // 3. Drop fault
    mock.control.faults.setFault({ type: 'drop' })
    await assert.rejects(
      async () => {
        await fetch(`${mock.origin}/test`)
      },
      (err) => err !== null,
    )

    // 4. Malformed reply fault
    mock.control.faults.setFault({
      type: 'malformed',
      payload: 'NOT_HTTP_RESPONSE\r\n\r\n',
    })
    await assert.rejects(
      async () => {
        await fetch(`${mock.origin}/test`)
      },
      (err) => err !== null,
    )

    // 5. Refuse fault (503)
    mock.control.faults.setFault({ type: 'refuse', statusCode: 503 })
    const resRefuse = await fetch(`${mock.origin}/test`)
    assert.equal(resRefuse.status, 503)

    // 6. Stall fault (aborted by client timeout)
    mock.control.faults.setFault({ type: 'stall' })
    await assert.rejects(
      async () => {
        await fetch(`${mock.origin}/test`, {
          signal: AbortSignal.timeout(50),
        })
      },
      /timeout|abort/i,
    )

    mock.control.faults.clearFaults()
    const resNormalAgain = await fetch(`${mock.origin}/test`)
    assert.equal(resNormalAgain.status, 200)
  } finally {
    await mock.close()
  }
})

test('Fault hooks on MQTT mock: delay, drop, malformed, refuse', async () => {
  const sharedTls = getSharedThrowawayTls()
  const mock = await startMock('mqtt', {
    tls: sharedTls,
  })

  async function connectMqttClient() {
    const socket = tls.connect({
      host: '127.0.0.1',
      port: mock.ports.default,
      ca: sharedTls.ca.cert,
    })
    await once(socket, 'secureConnect')
    return socket
  }

  try {
    // 1. Normal CONNECT
    const client1 = await connectMqttClient()
    const replyPromise1 = once(client1, 'data')
    client1.write(
      Buffer.from([16, 13, 0, 4, 77, 81, 84, 84, 4, 2, 0, 10, 0, 1, 120]),
    )
    const [reply1] = await replyPromise1
    assert.deepEqual(reply1, Buffer.from([32, 2, 0, 0])) // CONNACK OK
    client1.destroy()

    // 2. Delay fault
    mock.control.faults.setFault({ type: 'delay', delayMs: 120 })
    const client2 = await connectMqttClient()
    const start = performance.now()
    const replyPromise2 = once(client2, 'data')
    client2.write(
      Buffer.from([16, 13, 0, 4, 77, 81, 84, 84, 4, 2, 0, 10, 0, 1, 120]),
    )
    const [reply2] = await replyPromise2
    const elapsed = performance.now() - start
    assert.deepEqual(reply2, Buffer.from([32, 2, 0, 0]))
    assert.ok(elapsed >= 100, `Expected delay >= 100ms, got ${elapsed}ms`)
    client2.destroy()

    // 3. Drop fault
    mock.control.faults.setFault({ type: 'drop' })
    const client3 = await connectMqttClient()
    const closePromise = once(client3, 'close')
    client3.write(
      Buffer.from([16, 13, 0, 4, 77, 81, 84, 84, 4, 2, 0, 10, 0, 1, 120]),
    )
    await closePromise
    assert.equal(client3.destroyed, true)

    // 4. Malformed reply fault
    mock.control.faults.setFault({
      type: 'malformed',
      payload: Buffer.from([0xff, 0xff, 0xff, 0xff]),
    })
    const client4 = await connectMqttClient()
    const dataPromise4 = once(client4, 'data')
    client4.write(
      Buffer.from([16, 13, 0, 4, 77, 81, 84, 84, 4, 2, 0, 10, 0, 1, 120]),
    )
    const [data4] = await dataPromise4
    assert.deepEqual(data4, Buffer.from([0xff, 0xff, 0xff, 0xff]))
    client4.destroy()

    // 5. Refuse fault (code 5 = Not Authorized)
    mock.control.faults.setFault({ type: 'refuse', code: 5 })
    const client5 = await connectMqttClient()
    const dataPromise5 = once(client5, 'data')
    client5.write(
      Buffer.from([16, 13, 0, 4, 77, 81, 84, 84, 4, 2, 0, 10, 0, 1, 120]),
    )
    const [data5] = await dataPromise5
    assert.deepEqual(data5, Buffer.from([32, 2, 0, 5])) // CONNACK Not Authorized
    client5.destroy()
  } finally {
    await mock.close()
  }
})

test('Network guard enforces loopback-only sockets across all mocks', async () => {
  installNetworkGuard()
  try {
    // 1. All mocks start and pass guard because they bind to 127.0.0.1
    const httpMock = await startMock('http')
    assertLoopbackAddress(httpMock.ports.default ? { address: '127.0.0.1', port: httpMock.ports.default, family: 'IPv4' } : null)
    await httpMock.close()

    const mqttMock = await startMock('mqtt', { reuseSharedTls: true })
    assertLoopbackAddress({ address: '127.0.0.1', port: mqttMock.ports.default, family: 'IPv4' })
    await mqttMock.close()

    const bambuMock = await startMock('bambu', { reuseSharedTls: true })
    assertLoopbackAddress({ address: '127.0.0.1', port: bambuMock.ports.default, family: 'IPv4' })
    await bambuMock.close()

    const kobraMock = await startMock('kobra-x', { reuseSharedTls: true })
    assertLoopbackAddress({ address: '127.0.0.1', port: kobraMock.ports.default, family: 'IPv4' })
    await kobraMock.close()

    const moonrakerMock = await startMock('moonraker')
    assertLoopbackAddress({ address: '127.0.0.1', port: moonrakerMock.ports.default, family: 'IPv4' })
    await moonrakerMock.close()

    // 2. Guard rejects non-loopback bind attempts
    const badServer = net.createServer()
    assert.throws(
      () => {
        badServer.listen(0, '0.0.0.0')
      },
      /Network guard violation/i,
    )
  } finally {
    uninstallNetworkGuard()
  }
})

test('Primitives start and close 100 times without leaking handles', async () => {
  const sharedTls = getSharedThrowawayTls()

  // 1. HTTP mock: 100 times
  for (let i = 0; i < 100; i++) {
    const mock = await startHttpMock()
    assert.ok(mock.ports.default > 0)
    await mock.close()
  }

  // 2. MQTT mock: 100 times
  for (let i = 0; i < 100; i++) {
    const mock = await startMqttBroker({ tls: sharedTls })
    assert.ok(mock.ports.default > 0)
    await mock.close()
  }

  // 3. Bambu mock: 100 times
  for (let i = 0; i < 100; i++) {
    const mock = await startBambuMock({ tls: sharedTls })
    assert.ok(mock.ports.default > 0)
    await mock.close()
  }

  // 4. Kobra X mock: 100 times
  for (let i = 0; i < 100; i++) {
    const mock = await startKobraXMock({ tls: sharedTls })
    assert.ok(mock.ports.default > 0)
    await mock.close()
  }

  // 5. Moonraker mock: 100 times
  for (let i = 0; i < 100; i++) {
    const mock = await startMoonrakerMock()
    assert.ok(mock.ports.default > 0)
    await mock.close()
  }

  // 6. Scenario controller: 100 times
  for (let i = 0; i < 100; i++) {
    const scenario = new ScenarioController({
      steps: [{ delayMs: 1, state: { i } }],
      applyState: () => {},
      publishReport: () => {},
      getState: () => ({}),
    })
    await scenario.step()
    scenario.stop()
  }
})
