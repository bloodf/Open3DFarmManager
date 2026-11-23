import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { parseCollectorConfig } from '../../packages/connector/src/config/anycubic.ts'
import { startAnycubicSimulator } from '../../packages/sim-tools/src/anycubic-simulator.ts'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'
import { createAnycubicLanClient } from '../../packages/connector/src/anycubic/index.ts'
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

const configFor = (port = 9883) => ({
  version: 5,
  printers: [],
  allowedOrigins: [],
  anycubic: {
    printers: [
      {
        printerKey: 'anycubic',
        host: '127.0.0.1',
        modelId: '20024',
        deviceId: 'SYNTHETIC',
        username: 'private-user',
        passwordFile: '/unused',
        port,
      },
    ],
  },
})

test('Anycubic is opt-in, defaults to port 9883 and rejects duplicate targets', () => {
  const config = configFor()
  assert.equal(parseCollectorConfig(config).version, 5)
  assert.throws(() => parseCollectorConfig({ ...config, version: 1 }))
  assert.throws(() =>
    parseCollectorConfig({
      ...config,
      anycubic: {
        printers: [config.anycubic.printers[0], config.anycubic.printers[0]],
      },
    }),
  )
  assert.throws(() => parseCollectorConfig(configFor(0)))
  const parsed = parseCollectorConfig({
    ...config,
    anycubic: {
      printers: [
        {
          printerKey: 'anycubic',
          host: '127.0.0.1',
          modelId: '20024',
          deviceId: 'SYNTHETIC',
          username: 'private-user',
          passwordFile: '/unused',
        },
      ],
    },
  })
  assert.equal(parsed.version === 5 && parsed.anycubic.printers[0]?.port, 9883)
})

test(
  'Anycubic simulator enters RTC snapshots, expires and reconnects without commands',
  { timeout: 15000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'anycubic-collect-'))
    const simulator = await startAnycubicSimulator({
      serial: '20024/SYNTHETIC',
    })
    const passwordFile = join(directory, 'password.json')
    writeFileSync(passwordFile, JSON.stringify('private-password'), {
      mode: 0o600,
    })
    const queue = new TelemetryQueue(join(directory, 'queue'), Date.now())
    const controller = new AbortController()
    const f = fixture(['anycubic'])
    const observations: RawPrinterObservation[] = []
    let notify: (() => void) | undefined
    let notifyUnavailable: (() => void) | undefined
    const first = new Promise<void>((resolve) => {
      notify = resolve
    })
    const expired = new Promise<void>((resolve) => {
      notifyUnavailable = resolve
    })
    const parsed = parseCollectorConfig(configFor(simulator.port))
    assert.equal(parsed.version, 5)
    if (parsed.version !== 5) throw Error('Expected Anycubic')
    const binding = { ...parsed.anycubic.printers[0]!, passwordFile }
    const diagnostics: unknown[] = []
    const done = collectIntoQueue({
      config: { ...parsed, anycubic: { printers: [binding] } },
      queue,
      onDiagnostic(value) {
        diagnostics.push(value)
      },
      signal: controller.signal,
      anycubicTransport(options) {
        return createAnycubicLanClient({
          ...options,
          caPem: simulator.syntheticTrust,
        })
      },
      onRawObservation(value) {
        observations.push(value)
        f.setNow(performance.now())
        f.source.observe(value)
        notify?.()
      },
      onRawUnavailable({ epoch }) {
        diagnostics.push({ epoch })
        f.source.invalidate({ printerKey: 'anycubic', epoch })
        notifyUnavailable?.()
      },
    })
    const publish = setInterval(
      () =>
        simulator.publishReport({
          data: {
            state: 'printing',
            progress: 42,
            curr_nozzle_temp: 210,
            filename: 'part.gcode',
            curr_layer: 3,
          },
        }),
      50,
    )
    try {
      await first
      f.open(performance.now() + 10000)
      assert.deepEqual(f.received[0]?.printers[0], {
        printerKey: 'anycubic',
        state: 'printing',
        progress: 0.42,
        filename: 'part.gcode',
        currentLayer: 3,
        toolTemperatureCelsius: 210,
        observedAt: observations[0]?.printer.observedAt,
      })
      assert.equal(f.binding.commands_enabled, false)
      assert.equal(observations[0]?.status, undefined)
      clearInterval(publish)
      await expired
      assert.equal(f.unavailable(), 1)
      const count = f.received.length
      f.setNow(performance.now())
      f.open(performance.now() + 10000).close()
      assert.equal(f.received.length, count)
      const reconnected = new Promise<void>((resolve) => {
        notify = resolve
      })
      await simulator.disconnectClients()
      const again = setInterval(
        () =>
          simulator.publishReport({
            data: { state: 'printing', progress: 42 },
          }),
        50,
      )
      await reconnected
      clearInterval(again)
      await reconnected
      assert.ok(observations.at(-1)!.epoch > observations[0]!.epoch)
      f.open(performance.now() + 10000).close()
      assert.equal(f.received.at(-1)?.printers[0]?.progress, 0.42)
      assert.equal(f.received.length, count + 1)
      assert.deepEqual(simulator.requests, [])
      assert.ok(
        !JSON.stringify({
          diagnostics,
          observations,
          snapshots: f.received,
        }).includes('private-password'),
      )
      assert.ok(!JSON.stringify(f.received).includes('private-user'))
    } finally {
      clearInterval(publish)
      controller.abort()
      await done
      f.source.close()
      queue.close()
      await simulator.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

test('Anycubic field provenance expires independently and cannot grant controls', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(['anycubic'])
  const stamps = { state: 100, progress: 100, toolTemperatureCelsius: 50 }
  try {
    f.source.observe({
      printerKey: 'anycubic',
      epoch: 1,
      printer: {
        printerKey: 'anycubic',
        state: 'printing',
        progress: 0.42,
        observedAt: 10,
        controls: ['pause'],
        toolTemperatureCelsius: 0,
      },
      receivedAtMonoMs: 100,
      fieldObservedAtMonoMs: { anycubic: stamps },
    })
    f.open()
    assert.equal(f.received[0]?.printers[0]?.controls, undefined)
    assert.equal(f.received[0]?.printers[0]?.toolTemperatureCelsius, 0)
    assert.equal(f.received[0]?.validUntilMonoMs, 5100)
    stamps.toolTemperatureCelsius = 100
    f.setNow(5050)
    t.mock.timers.tick(4950)
    assert.equal(f.unavailable(), 0)
    assert.equal(f.received.length, 2)
    assert.equal(f.received[1]?.printers[0]?.toolTemperatureCelsius, undefined)
    assert.equal(f.received[1]?.printers[0]?.controls, undefined)
    assert.equal(f.received[1]?.validUntilMonoMs, 5100)
    f.setNow(5100)
    t.mock.timers.tick(50)
    assert.equal(f.unavailable(), 1)
    assert.equal(f.received.length, 2)
    assert.throws(
      () =>
        f.source.observe({
          printerKey: 'anycubic',
          epoch: 2,
          printer: {
            printerKey: 'anycubic',
            state: 'printing',
            progress: 0.42,
            observedAt: 10,
          },
          receivedAtMonoMs: 5100,
          fieldObservedAtMonoMs: { anycubic: { state: 5101, progress: 5100 } },
        }),
      /Invalid observation time/,
    )
  } finally {
    f.source.close()
    t.mock.timers.reset()
  }
})
