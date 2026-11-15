import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFarmSnapshotSource,
  type RawPrinterObservation,
} from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import type {
  FarmSnapshotProvider,
  CompleteFarmSnapshot,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { parseCollectorConfig } from '../../packages/connector/src/config/creality.ts'
import { provisionCrealityPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'
function fixture(
  keys = ['a', 'b'],
  controlsFor?: Parameters<typeof createFarmSnapshotSource>[0]['controlsFor'],
) {
  const agent = randomUUID()
  const refs = keys.map((printerKey) => ({
    assignmentId: randomUUID(),
    agentId: agent,
    printerKey,
  }))
  let now = 100
  const source = createFarmSnapshotSource({
    assignmentRefs: refs,
    ...(controlsFor === undefined ? {} : { controlsFor }),
    nowMono: () => now,
  })
  const received: CompleteFarmSnapshot[] = []
  let unavailable = 0
  const binding: Parameters<FarmSnapshotProvider>[0]['binding'] = {
    v: 1,
    purpose: 'read-only-rtc',
    transport_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: agent,
    account_id: 'account',
    key_id: randomUUID(),
    browser_public_key: { kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA' },
    browser_thumbprint: 'test',
    connector_public_key_spki: 'test',
    connector_fingerprint: 'test',
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'test',
    browser_nonce: 'test',
    connector_nonce: 'test',
    issued_at: 0,
    expires_at: 10000,
    commands_enabled: false,
    offer_sha256: 'test',
    answer_sha256: 'test',
    browser_dtls: 'test',
    connector_dtls: 'test',
  }
  const controller = new AbortController()
  function open(deadlineMonoMs = 10000) {
    return source.open({
      binding,
      deadlineMonoMs,
      assignmentRefs: refs,
      signal: controller.signal,
      onComplete(value) {
        received.push(value)
      },
      onUnavailable() {
        unavailable++
      },
    })
  }
  return {
    source,
    refs,
    received,
    open,
    controller,
    binding,
    setNow(value: number) {
      now = value
    },
    unavailable: () => unavailable,
  }
}

const configFor = (port = 9999) => ({
  version: 4,
  printers: [],
  allowedOrigins: [],
  creality: { printers: [{ printerKey: 'creality', host: '127.0.0.1', port }] },
})

test('Creality is opt-in, defaults to port 9999 and rejects duplicate targets', () => {
  const config = configFor()
  assert.equal(parseCollectorConfig(config).version, 4)
  assert.throws(() => parseCollectorConfig({ ...config, version: 1 }))
  assert.throws(() =>
    parseCollectorConfig({
      ...config,
      creality: {
        printers: [config.creality.printers[0], config.creality.printers[0]],
      },
    }),
  )
  assert.throws(() => parseCollectorConfig(configFor(0)))
  const parsed = parseCollectorConfig({
    ...config,
    creality: { printers: [{ printerKey: 'creality', host: '127.0.0.1' }] },
  })
  assert.equal(parsed.version === 4 && parsed.creality.printers[0]?.port, 9999)
})

test(
  'Creality simulator enters RTC snapshots, expires and reconnects without commands',
  { timeout: 15000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'creality-collect-'))
    const simulator = await createCrealitySimulator({
      state: 1,
      printProgress: 42,
      nozzleTemp: 210,
      print: 'part.gcode',
      layer: 3,
    })
    const queue = new TelemetryQueue(join(directory, 'queue'), Date.now())
    const controller = new AbortController()
    const f = fixture(['creality'])
    const observations: RawPrinterObservation[] = []
    let notify: (() => void) | undefined
    let notifyUnavailable: (() => void) | undefined
    const first = new Promise<void>((resolve) => {
      notify = resolve
    })
    const expired = new Promise<void>((resolve) => {
      notifyUnavailable = resolve
    })
    const done = collectIntoQueue({
      config: parseCollectorConfig(configFor(simulator.port)),
      queue,
      signal: controller.signal,
      onDiagnostic() {},
      onRawObservation(value) {
        observations.push(value)
        f.setNow(performance.now())
        f.source.observe(value)
        notify?.()
      },
      onRawUnavailable(value) {
        f.source.invalidate(value)
        notifyUnavailable?.()
      },
    })
    try {
      await first
      f.open(performance.now() + 10000)
      assert.deepEqual(f.received[0]?.printers[0], {
        printerKey: 'creality',
        state: 'printing',
        progress: 0.42,
        filename: 'part.gcode',
        currentLayer: 3,
        toolTemperatureCelsius: 210,
        observedAt: observations[0]?.printer.observedAt,
      })
      assert.equal(f.binding.commands_enabled, false)
      assert.equal(observations[0]?.status, undefined)
      await expired
      assert.equal(f.unavailable(), 1)
      const count = f.received.length
      f.setNow(performance.now())
      f.open(performance.now() + 10000).close()
      assert.equal(f.received.length, count)
      const reconnected = new Promise<void>((resolve) => {
        notify = resolve
      })
      simulator.disconnect()
      await reconnected
      assert.ok(observations.at(-1)!.epoch > observations[0]!.epoch)
      f.open(performance.now() + 10000).close()
      assert.equal(f.received.at(-1)?.printers[0]?.progress, 0.42)
      assert.equal(f.received.length, count + 1)
      assert.deepEqual(simulator.received, [])
    } finally {
      controller.abort()
      await done
      f.source.close()
      queue.close()
      await simulator.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

test('Creality field provenance expires independently and cannot grant controls', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(['creality'], () => [])
  const stamps = { state: 100, progress: 100, toolTemperatureCelsius: 50 }
  try {
    f.source.observe({
      printerKey: 'creality',
      epoch: 1,
      printer: {
        printerKey: 'creality',
        state: 'printing',
        progress: 0.42,
        observedAt: 10,
        controls: ['pause'],
        toolTemperatureCelsius: 0,
      },
      receivedAtMonoMs: 100,
      fieldObservedAtMonoMs: { creality: stamps },
    })
    f.open()
    assert.deepEqual(f.received[0]?.printers[0]?.controls, [])
    assert.equal(f.received[0]?.validUntilMonoMs, 5050)
    stamps.toolTemperatureCelsius = 100
    f.setNow(5050)
    t.mock.timers.tick(4950)
    assert.equal(f.unavailable(), 1)
    assert.equal(f.received.length, 1)
    assert.throws(
      () =>
        f.source.observe({
          printerKey: 'creality',
          epoch: 2,
          printer: {
            printerKey: 'creality',
            state: 'printing',
            progress: 0.42,
            observedAt: 10,
          },
          receivedAtMonoMs: 5050,
          fieldObservedAtMonoMs: { creality: { state: 5051, progress: 5050 } },
        }),
      /Invalid observation time/,
    )
  } finally {
    f.source.close()
    t.mock.timers.reset()
  }
})

test('Creality snapshots advertise only the wired driver actions', () => {
  const binding = provisionCrealityPrinter(
    {
      assignment_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      printer_key: 'creality',
    },
    { printerKey: 'creality', host: '127.0.0.1', port: 9999 },
  )
  const router = createPauseDriverRouter({
    allowedOrigins: [],
    limits: {} as never,
    clock: { monotonicNow: () => 100 },
    observe: () => true,
  })
  const f = fixture(['creality'], (assignmentId) => {
    assert.equal(assignmentId, f.refs[0]?.assignmentId)
    return router.controls(binding)
  })
  try {
    f.source.observe({
      printerKey: 'creality',
      epoch: 1,
      printer: {
        printerKey: 'creality',
        state: 'printing',
        progress: 0.42,
        observedAt: 10,
        controls: ['emergency_stop'],
      },
      receivedAtMonoMs: 100,
      fieldObservedAtMonoMs: { creality: { state: 100, progress: 100 } },
    })
    f.open()
    assert.deepEqual(f.received[0]?.printers[0]?.controls, [
      'pause',
      'resume',
      'cancel',
      'set_temperature',
      'set_fan',
      'home',
      'set_light',
      'start_print',
    ])
  } finally {
    f.source.close()
  }
})
