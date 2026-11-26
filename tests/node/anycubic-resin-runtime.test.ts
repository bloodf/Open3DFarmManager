// Runtime wiring against the loopback Photon P1 Max simulator only. The
// qualification entries below are test-only; the shipped list is empty.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import { createPhotonResinCameraSource } from '../../packages/connector/src/anycubic-resin/camera.ts'
import {
  createPhotonResinCollection,
  type PhotonResinSessions,
} from '../../packages/connector/src/anycubic-resin/collection.ts'
import {
  PHOTON_RESIN_QUALIFIED_WRITES,
  PHOTON_RESIN_UNREPORTED_FIRMWARE,
  type PhotonResinQualification,
} from '../../packages/connector/src/anycubic-resin/qualification.ts'
import { DriverRefusalError } from '../../packages/connector/src/control/driver-refusal.ts'
import { provisionPhotonResinPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import { parseCollectorConfig } from '../../packages/connector/src/prusa/config.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import type { RawPrinterObservation } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import { PrinterState } from '../../packages/farm-protocol/src/state.ts'
import { startPhotonP1MaxSimulator } from '../../packages/sim-tools/src/anycubic-resin-simulator.ts'
import fixture from '../fixtures/anycubic-resin/p1-max-handshake.json' with { type: 'json' }

const model = 'Anycubic Photon P1 Max'
const testOnlyQualified: PhotonResinQualification[] = [
  {
    operation: 'print-stop',
    model,
    firmwareVersion: PHOTON_RESIN_UNREPORTED_FIRMWARE,
  },
]

async function until(condition: () => boolean) {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'condition was not reported in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function collect(t: TestContext) {
  const simulator = await startPhotonP1MaxSimulator(fixture)
  t.after(() => simulator.close())
  simulator.startJob('journey.pp1m', 25, 174)
  const origin = `http://${simulator.host}:${simulator.port}`
  const sessions: PhotonResinSessions = new Map()
  const observations: RawPrinterObservation[] = []
  const unavailable: number[] = []
  const controller = new AbortController()
  const binding = {
    family: 'anycubic-resin' as const,
    printerKey: 'resin-1',
    origin,
    pinSha256: simulator.pinSha256,
    brokerPort: simulator.brokerPort,
    cameraPort: simulator.cameraPort,
    simulated: true,
    expect: { serial: fixture.identity.cn, model },
  }
  const collection = createPhotonResinCollection({
    binding,
    allowedOrigins: [origin],
    signal: controller.signal,
    timeoutMs: 2000,
    sessions,
    pollMs: 50,
    reconnectMs: 50,
    onObservation: (value) => observations.push(value),
    onUnavailable: (epoch) => unavailable.push(epoch),
  })
  t.after(async () => {
    controller.abort()
    await collection.done
  })
  await until(() => observations.length > 0)
  return { simulator, sessions, observations, unavailable, binding }
}

function control(
  sessions: PhotonResinSessions,
  qualified?: PhotonResinQualification[],
) {
  const binding = provisionPhotonResinPrinter(
    {
      assignment_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      printer_key: 'resin-1',
    },
    { printerKey: 'resin-1', model },
  )
  const router = createPauseDriverRouter({
    allowedOrigins: [],
    limits: {
      connectTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      staleAfterMs: 5000,
      reconnectMinMs: 1000,
      reconnectMaxMs: 1000,
      maxMessageBytes: 65536,
    },
    clock: { monotonicNow: () => performance.now() },
    photonResinSessions: sessions,
    ...(qualified ? { photonResinQualifiedWrites: qualified } : {}),
    observe: () => true,
  })
  const signal = new AbortController().signal
  return { binding, router, signal }
}

const writes = (received: string[]) =>
  received.filter((entry) => /^(print\/(?!query)|video\/)/.test(entry))

const refusal = (error: unknown) =>
  error instanceof DriverRefusalError && !!error.userMessage

test('ships with no qualified write and refuses other models', () => {
  assert.deepEqual(PHOTON_RESIN_QUALIFIED_WRITES, [])
  const origin = 'http://127.0.0.1:18910'
  const config = (expected: string) => ({
    version: 8,
    allowedOrigins: [origin],
    printers: [],
    drivers: [
      {
        family: 'anycubic-resin',
        printerKey: 'resin-1',
        origin,
        pinSha256: 'a'.repeat(64),
        simulated: true,
        expect: { serial: 'FIXTURE-P1-MAX', model: expected },
      },
    ],
    limits: { staleAfterMs: 5000 },
  })
  parseCollectorConfig(config(model))
  for (const unsupported of [
    'Anycubic Photon Mono M7 Max',
    'Anycubic Photon Mono M7 Pro',
    'Anycubic Photon Mono 4 Ultra',
    'Anycubic Photon Mono M5s',
    'Anycubic Photon M3 Max',
  ]) {
    assert.throws(
      () => parseCollectorConfig(config(unsupported)),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(`No LAN session for ${unsupported}`),
      unsupported,
    )
  }
})

test('collects a read-only observation and withdraws it on a lost session', async (t) => {
  const { simulator, observations, unavailable } = await collect(t)
  const printer = PrinterState.parse(observations.at(-1)!.printer)
  assert.equal(printer.state, 'printing')
  assert.equal(printer.progress, 0.25)
  assert.equal(printer.currentLayer, 174)
  assert.equal(printer.filename, 'journey.pp1m')
  assert.deepEqual(printer.identity, { vendor: 'Anycubic', model })
  assert.deepEqual(printer.controls, [])
  assert.equal(printer.statusReason, 'anycubic-resin-simulated')
  assert.doesNotMatch(
    JSON.stringify(observations),
    new RegExp(fixture.credentials.password),
  )
  simulator.disconnect()
  await until(() => unavailable.length === 1)
  const seen = observations.length
  await until(() => observations.length > seen)
  assert.equal(observations.at(-1)!.epoch, 2)
  assert.deepEqual(writes(simulator.received()), [])
})

test('without qualification the stop is neither offered nor sent', async (t) => {
  const { simulator, sessions } = await collect(t)
  const { binding, router, signal } = control(sessions)
  assert.deepEqual(router.controls(binding), [])
  await router.prepare({ binding, signal })
  const request = { binding, signal, beforeSend: () => assert.fail('guard') }
  await assert.rejects(router.execute('cancel', {}, request), refusal)
  await assert.rejects(
    router.pauseOnce({ ...request, action: 'cancel' }),
    refusal,
  )
  await assert.rejects(router.pauseOnce(request), refusal)
  await router.closeAttempt(binding)
  assert.deepEqual(writes(simulator.received()), [])
})

test('a qualified stop is guarded, sent once and confirmed by the printer', async (t) => {
  const { simulator, sessions } = await collect(t)
  const { binding, router, signal } = control(sessions, testOnlyQualified)
  assert.deepEqual(router.controls(binding), ['cancel'])
  for (const action of ['pause', 'resume', 'start_print'] as const) {
    await router.prepare({ binding, signal })
    await assert.rejects(
      router.execute(
        action,
        { file: 'journey.pp1m' },
        { binding, signal, beforeSend: () => assert.fail('guard') },
      ),
      refusal,
    )
    await router.closeAttempt(binding)
  }

  await router.prepare({ binding, signal })
  await assert.rejects(
    router.execute('cancel', {}, { binding, signal, beforeSend: () => false }),
  )
  await router.closeAttempt(binding)
  assert.deepEqual(writes(simulator.received()), [])

  const { connectionGeneration } = await router.prepare({ binding, signal })
  const sentMono = performance.now()
  assert.deepEqual(
    await router.execute(
      'cancel',
      {},
      { binding, signal, beforeSend: () => true },
    ),
    { acknowledged: true },
  )
  const after = await router.waitForPaused({
    binding,
    signal,
    action: 'cancel',
    after: { connectionGeneration, sequence: 0, sentMono },
  })
  assert.equal(after?.printState, 'cancelled')
  await router.closeAttempt(binding)
  assert.deepEqual(writes(simulator.received()), ['print/stop'])
  assert.equal(simulator.printer().job, null)
})

test('a qualified stop without a current job is refused for state', async (t) => {
  const { simulator, sessions, binding: local } = await collect(t)
  const { binding, router, signal } = control(sessions, testOnlyQualified)
  const other = await sessions.get(local.printerKey)!.stopPrint('journey.pp1m')
  assert.equal(other.outcome, 'confirmed')
  assert.deepEqual(router.controls(binding), [])
  await router.prepare({ binding, signal })
  await assert.rejects(
    router.execute(
      'cancel',
      {},
      { binding, signal, beforeSend: () => assert.fail('guard') },
    ),
    (error: unknown) =>
      error instanceof DriverRefusalError && error.refusal === 'state',
  )
  await router.closeAttempt(binding)
  assert.deepEqual(writes(simulator.received()), ['print/stop'])
})

test('an unreported stop stays uncertain and is not resent', async (t) => {
  const { simulator, sessions } = await collect(t)
  simulator.unreported.add('print/stop')
  const { binding, router, signal } = control(sessions, testOnlyQualified)
  await router.prepare({ binding, signal })
  const request = { binding, signal, beforeSend: () => true }
  const notRefusal = (error: unknown) =>
    error instanceof Error && !(error instanceof DriverRefusalError)
  await assert.rejects(router.execute('cancel', {}, request), notRefusal)
  await assert.rejects(router.execute('cancel', {}, request), notRefusal)
  await router.closeAttempt(binding)
  assert.deepEqual(writes(simulator.received()), ['print/stop'])
})

test('camera capture is refused until qualified, then sent once per viewing', async (t) => {
  const { simulator, sessions } = await collect(t)
  const reasons: string[] = []
  const source = (qualified: boolean) => {
    const camera = createPhotonResinCameraSource({
      host: simulator.host,
      port: simulator.cameraPort,
      qualified,
      session: () => sessions.get('resin-1'),
      onRefused: (reason) => reasons.push(reason),
    })
    assert.equal(camera.kind, 'stock')
    return camera as Extract<typeof camera, { kind: 'stock' }>
  }
  const signal = new AbortController().signal
  const refused = source(false)
  await assert.rejects(refused.startCapture(signal), DriverRefusalError)
  await refused.stopCapture()
  assert.deepEqual(writes(simulator.received()), [])
  assert.match(reasons[0]!, /not qualified/)

  const camera = source(true)
  assert.equal(
    await camera.startCapture(signal),
    `http://127.0.0.1:${simulator.cameraPort}/flv`,
  )
  await assert.rejects(camera.startCapture(signal), /not sent again/)
  await camera.stopCapture()
  await camera.stopCapture()
  assert.deepEqual(writes(simulator.received()), [
    'video/startCapture',
    'video/stopCapture',
  ])
})
