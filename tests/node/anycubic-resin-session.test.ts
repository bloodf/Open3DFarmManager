import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import {
  createPhotonResinAdapter,
  photonResinModels,
  photonResinModelSupport,
  type PhotonResinSession,
} from '../../packages/connector/src/anycubic-resin/index.ts'
import {
  startPhotonHandshakeSimulator,
  startPhotonP1MaxSimulator,
} from '../../packages/sim-tools/src/anycubic-resin-simulator.ts'
import fixture from '../fixtures/anycubic-resin/p1-max-handshake.json' with { type: 'json' }

const serial = 'FIXTURE-P1-MAX'
type SimulatorOptions = Partial<Parameters<typeof startPhotonP1MaxSimulator>[0]>

async function simulate(t: TestContext, options: SimulatorOptions = {}) {
  const simulator = await startPhotonP1MaxSimulator({ ...fixture, ...options })
  t.after(() => simulator.close())
  const open = async (pinSha256 = simulator.pinSha256) => {
    const session = await createPhotonResinAdapter({
      ...simulator,
      timeoutMs: 1500,
    }).openSession({
      serial,
      pinSha256,
      brokerPort: simulator.brokerPort,
      cameraPort: simulator.cameraPort,
      commandTimeoutMs: 400,
    })
    t.after(() => session.close())
    return session
  }
  return { simulator, open }
}

async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'condition was not reported in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const sent = (received: string[], operation: string) =>
  received.filter((entry) => entry === operation).length

async function streamBytes(session: PhotonResinSession) {
  const url = session.state().camera?.url
  assert.ok(url)
  return (await fetch(url)).text()
}

test('only the P1 Max has a cited session, and every row cites a source', () => {
  assert.deepEqual(
    photonResinModels
      .filter((entry) => entry.session === 'cited')
      .map((entry) => entry.model),
    ['Anycubic Photon P1 Max'],
  )
  for (const model of ['M7', 'M7 Pro', 'M7 Max', '4 Ultra', 'M5s'].map(
    (suffix) =>
      `Anycubic Photon Mono ${suffix === '4 Ultra' ? '4 Ultra' : suffix}`,
  ))
    assert.equal(photonResinModelSupport(model).session, 'unverified', model)
  for (const entry of photonResinModels) {
    assert.ok(entry.sources.length, entry.model)
    assert.ok(entry.reason, entry.model)
  }
  assert.equal(
    photonResinModelSupport('Anycubic Photon Unknown').session,
    'unverified',
  )
})

for (const [modelId, modelName] of [
  ['unverified-m7-pro', 'Anycubic Photon Mono M7 Pro'],
  ['unverified-m5s', 'Anycubic Photon Mono M5s'],
  ['131', 'Anycubic Photon P1'],
] as const) {
  test(`${modelName} gets no credential exchange or session`, async (t) => {
    const { simulator, open } = await simulate(t, {
      identity: { ...fixture.identity, modelId, modelName },
    })
    await assert.rejects(open(), /Unsupported Photon LAN identity/)
    assert.equal(simulator.exchanges(), 0)
    assert.equal(simulator.brokerCalls().CONNECT, undefined)
  })
}

for (const [mode, allowed] of [
  ['lan', true],
  ['cloud', false],
] as const) {
  test(`ctrlType ${mode} ${allowed ? 'can' : 'cannot'} open a session`, async (t) => {
    const { simulator, open } = await simulate(t, {
      identity: { ...fixture.identity, ctrlType: mode },
    })
    if (allowed) assert.equal((await open()).state().printer?.activity, 'free')
    else {
      await assert.rejects(open(), /identity or mode mismatch/)
      assert.equal(simulator.exchanges(), 0)
    }
  })
}

test('a refused broker after negotiation yields no session', async (t) => {
  // The older P1 Max capture: /info and /ctrl succeed, then TCP is refused.
  const handshake = await startPhotonHandshakeSimulator(fixture)
  t.after(() => handshake.close())
  const closedPort = await startPhotonHandshakeSimulator(fixture)
  await closedPort.close()
  await assert.rejects(
    createPhotonResinAdapter(handshake).openSession({
      serial,
      pinSha256: '0'.repeat(64),
      brokerPort: closedPort.port,
    }),
    /broker refused the connection/,
  )
  assert.equal(handshake.exchanges(), 1)
})

test('an invalid pin is refused before any credential exchange', async (t) => {
  const { simulator, open } = await simulate(t)
  await assert.rejects(open('not-a-pin'), /Invalid Photon LAN session options/)
  assert.equal(simulator.exchanges(), 0)
})

test('a different certificate never receives the MQTT login', async (t) => {
  const { simulator, open } = await simulate(t)
  await assert.rejects(open('0'.repeat(64)), /does not match the pin/)
  assert.equal(simulator.brokerCalls().CONNECT, undefined)
})

for (const [name, method, message] of [
  ['rejected login', 'CONNECT', /refused the connection/],
  ['refused subscription', 'SUBSCRIBE', /refused the report subscription/],
] as const) {
  test(`a ${name} yields no session`, async (t) => {
    const { simulator, open } = await simulate(t)
    simulator.faults.setFault({ method, fault: { type: 'refuse' } })
    await assert.rejects(open(), message)
    assert.deepEqual(simulator.received(), [])
  })
}

test('a broker login without a printer status yields no session', async (t) => {
  const { simulator, open } = await simulate(t)
  simulator.ignored.add('status/query')
  await assert.rejects(open(), /returned no printer status/)
})

test('a link lost during the first reads yields no session', async (t) => {
  const { simulator, open } = await simulate(t)
  simulator.ignored.add('releaseFilm/get')
  const opening = assert.rejects(open(), /closed the session/)
  await until(() => simulator.received().includes('releaseFilm/get'))
  await simulator.disconnect()
  await opening
})

test('an authenticated session advertises only reported readings', async (t) => {
  const { simulator, open } = await simulate(t)
  const session = await open()
  const state = session.state()
  assert.equal(state.printer?.activity, 'free')
  assert.equal(state.job, null)
  assert.equal(state.resinTemperature?.celsius, 24.389999)
  assert.deepEqual(
    [state.releaseFilm?.times, state.releaseFilm?.layers],
    [12, 3456],
  )
  assert.equal(state.peripherals?.usbDisk, true)
  assert.deepEqual(session.capabilities(), [
    'status',
    'resin-temperature',
    'release-film-counter',
    'peripherals',
    'camera',
    'usb-print-start',
  ])

  simulator.setResinTemperature(26.5)
  await until(() => session.state().resinTemperature?.celsius === 26.5)

  const listed = await session.listLocalFiles()
  assert.equal(listed.outcome, 'confirmed')
  assert.deepEqual(listed.state.localFiles?.entries, [
    { name: 'cloud', directory: true, sizeBytes: 4096 },
  ])
  assert.ok(session.capabilities().includes('local-file-list'))

  session.close()
  assert.deepEqual(session.capabilities(), [])
  assert.equal(session.state().connected, false)
})

test('peripherals the printer lacks are neither advertised nor used', async (t) => {
  const { simulator, open } = await simulate(t, {
    camera: false,
    usbDisk: false,
  })
  const session = await open()
  assert.ok(!session.capabilities().includes('camera'))
  assert.ok(!session.capabilities().includes('usb-print-start'))
  assert.equal((await session.startCamera()).outcome, 'refused')
  assert.equal((await session.startUsbPrint('TEST.pp1m')).outcome, 'refused')
  assert.equal(sent(simulator.received(), 'video/startCapture'), 0)
  assert.equal(sent(simulator.received(), 'print/start'), 0)
})

test('the pinned session accepts the weak printer certificate', async (t) => {
  const { open } = await simulate(t, { weakCertificate: true })
  assert.equal((await open()).state().printer?.activity, 'free')
})

test('camera start and stop follow the printer reports', async (t) => {
  const { simulator, open } = await simulate(t)
  const session = await open()
  assert.equal(session.state().camera, null)

  const started = await session.startCamera()
  assert.equal(started.outcome, 'confirmed')
  assert.equal(started.state.cameraStreaming, true)
  assert.equal(started.state.camera?.rotationDegrees, 270)
  assert.equal(simulator.printer().cameraStreaming, true)
  assert.match(await streamBytes(session), /^FLV/)

  const stopped = await session.stopCamera()
  assert.equal(stopped.outcome, 'confirmed')
  assert.equal(stopped.state.cameraStreaming, false)
  assert.equal(stopped.state.camera, null)
  assert.equal(simulator.printer().cameraStreaming, false)
})

test('a camera command without a report stays uncertain', async (t) => {
  const { simulator, open } = await simulate(t)
  const session = await open()
  simulator.unreported.add('video/startCapture')
  const result = await session.startCamera()
  assert.equal(result.outcome, 'uncertain')
  assert.equal(result.state.cameraStreaming, null)
  assert.equal(sent(simulator.received(), 'video/startCapture'), 1)
})

test('a USB start and a stop are confirmed by job reports', async (t) => {
  const { simulator, open } = await simulate(t)
  const session = await open()

  const started = await session.startUsbPrint('TEST.pp1m')
  assert.equal(started.outcome, 'confirmed')
  assert.equal(started.state.job?.phase, 'printing')
  assert.equal(started.state.job?.filename, 'TEST.pp1m')
  assert.equal(started.state.job?.taskId, '0')
  assert.equal(started.state.job?.totalLayers, 697)
  assert.equal(started.state.job?.copyProgressPercent, null)
  assert.equal(simulator.printer().job?.filename, 'TEST.pp1m')
  assert.ok(session.capabilities().includes('print-stop'))

  assert.equal((await session.startUsbPrint('TEST.pp1m')).outcome, 'refused')
  assert.equal((await session.stopPrint('OTHER.pp1m')).outcome, 'refused')
  assert.equal(sent(simulator.received(), 'print/stop'), 0)

  const stopped = await session.stopPrint('TEST.pp1m')
  assert.equal(stopped.outcome, 'confirmed')
  assert.equal(stopped.state.job?.phase, 'stopped')
  assert.equal(stopped.state.job?.code, 601)
  assert.equal(simulator.printer().job, null)
  assert.ok(!session.capabilities().includes('print-stop'))
  assert.equal(sent(simulator.received(), 'print/start'), 1)
  assert.equal(sent(simulator.received(), 'print/stop'), 1)
})

test('the empty-vat stall is a waiting job that can be stopped', async (t) => {
  const { simulator, open } = await simulate(t, { vatEmpty: true })
  const session = await open()
  const started = await session.startUsbPrint('TEST.pp1m')
  assert.equal(started.outcome, 'confirmed')
  assert.equal(started.state.job?.phase, 'waiting')
  assert.equal(started.state.job?.code, 1301)
  assert.equal((await session.stopPrint('TEST.pp1m')).outcome, 'confirmed')
  assert.equal(simulator.printer().job, null)
})

test('a new session reads a running job from its report', async (t) => {
  const { open } = await simulate(t)
  const first = await open()
  await first.startUsbPrint('TEST.pp1m')
  first.close()
  const second = await open()
  await until(() => second.state().job !== null)
  assert.equal(second.state().job?.phase, 'printing')
  assert.equal((await second.stopPrint('TEST.pp1m')).outcome, 'confirmed')
})

for (const filename of ['../TEST.pp1m', 'dir/TEST.pp1m', 'TEST.gcode', '']) {
  test(`USB start refuses the name ${JSON.stringify(filename)}`, async (t) => {
    const { simulator, open } = await simulate(t)
    const session = await open()
    assert.equal((await session.startUsbPrint(filename)).outcome, 'refused')
    assert.equal(sent(simulator.received(), 'print/start'), 0)
  })
}

test('an ignored start is uncertain, sent once and blocks another', async (t) => {
  const { simulator, open } = await simulate(t)
  const session = await open()
  const missing = await session.startUsbPrint('MISSING.pp1m')
  assert.equal(missing.outcome, 'uncertain')
  assert.equal(missing.state.job, null)
  assert.equal(simulator.printer().job, null)
  const next = await session.startUsbPrint('TEST.pp1m')
  assert.equal(next.outcome, 'refused')
  assert.equal(sent(simulator.received(), 'print/start'), 1)
})

for (const fault of ['ignored', 'unreported'] as const) {
  test(`an ${fault} stop is uncertain whatever the printer did`, async (t) => {
    const { simulator, open } = await simulate(t)
    const session = await open()
    await session.startUsbPrint('TEST.pp1m')
    simulator[fault].add('print/stop')
    const result = await session.stopPrint('TEST.pp1m')
    assert.equal(result.outcome, 'uncertain')
    assert.equal(result.state.job?.phase, 'printing')
    assert.equal(simulator.printer().job === null, fault === 'unreported')
    assert.equal(sent(simulator.received(), 'print/stop'), 1)
    assert.equal((await session.startUsbPrint('TEST.pp1m')).outcome, 'refused')
    assert.equal(sent(simulator.received(), 'print/start'), 1)
  })
}

test('a disconnect during a command is uncertain and never retried', async (t) => {
  const { simulator, open } = await simulate(t)
  const session = await open()
  await session.startUsbPrint('TEST.pp1m')
  simulator.ignored.add('print/stop')
  const pending = session.stopPrint('TEST.pp1m')
  await until(() => simulator.received().includes('print/stop'))
  await simulator.disconnect()
  const result = await pending
  assert.equal(result.outcome, 'uncertain')
  assert.equal(result.state.connected, false)
  assert.deepEqual(session.capabilities(), [])
  assert.equal((await session.stopPrint('TEST.pp1m')).outcome, 'refused')
  assert.equal(sent(simulator.received(), 'print/stop'), 1)
  assert.equal(simulator.brokerCalls().CONNECT, 1)
})

test('only one control command runs at a time', async (t) => {
  const { simulator, open } = await simulate(t)
  const session = await open()
  const [first, second] = await Promise.all([
    session.startCamera(),
    session.startUsbPrint('TEST.pp1m'),
  ])
  assert.equal(first.outcome, 'confirmed')
  assert.equal(second.outcome, 'refused')
  assert.equal(simulator.printer().job, null)
})

test('a stop needs a fresh status answer', async (t) => {
  const { simulator, open } = await simulate(t)
  const session = await open()
  await session.startUsbPrint('TEST.pp1m')
  simulator.ignored.add('status/query')
  assert.equal((await session.stopPrint('TEST.pp1m')).outcome, 'refused')
  assert.equal(sent(simulator.received(), 'print/stop'), 0)
  assert.equal(simulator.printer().job?.filename, 'TEST.pp1m')
})

test('captured pause and resume refusals leave the job unchanged', async (t) => {
  const { simulator, open } = await simulate(t)
  const session = await open()
  await session.startUsbPrint('TEST.pp1m')
  const before = session.state().job
  simulator.publish('print', 'pause', 'unablePause', { taskid: '0' })
  simulator.publish('print', 'resume', 'unable-resume', { taskid: '' })
  simulator.publish('print', 'monitor', 'monitoring', { taskid: '-1' })
  simulator.setResinTemperature(30)
  await until(() => session.state().resinTemperature?.celsius === 30)
  assert.deepEqual(session.state().job, before)
})

test('an uncaptured job state is unknown and cannot be commanded', async (t) => {
  const { simulator, open } = await simulate(t)
  const session = await open()
  await session.startUsbPrint('TEST.pp1m')
  simulator.publish('print', 'pause', 'paused', {
    taskid: '0',
    filename: 'TEST.pp1m',
  })
  await until(() => session.state().job?.phase === 'unknown')
  assert.ok(!session.capabilities().includes('print-stop'))
  assert.equal((await session.stopPrint('TEST.pp1m')).outcome, 'refused')
  assert.equal(sent(simulator.received(), 'print/stop'), 0)
})

test('foreign, malformed and retained reports change nothing', async (t) => {
  const { simulator, open } = await simulate(t)
  const session = await open()
  const topic = simulator.reportTopic('properties')
  const report = (celsius: unknown) => ({
    type: 'properties',
    action: 'report',
    data: { resin_temp: celsius },
  })
  simulator.publishRaw(topic, '{broken')
  simulator.publishRaw(topic, report('30'))
  simulator.publishRaw(topic, report(500))
  simulator.publishRaw(topic.replace('fixture-device', 'other'), report(31))
  simulator.setResinTemperature(25)
  await until(() => session.state().resinTemperature?.celsius === 25)
  assert.equal(session.state().connected, true)
})

test('pause, resume, upload and resin metering send nothing', async (t) => {
  const { simulator, open } = await simulate(t)
  const session = await open()
  await session.startUsbPrint('TEST.pp1m')
  const before = simulator.received()
  for (const [result, reason] of [
    [await session.pausePrint(), /refused pause and a refused resume/],
    [await session.resumePrint(), /refused pause and a refused resume/],
    [await session.uploadFile(), /no P1 Max upload request/],
  ] as const) {
    assert.equal(result.outcome, 'refused')
    assert.ok('reason' in result)
    assert.match(result.reason, reason)
    assert.match(result.reason, /https:\/\//)
    assert.equal(result.state.job?.phase, 'printing')
  }
  const metering = session.measuredResinUsage()
  assert.equal(metering.measuredVolumeMl, null)
  assert.match(metering.reason, /Actual_volume is null/)
  // The estimate stays an estimate through the stop: nothing is consumed.
  const stopped = await session.stopPrint('TEST.pp1m')
  assert.equal(stopped.state.job?.estimatedVolumeMl, 25.17914)
  assert.equal(session.measuredResinUsage().measuredVolumeMl, null)
  assert.deepEqual(simulator.received().slice(before.length), [
    'status/query',
    'print/stop',
  ])
})
