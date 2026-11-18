// SPDX-License-Identifier: MIT
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getSimMode,
  installNetworkGuard,
  uninstallNetworkGuard,
  assertLoopbackAddress,
} from '../../packages/sim-tools/src/mocks/index.ts'
import { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'
import { startAnycubicSimulator } from '../../packages/sim-tools/src/anycubic-simulator.ts'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'
import { startAnycubicCameraSim } from '../../packages/sim-tools/src/anycubic-camera-sim.ts'
import { startAnycubicDiscoverySimulator } from '../../packages/sim-tools/src/anycubic-discovery-sim.ts'
import { startCrealityDiscoverySimulator } from '../../packages/sim-tools/src/creality-discovery-sim.ts'

import { createBambuTransport } from '../../packages/connector/src/bambu/transport.ts'
import { decodeBambuReport } from '../../packages/connector/src/bambu/report.ts'
import {
  openFixedBambuControl,
  BambuControlTimeout,
} from '../../packages/connector/src/bambu/control-driver.ts'

import { createAnycubicLanClient } from '../../packages/connector/src/anycubic/transport.ts'
import { decodeAnycubicReport } from '../../packages/connector/src/anycubic/report.ts'
import {
  openFixedAnycubicControl,
  AnycubicControlTimeout,
} from '../../packages/connector/src/anycubic/control-driver.ts'
import { streamAnycubicJpegs } from '../../packages/connector/src/anycubic/camera.ts'

import { createCrealityTelemetryClient } from '../../packages/connector/src/creality/index.ts'
import {
  openFixedCrealityControl,
  CrealityControlTimeout,
} from '../../packages/connector/src/creality/control-driver.ts'

import { discoverPrinters } from '../../packages/connector/src/discovery/index.ts'
import { probeAnycubic } from '../../packages/connector/src/discovery/anycubic.ts'
import { probeCreality } from '../../packages/connector/src/discovery/creality.ts'

import {
  provisionBambuPrinter,
  provisionAnycubicPrinter,
  provisionCrealityPrinter,
} from '../../packages/connector/src/control/printer-binding.ts'
import { startVendorSimulator } from '../journey/harness-vendors.ts'

function pinOf(pem) {
  return createHash('sha256').update(new X509Certificate(pem).raw).digest('hex')
}

test('node packages/sim-tools/src/bambu-cli.ts runs on the harness version and shuts down cleanly', async () => {
  const child = spawn(
    process.execPath,
    ['packages/sim-tools/src/bambu-cli.ts'],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    },
  )

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error(`bambu-cli banner timeout: ${stdout}`)),
        5000,
      )
      const onData = () => {
        if (
          stdout.includes('SIMULADOR SINTÉTICO') &&
          stdout.includes('device/SYNTHETIC/report') &&
          stdout.includes('BEGIN CERTIFICATE')
        ) {
          clearTimeout(deadline)
          child.stdout.off('data', onData)
          resolve()
        }
      }
      child.stdout.on('data', onData)
      child.once('error', reject)
      child.once('exit', (code) => {
        clearTimeout(deadline)
        reject(new Error(`bambu-cli exited early with code ${code}: ${stderr}`))
      })
    })

    child.stdin.write('{"print":{"gcode_state":"RUNNING","mc_percent":42}}\n')
    child.stdin.write('/disconnect\n')
    child.stdin.write('/quit\n')
    child.stdin.end()

    const [code, signal] = await new Promise((resolve) => {
      child.once('exit', (c, s) => resolve([c, s]))
    })
    assert.equal(signal, null)
    assert.equal(code, 0)
    assert.equal(stderr, '')
  } finally {
    if (!child.killed && child.exitCode === null) {
      child.kill('SIGKILL')
    }
  }
})

test('All simulators enforce loopback binding under network guard and support scenario scripting', async () => {
  const orig = process.env.OPENFARM_SIM
  delete process.env.OPENFARM_SIM
  assert.equal(getSimMode(), 'mock')
  process.env.OPENFARM_SIM = 'docker'
  assert.equal(getSimMode(), 'docker')
  if (orig !== undefined) process.env.OPENFARM_SIM = orig
  else delete process.env.OPENFARM_SIM

  installNetworkGuard()
  try {
    const bambu = await startBambuSimulator({
      initialState: 'RUNNING',
      scenario: [{ delayMs: 5, state: { gcodeState: 'PAUSE' } }],
    })
    assertLoopbackAddress({
      address: bambu.host,
      port: bambu.port,
      family: 'IPv4',
    })
    await bambu.control.scenario.run()
    assert.equal(bambu.gcodeState, 'PAUSE')
    await bambu.close()

    const anycubic = await startAnycubicSimulator({
      initialState: 'RUNNING',
      scenario: [{ delayMs: 5, state: { lifecycle: 'paused', progress: 55 } }],
    })
    assertLoopbackAddress({
      address: anycubic.host,
      port: anycubic.port,
      family: 'IPv4',
    })
    await anycubic.control.scenario.run()
    assert.equal(anycubic.lifecycle.state, 'paused')
    assert.equal(anycubic.lifecycle.progress, 55)
    await anycubic.close()

    const creality = await createCrealitySimulator(
      { state: 1, printProgress: 10 },
      { scenario: [{ delayMs: 5, state: { state: 2, printProgress: 60 } }] },
    )
    assertLoopbackAddress({
      address: '127.0.0.1',
      port: creality.port,
      family: 'IPv4',
    })
    assertLoopbackAddress({
      address: '127.0.0.1',
      port: creality.httpPort,
      family: 'IPv4',
    })
    await creality.control.scenario.run()
    assert.equal(creality.state.state, 2)
    assert.equal(creality.state.printProgress, 60)
    await creality.close()

    const camera = await startAnycubicCameraSim({
      jpeg: Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]),
      scenario: [{ delayMs: 5, state: { active: true } }],
    })
    assertLoopbackAddress({
      address: camera.host,
      port: camera.port,
      family: 'IPv4',
    })
    await camera.control.scenario.run()
    assert.equal(camera.control.getState().active, true)
    await camera.close()

    const anycubicDisc = await startAnycubicDiscoverySimulator({
      scenario: [{ delayMs: 5, state: { modelName: 'Anycubic Scenario K3' } }],
    })
    assertLoopbackAddress({
      address: anycubicDisc.host,
      port: anycubicDisc.port,
      family: 'IPv4',
    })
    await anycubicDisc.control.scenario.run()
    assert.equal(
      anycubicDisc.control.getInfo().modelName,
      'Anycubic Scenario K3',
    )
    await anycubicDisc.close()

    const crealityDisc = await startCrealityDiscoverySimulator({
      scenario: [{ delayMs: 5, state: { model: 'Creality Scenario K2' } }],
    })
    assertLoopbackAddress({
      address: crealityDisc.host,
      port: crealityDisc.port,
      family: 'IPv4',
    })
    await crealityDisc.control.scenario.run()
    assert.equal(crealityDisc.control.getInfo().model, 'Creality Scenario K2')
    await crealityDisc.close()
  } finally {
    uninstallNetworkGuard()
  }
})

test('Bambu simulator faults: broker disconnect, auth refusal, malformed report, slow ack in Connector', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'e16-355-bambu-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const sim = await startBambuSimulator({
    serial: 'SYNTHETIC',
    initialState: 'RUNNING',
    credentials: { username: 'bblp', password: 'correct-password' },
  })
  t.after(() => sim.close())

  // 1. Auth refusal via wrong credentials and via explicit CONNECT refuse fault
  for (const injectFault of [false, true]) {
    if (injectFault) {
      sim.control.faults.setFault({
        method: 'CONNECT',
        count: 1,
        fault: { type: 'refuse', code: 5 },
      })
    }
    const states = []
    const ac = new AbortController()
    const client = createBambuTransport({
      host: sim.host,
      port: sim.port,
      serial: 'SYNTHETIC',
      credentials: {
        username: 'bblp',
        password: injectFault ? 'correct-password' : 'wrong-password',
      },
      caPem: sim.syntheticTrust,
      pinSha256: pinOf(sim.syntheticTrust),
      limits: {
        maxFrameBytes: 65536,
        connectTimeoutMs: 500,
        maxInflight: 8,
        reconnectDelayMs: 50,
        maxReconnects: 0,
      },
      signal: ac.signal,
      onReport: () => {},
      onConnection: (s) => states.push(s),
    })
    await client.done
    assert.equal(states.includes('connected'), false)
    assert.equal(states.at(-1), 'closed')
  }

  // 2. Broker disconnect fault on REPORT
  {
    const states = []
    let sawConnected
    const connectedReady = new Promise((resolve) => {
      sawConnected = resolve
    })
    const ac = new AbortController()
    const client = createBambuTransport({
      host: sim.host,
      port: sim.port,
      serial: 'SYNTHETIC',
      credentials: { username: 'bblp', password: 'correct-password' },
      caPem: sim.syntheticTrust,
      pinSha256: pinOf(sim.syntheticTrust),
      limits: {
        maxFrameBytes: 65536,
        connectTimeoutMs: 500,
        maxInflight: 8,
        reconnectDelayMs: 50,
        maxReconnects: 0,
      },
      signal: ac.signal,
      onReport: () => {},
      onConnection: (s) => {
        states.push(s)
        if (s === 'connected') sawConnected()
      },
    })
    await connectedReady
    sim.control.faults.setFault({
      method: 'REPORT',
      count: 1,
      fault: { type: 'drop' },
    })
    sim.publishReport({ print: { gcode_state: 'RUNNING', mc_percent: 30 } })
    await client.done
    assert.ok(states.includes('disconnected'))
    assert.equal(states.at(-1), 'closed')
  }

  // 3. Malformed report fault
  {
    let malformedReceived
    const gotMalformed = new Promise((resolve) => {
      malformedReceived = resolve
    })
    const ac = new AbortController()
    const client = createBambuTransport({
      host: sim.host,
      port: sim.port,
      serial: 'SYNTHETIC',
      credentials: { username: 'bblp', password: 'correct-password' },
      caPem: sim.syntheticTrust,
      pinSha256: pinOf(sim.syntheticTrust),
      limits: {
        maxFrameBytes: 65536,
        connectTimeoutMs: 500,
        maxInflight: 8,
        reconnectDelayMs: 50,
        maxReconnects: 0,
      },
      signal: ac.signal,
      onReport: (payload) => {
        const decoded = decodeBambuReport(payload.toString('utf8'))
        if (decoded.kind === 'invalid') malformedReceived(decoded)
      },
      onConnection: () => {},
    })
    sim.control.faults.setFault({
      method: 'REPORT',
      count: 1,
      fault: { type: 'malformed', payload: '{malformed-bambu' },
    })
    const decoded = await gotMalformed
    assert.equal(decoded.kind, 'invalid')
    await client.close()
  }

  // 4. Slow ack fault against openFixedBambuControl
  {
    const credFile = join(dir, 'bambu-cred.json')
    writeFileSync(
      credFile,
      JSON.stringify({ accessCode: 'correct-password' }),
      {
        mode: 0o600,
      },
    )
    const caFile = join(dir, 'bambu-ca.pem')
    writeFileSync(caFile, sim.syntheticTrust)

    const binding = provisionBambuPrinter(
      {
        assignment_id: randomUUID(),
        farm_id: randomUUID(),
        agent_id: randomUUID(),
        printer_key: 'bambu-fault-test',
      },
      {
        printerKey: 'bambu-fault-test',
        serial: 'SYNTHETIC',
        host: sim.host,
        port: sim.port,
        control: true,
        credentialFile: credFile,
        caFile,
        pinSha256: pinOf(sim.syntheticTrust),
        allowedEndpoints: [{ host: sim.host, port: sim.port }],
      },
    )

    const ac = new AbortController()
    const control = openFixedBambuControl({
      binding,
      connectionGeneration: 1,
      clock: { monotonicNow: () => performance.now() },
      publish: () => {},
      signal: ac.signal,
      timeoutMs: 80,
    })
    try {
      await control.prepare()
      sim.control.faults.setFault({
        method: 'ACK',
        count: 1,
        fault: { type: 'delay', delayMs: 250 },
      })
      await assert.rejects(
        () =>
          control.driver.pauseOnce({
            binding,
            signal: ac.signal,
            beforeSend: () => true,
          }),
        (err) => err instanceof BambuControlTimeout,
      )
    } finally {
      await control.close()
    }
  }
})

test('Anycubic simulator faults: broker disconnect, auth refusal, malformed report, slow ack in Connector', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'e16-355-anycubic-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const serial = '20024/SYNTHETIC'
  const credentials = { username: 'lan-user', password: 'lan-password' }
  const sim = await startAnycubicSimulator({
    serial,
    initialState: 'RUNNING',
    credentials,
    reportIntervalMs: 50,
  })
  t.after(() => sim.close())

  // 1. Auth refusal (wrong password and CONNECT refuse fault)
  for (const injectFault of [false, true]) {
    if (injectFault) {
      sim.control.faults.setFault({
        method: 'CONNECT',
        count: 1,
        fault: { type: 'refuse', code: 5 },
      })
    }
    const states = []
    const ac = new AbortController()
    const client = createAnycubicLanClient({
      host: sim.host,
      port: sim.port,
      serial,
      credentials: {
        username: credentials.username,
        password: injectFault ? credentials.password : 'wrong-password',
      },
      caPem: sim.syntheticTrust,
      pinSha256: pinOf(sim.syntheticTrust),
      limits: {
        maxFrameBytes: 65536,
        connectTimeoutMs: 500,
        maxInflight: 8,
        reconnectDelayMs: 50,
        maxReconnects: 0,
      },
      signal: ac.signal,
      onReport: () => {},
      onConnection: (s) => states.push(s),
    })
    await client.done
    assert.equal(states.includes('connected'), false)
    assert.equal(states.at(-1), 'closed')
  }

  // 2. Broker disconnect fault on REPORT
  {
    const states = []
    let sawConnected
    const connectedReady = new Promise((resolve) => {
      sawConnected = resolve
    })
    const ac = new AbortController()
    const client = createAnycubicLanClient({
      host: sim.host,
      port: sim.port,
      serial,
      credentials,
      caPem: sim.syntheticTrust,
      pinSha256: pinOf(sim.syntheticTrust),
      limits: {
        maxFrameBytes: 65536,
        connectTimeoutMs: 500,
        maxInflight: 8,
        reconnectDelayMs: 50,
        maxReconnects: 0,
      },
      signal: ac.signal,
      onReport: () => {},
      onConnection: (s) => {
        states.push(s)
        if (s === 'connected') sawConnected()
      },
    })
    await connectedReady
    sim.control.faults.setFault({
      method: 'REPORT',
      count: 1,
      fault: { type: 'drop' },
    })
    sim.publishReport({ data: { state: 'printing', progress: 33 } })
    await client.done
    assert.ok(states.includes('disconnected'))
    assert.equal(states.at(-1), 'closed')
  }

  // 3. Malformed report fault
  {
    let malformedReceived
    const gotMalformed = new Promise((resolve) => {
      malformedReceived = resolve
    })
    const ac = new AbortController()
    const client = createAnycubicLanClient({
      host: sim.host,
      port: sim.port,
      serial,
      credentials,
      caPem: sim.syntheticTrust,
      pinSha256: pinOf(sim.syntheticTrust),
      limits: {
        maxFrameBytes: 65536,
        connectTimeoutMs: 500,
        maxInflight: 8,
        reconnectDelayMs: 50,
        maxReconnects: 0,
      },
      signal: ac.signal,
      onReport: (payload) => {
        const decoded = decodeAnycubicReport(payload)
        if (decoded.kind === 'invalid') malformedReceived(decoded)
      },
      onConnection: () => {},
    })
    sim.control.faults.setFault({
      method: 'REPORT',
      count: 1,
      fault: { type: 'malformed', payload: '{malformed-anycubic' },
    })
    const decoded = await gotMalformed
    assert.equal(decoded.kind, 'invalid')
    await client.close()
  }

  // 4. Slow ack fault against openFixedAnycubicControl
  {
    const passFile = join(dir, 'anycubic-pass.json')
    writeFileSync(passFile, JSON.stringify(credentials.password), {
      mode: 0o600,
    })
    const caFile = join(dir, 'anycubic-ca.pem')
    writeFileSync(caFile, sim.syntheticTrust)

    const binding = provisionAnycubicPrinter(
      {
        assignment_id: randomUUID(),
        farm_id: randomUUID(),
        agent_id: randomUUID(),
        printer_key: 'anycubic-fault-test',
      },
      {
        printerKey: 'anycubic-fault-test',
        host: sim.host,
        port: sim.port,
        modelId: '20024',
        deviceId: 'SYNTHETIC',
        username: credentials.username,
        passwordFile: passFile,
        caFile,
        pinSha256: pinOf(sim.syntheticTrust),
      },
    )

    sim.setPrintProgress(25)
    const ac = new AbortController()
    const control = openFixedAnycubicControl({
      binding,
      connectionGeneration: 1,
      clock: { monotonicNow: () => performance.now() },
      publish: () => {},
      signal: ac.signal,
      timeoutMs: 80,
    })
    try {
      await control.prepare()
      sim.control.faults.setFault({
        method: 'ACK',
        count: 1,
        fault: { type: 'delay', delayMs: 250 },
      })
      await assert.rejects(
        () =>
          control.driver.pauseOnce({
            binding,
            signal: ac.signal,
            beforeSend: () => true,
          }),
        (err) => err instanceof AnycubicControlTimeout,
      )
    } finally {
      await control.close()
    }
  }
})

test('Creality simulator faults: disconnect, auth refusal, malformed report, slow ack in Connector', async (t) => {
  const sim = await createCrealitySimulator({
    state: 1,
    printProgress: 25,
    nozzleTemp: 210,
    bedTemp: 60,
  })
  t.after(() => sim.close())

  const binding = provisionCrealityPrinter(
    {
      assignment_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      printer_key: 'creality-fault-test',
    },
    {
      printerKey: 'creality-fault-test',
      host: '127.0.0.1',
      port: sim.port,
      httpPort: sim.httpPort,
    },
  )

  // 1. Auth refusal on WS UPGRADE
  {
    sim.control.faults.setFault({
      method: 'UPGRADE',
      count: 1,
      fault: { type: 'refuse', statusCode: 401 },
    })
    const ac = new AbortController()
    const control = openFixedCrealityControl({
      binding,
      connectionGeneration: 1,
      clock: { monotonicNow: () => performance.now() },
      publish: () => {},
      signal: ac.signal,
      timeoutMs: 250,
    })
    await assert.rejects(() => control.prepare())
    await control.close()
  }

  // 2. Malformed report & disconnect faults on Creality telemetry client
  {
    const frames = []
    let disconnects = 0
    let onFirstValid
    const firstValid = new Promise((resolve) => {
      onFirstValid = resolve
    })
    let onSecondValid
    const secondValid = new Promise((resolve) => {
      onSecondValid = resolve
    })
    let onDisconnectEvent
    const disconnectEvent = new Promise((resolve) => {
      onDisconnectEvent = resolve
    })

    // First connection gets a malformed report initially; verify it does not crash
    // and processes a subsequent valid frame cleanly.
    sim.control.faults.setFault({
      method: 'REPORT',
      count: 1,
      fault: { type: 'malformed', payload: '{malformed-creality' },
    })

    const client = createCrealityTelemetryClient({
      host: '127.0.0.1',
      port: sim.port,
      reconnectDelayMs: 20,
      maxReconnectDelayMs: 50,
      onTelemetry: (rep) => {
        frames.push(rep)
        if (frames.length === 1) onFirstValid()
        if (frames.length === 2) onSecondValid()
      },
      onDisconnect: () => {
        disconnects++
        onDisconnectEvent()
      },
    })

    try {
      // Wait briefly for initial malformed frame to be dropped safely, then push valid frame
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(frames.length, 0)
      sim.setFrame({ state: 1, printProgress: 40 })
      await firstValid
      assert.equal(frames[0].progress, 40)

      // Now inject a broker/WS disconnect fault on next REPORT
      sim.control.faults.setFault({
        method: 'REPORT',
        count: 1,
        fault: { type: 'drop' },
      })
      sim.setFrame({ state: 1, printProgress: 45 })
      await disconnectEvent
      assert.ok(disconnects >= 1)

      // Client reconnects and receives valid frame again
      await secondValid
    } finally {
      await client.close()
    }
  }

  // 3. Slow ack fault against openFixedCrealityControl
  {
    const ac = new AbortController()
    const control = openFixedCrealityControl({
      binding,
      connectionGeneration: 2,
      clock: { monotonicNow: () => performance.now() },
      publish: () => {},
      signal: ac.signal,
      timeoutMs: 80,
    })
    try {
      await control.prepare()
      sim.control.faults.setFault({
        method: 'ACK',
        count: 1,
        fault: { type: 'delay', delayMs: 250 },
      })
      await assert.rejects(
        () =>
          control.driver.pauseOnce({
            binding,
            signal: ac.signal,
            beforeSend: () => true,
          }),
        (err) => err instanceof CrealityControlTimeout,
      )
    } finally {
      await control.close()
    }
  }
})

test('Anycubic camera simulator faults: disconnect, auth refusal, malformed frame, slow ack in Connector', async (t) => {
  const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9])
  const auth = { username: 'cam', password: 'secret' }
  const sim = await startAnycubicCameraSim({ jpeg, auth, frameCount: 2 })
  t.after(() => sim.close())

  // 1. Auth refusal
  {
    const frames = streamAnycubicJpegs({
      source: {
        kind: 'rinkhals',
        host: sim.host,
        port: sim.port,
        auth: { username: 'cam', password: 'wrong' },
      },
      signal: new AbortController().signal,
      maxReconnects: 0,
      reconnectDelayMs: 1,
    })
    await assert.rejects(frames.next(), {
      message: 'Anycubic camera unavailable',
    })
  }

  // 2. Drop / disconnect fault
  {
    sim.control.faults.setFault({
      method: 'GET',
      count: 1,
      fault: { type: 'drop' },
    })
    const frames = streamAnycubicJpegs({
      source: { kind: 'rinkhals', host: sim.host, port: sim.port, auth },
      signal: new AbortController().signal,
      maxReconnects: 0,
      reconnectDelayMs: 1,
    })
    await assert.rejects(frames.next(), {
      message: 'Anycubic camera unavailable',
    })
  }

  // 3. Malformed frame fault
  {
    sim.control.faults.setFault({
      method: 'REPORT',
      count: 1,
      fault: { type: 'malformed', payload: Buffer.from('not-a-jpeg') },
    })
    const frames = streamAnycubicJpegs({
      source: { kind: 'rinkhals', host: sim.host, port: sim.port, auth },
      signal: new AbortController().signal,
      maxReconnects: 0,
      reconnectDelayMs: 1,
    })
    await assert.rejects(frames.next(), {
      message: 'Anycubic camera unavailable',
    })
  }

  // 4. Slow ack fault aborted by deadline signal, then recovers
  {
    sim.control.faults.setFault({
      method: 'ACK',
      count: 1,
      fault: { type: 'delay', delayMs: 200 },
    })
    const framesSlow = streamAnycubicJpegs({
      source: { kind: 'rinkhals', host: sim.host, port: sim.port, auth },
      signal: AbortSignal.timeout(50),
      maxReconnects: 0,
      reconnectDelayMs: 1,
    })
    const slowNext = await framesSlow.next()
    assert.equal(slowNext.done, true)

    const ac = new AbortController()
    const framesOk = streamAnycubicJpegs({
      source: { kind: 'rinkhals', host: sim.host, port: sim.port, auth },
      signal: ac.signal,
      maxReconnects: 0,
      reconnectDelayMs: 1,
    })
    const first = await framesOk.next()
    assert.deepEqual(first.value, jpeg)
    ac.abort()
    await framesOk.return(undefined)
  }
})

test('Discovery simulators (Anycubic and Creality) work with Connector discovery and support all faults', async (t) => {
  const anycubicDisc = await startAnycubicDiscoverySimulator()
  t.after(() => anycubicDisc.close())

  const crealityDisc = await startCrealityDiscoverySimulator({
    duplicateMdns: true,
  })
  t.after(() => crealityDisc.close())

  // Happy path via real discoverPrinters + probeAnycubic + probeCreality
  const foundAnycubic = await discoverPrinters({
    timeout: 100,
    bambuPorts: [],
    mdnsPort: 0,
    bindAddress: '127.0.0.1',
    queryAddress: '127.0.0.1',
    queryPort: anycubicDisc.udpPort,
    anycubicPort: anycubicDisc.port,
  })
  assert.deepEqual(
    foundAnycubic.find((p) => p.vendor === 'anycubic'),
    {
      vendor: 'anycubic',
      host: '127.0.0.1',
      port: anycubicDisc.port,
      serial: 'simulator',
      model: 'K3',
      name: 'Anycubic Kobra 3',
    },
  )

  const foundCreality = await discoverPrinters({
    timeout: 100,
    bambuPorts: [],
    mdnsPort: 0,
    bindAddress: '127.0.0.1',
    queryAddress: '127.0.0.1',
    queryPort: crealityDisc.udpPort,
    crealityPorts: { https: crealityDisc.port, http: crealityDisc.port },
  })
  assert.deepEqual(foundCreality, [
    {
      vendor: 'creality',
      host: '127.0.0.1',
      model: 'Creality K1',
      serial: 'AA:BB:CC:00:00:01',
    },
  ])

  // Faults on Anycubic discovery: drop, refuse (401), malformed, delay (slow ack)
  for (const fault of [
    { method: 'GET', count: 1, fault: { type: 'drop' } },
    { method: 'GET', count: 1, fault: { type: 'refuse', statusCode: 401 } },
    {
      method: 'REPORT',
      count: 1,
      fault: { type: 'malformed', payload: '{bad-json' },
    },
    { method: 'ACK', count: 1, fault: { type: 'delay', delayMs: 1150 } },
  ]) {
    anycubicDisc.control.faults.setFault(fault)
    const probed = await probeAnycubic('127.0.0.1', anycubicDisc.port)
    assert.equal(probed, undefined)
  }
  assert.ok(await probeAnycubic('127.0.0.1', anycubicDisc.port))

  // Faults on Creality discovery: drop, refuse (401), malformed, MDNS delay
  for (const fault of [
    { method: 'GET', count: 1, fault: { type: 'drop' } },
    { method: 'GET', count: 1, fault: { type: 'refuse', statusCode: 401 } },
    {
      method: 'REPORT',
      count: 1,
      fault: { type: 'malformed', payload: '{bad-json' },
    },
  ]) {
    crealityDisc.control.faults.setFault(fault)
    const probed = await probeCreality('127.0.0.1', {
      https: crealityDisc.port,
      http: crealityDisc.port,
    })
    assert.equal(probed, undefined)
  }

  crealityDisc.control.faults.setFault({
    method: 'MDNS',
    count: 2,
    fault: { type: 'delay', delayMs: 250 },
  })
  const timedOutCreality = await discoverPrinters({
    timeout: 80,
    bambuPorts: [],
    mdnsPort: 0,
    bindAddress: '127.0.0.1',
    queryAddress: '127.0.0.1',
    queryPort: crealityDisc.udpPort,
    crealityPorts: { https: crealityDisc.port, http: crealityDisc.port },
  })
  assert.deepEqual(timedOutCreality, [])
  assert.ok(
    await probeCreality('127.0.0.1', {
      https: crealityDisc.port,
      http: crealityDisc.port,
    }),
  )
})

test('Journey harness vendor simulators (bambu, anycubic, creality) remain compatible', async () => {
  for (const name of ['bambu', 'anycubic', 'creality']) {
    const vendor = await startVendorSimulator(name, {
      printerKey: `${name}-journey-check`,
      control: name === 'bambu',
    })
    try {
      const runtime = await vendor.runtime({
        farmId: randomUUID(),
        agentId: randomUUID(),
        assignmentId: randomUUID(),
        printerKey: `${name}-journey-check`,
      })
      assert.ok(runtime.collection)
      vendor.controls.setProgress(50)
      vendor.controls.finishPrint()
      if (name === 'bambu') {
        assert.equal(vendor.raw.gcodeState, 'FINISH')
      } else if (name === 'anycubic') {
        assert.equal(vendor.raw.lifecycle.state, 'finished')
      } else {
        assert.equal(vendor.raw.state.state, 0)
        assert.equal(vendor.raw.state.printProgress, 100)
      }
      vendor.controls.setProgress(40)
      vendor.controls.failPrint()
      if (name === 'bambu') {
        assert.equal(vendor.raw.gcodeState, 'FAILED')
      } else if (name === 'anycubic') {
        assert.equal(vendor.raw.lifecycle.state, 'error')
      } else {
        assert.equal(vendor.raw.state.err, 1)
      }
      if (vendor.discovery) {
        const discovered = await vendor.discovery.probe()
        assert.ok(discovered)
        assert.equal(discovered.vendor, name)
      }
    } finally {
      await vendor.close()
    }
  }
})
